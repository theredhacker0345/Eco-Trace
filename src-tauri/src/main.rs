// EcoTrace — Tauri entry point (main.rs)
// The actual application logic lives in lib.rs.
// This file exists only to satisfy the binary crate requirement.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ecotrace_lib::run();
}
