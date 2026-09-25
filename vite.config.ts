import { defineConfig } from "vite";

export default defineConfig({
  // Tauri dev server runs on a fixed port; disable host detection
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // Ignore Rust source so Vite doesn't restart on Cargo changes
      ignored: ["**/src-tauri/**"],
    },
  },
  build: {
    // Tauri expects the output in dist/
    outDir: "dist",
    // Produce ES modules so Tauri's WebView can consume them
    target: ["chrome105"],
    // Don't minify for debugging; switch to true for release
    minify: false,
    sourcemap: true,
  },
});
