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
            read_manifest
        ])
        .run(tauri::generate_context!())
        .expect("error while running EcoTrace");
}
