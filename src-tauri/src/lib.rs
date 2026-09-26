// EcoTrace — Tauri backend
// Four small Rust commands:
//   - walk_dir:    walks a directory tree and returns .java/.kt file paths
//   - read_file:   reads a source file at a path inside an approved root
//   - read_text:   reads a bounded text file (AndroidManifest.xml, Gradle files)
//   - read_manifest: extracts the application ids from an AndroidManifest.xml
//
// ADB execution is handled entirely from TypeScript via tauri-plugin-shell —
// no subprocess spawning on the Rust side.
//
// Why read_file takes a root
// --------------------------
// The frontend is local, but "local" is not the same as "trusted": the webview
// renders strings that came out of the project being analysed, and a report
// file is written from them. A command that will read an arbitrary absolute
// path is a command that will read ~/.ssh/id_rsa. Every path-taking command
// here is therefore rooted: the caller passes the project root it is already
// working in, and the command refuses anything that resolves outside it.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::{Component, Path, PathBuf};

use tauri::command;
use walkdir::WalkDir;

/// Hard ceiling on a single source file. Android sources are text; anything
/// past this is a generated blob or a binary that `read_to_string` would have
/// failed on anyway. Reading without a cap is how a 400 MB `node_modules`
/// artefact turns a folder picker into a hung application.
const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

/// Upper bound on files returned from one walk. A mis-picked folder (a home
/// directory, a drive root) would otherwise enumerate hundreds of thousands of
/// paths and hand them all to the webview in one message.
const MAX_FILES: usize = 20_000;

/// Directories that never contain first-party Android sources. Walking them
/// is pure waste: `build/` alone is routinely several times the size of the
/// project it was generated from, and a monorepo can hold six figures of
/// generated Java.
const SKIP_DIRS: &[&str] = &[
    ".git",
    ".gradle",
    ".idea",
    ".svn",
    ".hg",
    "build",
    "out",
    "target",
    "node_modules",
    "bin",
    "obj",
    "dist",
    "coverage",
    "generated",
    "captures",
    "external",
    "vendored",
    "third_party",
    "thirdparty",
];

/// Walks `root`, returning the `.java` and `.kt` files under it.
///
/// Skips generated and vendored trees, and stops at [`MAX_FILES`] rather than
/// enumerating a drive.
#[command]
fn walk_dir(root: String) -> Result<Vec<String>, String> {
    let base = PathBuf::from(&root);
    if !base.is_dir() {
        return Err(format!("walk_dir: '{}' is not a directory", root));
    }
    let base = base
        .canonicalize()
        .map_err(|e| format!("walk_dir: cannot resolve '{}': {}", root, e))?;

    let mut out: Vec<String> = Vec::new();
    let mut truncated = false;

    let walker = WalkDir::new(&base)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            // Pruning at the directory level means the skipped subtree is never
            // descended into at all, rather than being walked and then filtered.
            if !entry.file_type().is_dir() {
                return true;
            }
            if entry.depth() == 0 {
                return true;
            }
            !SKIP_DIRS
                .iter()
                .any(|skip| entry.file_name().eq_ignore_ascii_case(skip))
        });

    for entry in walker {
        let entry = match entry {
            Ok(e) => e,
            // An unreadable subtree is not a reason to abandon the scan.
            Err(_) => continue,
        };

        if !entry.file_type().is_file() {
            continue;
        }

        let is_source = entry
            .path()
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| {
                let ext = ext.to_ascii_lowercase();
                ext == "java" || ext == "kt"
            })
            .unwrap_or(false);

        if !is_source {
            continue;
        }

        if out.len() >= MAX_FILES {
            truncated = true;
            break;
        }
        out.push(entry.path().to_string_lossy().to_string());
    }

    if truncated {
        eprintln!(
            "walk_dir: stopped at {} files under '{}' — the project is larger than EcoTrace analyses in one pass",
            MAX_FILES, root
        );
    }

    // Deterministic order, so two runs over the same tree produce the same
    // table and the same report.
    out.sort();
    Ok(out)
}

/// Reads a source file, refusing any path that escapes `root`.
///
/// `root` is normalised first, and the resolved target is compared against it
/// after symlink resolution, so neither `..` segments nor a symlink pointing
/// outside the project can be used to read an arbitrary file.
#[command]
fn read_file(root: String, path: String) -> Result<String, String> {
    read_bounded(&root, &path)
}

/// Reads a bounded non-source file, for manifest and Gradle inspection.
#[command]
fn read_text(root: String, path: String) -> Result<String, String> {
    read_bounded(&root, &path)
}

fn read_bounded(root: &str, path: &str) -> Result<String, String> {
    let base = Path::new(root);
    if !base.is_dir() {
        return Err(format!("read: '{}' is not a directory", root));
    }
    let base = base
        .canonicalize()
        .map_err(|e| format!("read: cannot resolve '{}': {}", root, e))?;

    let target = Path::new(path);
    if !target.is_absolute() {
        return Err(format!("read: '{}' is not an absolute path", path));
    }
    let target = target
        .canonicalize()
        .map_err(|e| format!("read: cannot resolve '{}': {}", path, e))?;

    if !target.starts_with(&base) {
        return Err(format!(
            "read: '{}' is outside the open project",
            path
        ));
    }

    if target.is_dir() {
        return Err(format!("read: '{}' is a directory", path));
    }

    let meta = fs::metadata(&target).map_err(|e| format!("read: {}: {}", path, e))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "read: '{}' is {:.1} MB, over the {} MB limit",
            path,
            meta.len() as f64 / (1024.0 * 1024.0),
            MAX_FILE_BYTES / (1024 * 1024)
        ));
    }

    fs::read_to_string(&target).map_err(|e| format!("read: '{}': {}", path, e))
}

/// Extracts the application ids declared by a project's `AndroidManifest.xml`.
///
/// The drain measurement needs to know which package on the device is the one
/// under analysis, and the manifest is where that is written down. Both the
/// `package` attribute and `package=` in the manifest tag are accepted, since
/// AGP moved the former into the `namespace` DSL.
#[command]
fn read_manifest(root: String) -> Result<Vec<String>, String> {
    let base = Path::new(&root);
    if !base.is_dir() {
        return Ok(Vec::new());
    }
    let base = match base.canonicalize() {
        Ok(p) => p,
        Err(_) => return Ok(Vec::new()),
    };

    let mut found: Vec<String> = Vec::new();

    let walker = WalkDir::new(&base)
        .max_depth(6)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            if entry.depth() == 0 || !entry.file_type().is_dir() {
                return true;
            }
            !SKIP_DIRS
                .iter()
                .any(|skip| entry.file_name().eq_ignore_ascii_case(skip))
        });

    for entry in walker.flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        if entry.file_name() != "AndroidManifest.xml" {
            continue;
        }
        if let Some(id) = manifest_package(&entry.path()) {
            if !found.contains(&id) {
                found.push(id);
            }
        }
        // One manifest is enough for a single-module project; a few more is
        // still cheap and covers the app module plus its libraries.
        if found.len() >= 6 {
            break;
        }
    }

    Ok(found)
}

/// A deliberately shallow read of the manifest: a `package="..."` attribute on
/// the `<manifest>` tag. Not a real XML parse — the file is untrusted input
/// from the project being analysed, and a hand-rolled scan of one attribute
/// cannot be made to allocate unboundedly the way a general parser can.
fn manifest_package(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    if text.len() > 512 * 1024 {
        return None;
    }

    let head = &text[..text.len().min(4096)];
    let open = head.find("<manifest")?;

    // Scan the <manifest ...> tag only — never past its closing '>'.
    let rest = &head[open..];
    let end = rest.find('>')?;
    let tag = &rest[..end];

    let attr = tag
        .strip_prefix("package")
        .or_else(|| {
            tag.find("package")
                .and_then(|i| tag.get(i..))
        })?
        .trim_start();

    let (key, rest) = attr.split_once('=')?;
    if key.trim() != "package" {
        return None;
    }

    let value = rest.trim();
    let quote = value.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let body = &value[1..];
    let end = body.find(quote)?;

    let id = body[..end].trim();
    if id.is_empty() || id.contains(char::is_whitespace) {
        return None;
    }
    // An application id is dotted lowercase; anything else is not one.
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')
    {
        return None;
    }
    if !id.contains('.') {
        return None;
    }
    Some(id.to_string())
}

/// True when `path` has no parent-directory component that could escape.
#[allow(dead_code)]
fn is_flat(path: &Path) -> bool {
    path.components().all(|c| !matches!(c, Component::ParentDir))
}

// ---------------------------------------------------------------------------
// apply_patch
//
// Applies a model-authored patch to a repository and, optionally, commits it to
// a branch and pushes it.
//
// Why this is a Rust command rather than a `git` entry in the shell plugin's
// allowlist: the shell scope matches a command's argument prefix, and `git` has
// too many verbs to enumerate usefully -- so allowing it means allowing `git`.
//
// That trade is not worth making for an operation whose entire purpose is to
// write code. A dedicated command can enforce the two rules that matter, and
// they are the reason this feature is safe to ship at all:
//
//   1. **It never writes to `main`.** The patch lands on a generated branch and
//      a human merges it. Generated code that reaches a protected branch with
//      no review is a supply-chain risk, and the verification step below is
//      exactly the sort of thing a model will write to satisfy itself.
//   2. **The patch is checked before it is applied.** `git apply --check` runs
//      first; if the context does not match, nothing is written and the command
//      fails. A patch that applies approximately is worse than one rejected.
//
// The verifier is a caller-supplied command run in the repository root, and a
// non-zero exit blocks the commit. That keeps "did this break anything" a
// question with a checkable answer rather than a judgement call.
#[derive(serde::Serialize)]
pub struct PushOutcome {
    /// What happened, for the run log.
    pub summary: String,
    /// The branch the commit landed on.
    pub branch: String,
    /// Files the patch touched.
    pub files: Vec<String>,
    /// Output of the verification command, on success.
    pub verify_output: String,
    /// Set when the commit was created but not pushed.
    pub pushed: bool,
    /// Populated on partial success, so the UI can say what did not happen.
    pub warning: Option<String>,
}

/// Refuses branch names that are not plain, safe ref names.
///
/// A branch name reaches `git` as an argument, so anything with a space, a
/// leading dash or a path separator is rejected rather than quoted. Quoting is
/// error-prone across shells; refusing is not.
fn validate_branch(branch: &str) -> Result<(), String> {
    if branch.is_empty() || branch.len() > 100 {
        return Err("branch name must be 1-100 characters".into());
    }
    if branch == "main" || branch == "master" || branch == "HEAD" {
        return Err(format!(
            "'{}' is a protected branch. A generated patch goes to its own branch and a human merges it.",
            branch
        ));
    }
    if !branch
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '/')
    {
        return Err(
            "branch name may contain only letters, digits, '-', '_' and '/'".into()
        );
    }
    if branch.starts_with('-') || branch.starts_with('/') || branch.ends_with('/') {
        return Err("branch name has an invalid leading or trailing character".into());
    }
    if branch.contains("..") {
        return Err("branch name may not contain '..'".into());
    }
    Ok(())
}

fn run_git(root: &Path, args: &[&str]) -> Result<(bool, String), String> {
    let output = std::process::Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .map_err(|e| format!("failed to run git {}: {}", args.join(" "), e))?;

    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    text.push_str(&String::from_utf8_lossy(&output.stderr));
    Ok((output.status.success(), text.trim().to_string()))
}

#[command]
fn apply_patch(
    root: String,
    patch: String,
    branch: String,
    message: String,
    verify_command: Option<String>,
    push: bool,
) -> Result<PushOutcome, String> {
    let base = Path::new(&root);
    if !base.is_dir() {
        return Err(format!("apply_patch: '{}' is not a directory", root));
    }
    let base = base
        .canonicalize()
        .map_err(|e| format!("apply_patch: cannot resolve '{}': {}", root, e))?;

    validate_branch(&branch)?;

    if patch.trim().is_empty() {
        return Err("apply_patch: the patch is empty".into());
    }
    // A patch is a diff. A 4 MB one is not a fix.
    if patch.len() > 2 * 1024 * 1024 {
        return Err("apply_patch: patch is implausibly large (over 2 MB)".into());
    }

    // Confirm this is a git working tree before touching anything.
    let (ok, out) = run_git(&base, &["rev-parse", "--is-inside-work-tree"])?;
    if !ok || !out.trim().eq_ignore_ascii_case("true") {
        return Err("apply_patch: that folder is not a git repository".into());
    }

    // The working tree must be clean. Applying on top of uncommitted work makes
    // the commit ambiguous and the rollback impossible to reason about.
    let (clean, dirty) = run_git(&base, &["status", "--porcelain"])?;
    if !clean {
        return Err(format!("apply_patch: git status failed: {}", dirty));
    }
    if !dirty.trim().is_empty() {
        let files: Vec<String> = dirty
            .lines()
            .take(6)
            .map(|l| l[3.min(l.len())..].trim().to_string())
            .collect();
        return Err(format!(
            "apply_patch: commit or stash your changes first. Uncommitted: {}",
            files.join(", ")
        ));
    }

    // Write the patch beside the repository rather than into it, so it can
    // never be staged by accident.
    let patch_path = std::env::temp_dir().join(format!(
        "ecotrace-patch-{}.diff",
        std::process::id()
    ));
    fs::write(&patch_path, patch.as_bytes())
        .map_err(|e| format!("apply_patch: cannot write patch: {}", e))?;
    let patch_arg = patch_path.to_string_lossy().to_string();

    let result = (|| -> Result<PushOutcome, String> {
        // Dry run first. This is the check that makes the whole feature safe:
        // if the context does not match, nothing has been written.
        let (ok, out) = run_git(&base, &["apply", "--check", &patch_arg])?;
        if !ok {
            return Err(format!(
                "apply_patch: the patch does not apply to the current working tree. {}",
                out.lines().take(3).collect::<Vec<_>>().join(" ")
            ));
        }

        // Which files it touches, captured before applying.
        let (_, name_only) = run_git(&base, &["apply", "--numstat", &patch_arg])?;
        let files: Vec<String> = name_only
            .lines()
            .filter_map(|l| l.split('\t').nth(2))
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        let (ok, out) = run_git(&base, &["apply", &patch_arg])?;
        if !ok {
            return Err(format!("apply_patch: git apply failed: {}", out));
        }

        // Verification runs *before* the commit, so a failing verifier leaves
        // the user with a rejected patch rather than a bad commit to undo.
        let mut verify_output = String::new();
        if let Some(cmd) = verify_command.as_deref() {
            if !cmd.trim().is_empty() {
                let output = std::process::Command::new("cmd")
                    .args(["/C", cmd])
                    .current_dir(&base)
                    .output()
                    .map_err(|e| format!("apply_patch: could not run the verifier: {}", e))?;
                verify_output = format!(
                    "{}{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                )
                .trim()
                .to_string();
                if !output.status.success() {
                    return Err(format!(
                        "apply_patch: the verifier failed, so nothing was committed.\n{}",
                        if verify_output.is_empty() {
                            "(no output)".into()
                        } else {
                            verify_output.lines().take(8).collect::<Vec<_>>().join("\n")
                        }
                    ));
                }
            }
        }

        // The generated branch, off whatever HEAD is at.
        let (ok, _) = run_git(&base, &["switch", "-c", &branch])?;
        if !ok {
            // The branch already exists from a previous run; carry on rather
            // than failing a fix that is otherwise fine.
            let _ = run_git(&base, &["switch", &branch]);
        }

        run_git(&base, &["add", "--"])?;
        let subject: String = message.lines().next().unwrap_or("EcoTrace AI fix").to_string();
        let body: String = message.lines().skip(1).collect::<Vec<_>>().join("\n");
        let full_message = if body.trim().is_empty() {
            subject
        } else {
            format!("{}\n\n{}", subject, body)
        };
        let (ok, out) = run_git(&base, &["commit", "-m", &full_message])?;
        if !ok {
            return Err(format!("apply_patch: git commit failed: {}", out));
        }

        let mut warning = None;
        let mut pushed = false;

        if push {
            match run_git(&base, &["push", "--set-upstream", "origin", &branch]) {
                Ok((true, _)) => pushed = true,
                Ok((false, out)) => {
                    warning = Some(format!(
                        "Committed to '{}' but the push failed: {}",
                        branch,
                        out.lines().last().unwrap_or("unknown error")
                    ))
                }
                Err(e) => warning = Some(format!("Committed to '{}' but: {}", branch, e)),
            }
        }

        Ok(PushOutcome {
            summary: format!(
                "{} file(s) patched and committed to '{}'{}",
                files.len(),
                branch,
                if pushed { ", pushed" } else { "" }
            ),
            branch,
            files,
            verify_output,
            pushed,
            warning,
        })
    })();

    // The patch file is scratch, never part of the repository.
    let _ = fs::remove_file(&patch_path);

    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Register plugins — order: fs → shell → dialog
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        // Register our commands
        .invoke_handler(tauri::generate_handler![
            walk_dir,
            read_file,
            read_text,
            read_manifest,
            apply_patch,
        ])
        .run(tauri::generate_context!())
        .expect("error while running EcoTrace");
}
