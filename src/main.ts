// EcoTrace — app entry point
// This file is the Vite/TypeScript entry loaded by index.html.
// Full UI wiring is implemented in Sub-Task 6.
// For now it just confirms the Tauri bridge is ready.

import { invoke } from "@tauri-apps/api/core";

// Confirm the Rust backend is reachable on startup
invoke<string[]>("walk_dir", { root: "." })
  .then(() => console.log("[EcoTrace] Tauri bridge ready"))
  .catch((e) => console.error("[EcoTrace] Bridge error:", e));
