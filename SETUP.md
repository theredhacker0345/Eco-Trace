# EcoTrace — Setup Guide

EcoTrace is a desktop app built with **Tauri v2** (Rust backend) and **TypeScript + Vite** (frontend). Follow these steps to build and run it locally on Windows.

---

## Prerequisites

Install these tools **in order** before anything else.

### 1. Node.js (v18 or newer)
Download from https://nodejs.org and install the LTS version.  
Verify: `node --version`

### 2. Rust toolchain
Install from https://rustup.rs — run the installer and choose the default options.  
After installation, open a **new terminal** and verify:
```
rustc --version
cargo --version
```

> **Important:** Use the **MSVC** toolchain (default on Windows), not MinGW/GNU.  
> Run: `rustup default stable-x86_64-pc-windows-msvc`

### 3. WebView2 Runtime (Windows only)
Already installed on Windows 10 (1803+) and Windows 11.  
If missing, download from: https://developer.microsoft.com/en-us/microsoft-edge/webview2/

### 4. Visual Studio C++ Build Tools
Required by Rust on Windows. Install the **"Desktop development with C++"** workload from:  
https://visualstudio.microsoft.com/visual-cpp-build-tools/

---

## Install & Run

```bash
# 1. Clone the repo
git clone https://github.com/theredhacker0345/Eco-Trace.git
cd Eco-Trace

# 2. Install Node dependencies
npm install

# 3. Run in development mode (hot-reload)
npm run tauri dev

# 4. Build a release .exe installer
npm run tauri build
```

The compiled installer will be at:
```
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/EcoTrace_0.1.0_x64-setup.exe
```

> The `x86_64-pc-windows-msvc` path segment comes from the target triple pinned in `.cargo/config.toml`. Do not switch to the GNU toolchain — it is not the configuration this project builds with.

Or download a pre-built installer from the [Releases page](https://github.com/theredhacker0345/Eco-Trace/releases).

---

## Dependencies overview

| Layer      | Technology        | Managed by                   |
|------------|-------------------|------------------------------|
| Frontend   | TypeScript + Vite | `npm install`                |
| UI runtime | Tauri v2          | `npm install`                |
| Backend    | Rust              | `cargo` (automatic)          |
| Packaging  | NSIS installer    | Tauri CLI (automatic)        |

> There is no `requirements.txt` because this is not a Python project.  
> Node deps are declared in `package.json` and Rust deps in `src-tauri/Cargo.toml` — both install automatically with the commands above.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `windres` / `windres failed` error | You are on the GNU toolchain. Run: `rustup default stable-x86_64-pc-windows-msvc` |
| `cc1.exe` error with spaces in path | Same fix — switch to MSVC toolchain |
| `WebView2 not found` | Install WebView2 runtime (link above) |
| `npm run tauri dev` hangs | Make sure port 5173 is free (`netstat -ano | findstr 5173`) |
| GitHub push/pull fails (connection reset) | SSH over port 443 is configured in `.ssh/config` — see repo git history |
