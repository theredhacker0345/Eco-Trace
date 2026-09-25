// EcoTrace — Tauri backend
// Provides two lightweight Rust commands:
//   - read_file: reads any file at an absolute path and returns its contents
//   - walk_dir:  walks a directory tree and returns all .java and .kt file paths
//
// ADB execution is handled entirely from TypeScript via tauri-plugin-shell —
// no subprocess spawning on the Rust side.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use tauri::command;
use walkdir::WalkDir;

/// Read a file at the given absolute path and return its UTF-8 contents.
/// Called from TypeScript: invoke("read_file", { path: "C:\\..." })
#[command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("read_file error for '{}': {}", path, e))
}

/// Walk a directory tree rooted at `root` and return paths of all .java and
/// .kt files found. Returns absolute paths as strings.
/// Called from TypeScript: invoke("walk_dir", { root: "C:\\MyApp" })
#[command]
fn walk_dir(root: String) -> Result<Vec<String>, String> {
    let entries: Vec<String> = WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry.file_type().is_file()
                && entry
                    .path()
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext == "java" || ext == "kt")
                    .unwrap_or(false)
        })
        .map(|entry| entry.path().to_string_lossy().to_string())
        .collect();

    Ok(entries)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Register plugins — order: fs → shell → dialog
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        // Register our two Rust commands
        .invoke_handler(tauri::generate_handler![read_file, walk_dir])
        .run(tauri::generate_context!())
        .expect("error while running EcoTrace");
}
