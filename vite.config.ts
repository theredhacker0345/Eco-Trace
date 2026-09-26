import { defineConfig } from "vite";

export default defineConfig({
  // Tauri's dev server runs on a fixed port; disable host detection.
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      // Ignore Rust source so Vite does not restart on Cargo changes.
      ignored: ["**/src-tauri/**"],
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        // The Carbon Sass modules predate Dart Sass' current global built-ins,
        // so the legacy namespaced functions are still in use upstream.
        api: "modern-compiler",
        silenceDeprecations: ["if-function", "global-builtin", "import"],
        quietDeps: true,
      },
    },
  },
  build: {
    // Tauri expects the output in dist/.
    outDir: "dist",
    // Produce ES modules so Tauri's WebView can consume them.
    target: ["chrome105"],
    // Minify for release. Sourcemaps stay on so stack traces remain readable.
    minify: "esbuild",
    sourcemap: true,
    // report.html is imported by main.ts via `?raw`, so it is inlined as a
    // string and does not need to exist as a separate dist asset.
    assetsInlineLimit: 8192,
  },
});
