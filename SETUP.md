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

### 3. WebView2 Runtime (Windows only)
Already installed on Windows 10 (1803+) and Windows 11.  
If missing, download from: https://developer.microsoft.com/en-us/microsoft-edge/webview2/

### 4. Visual Studio C++ Build Tools
Required by Rust on Windows. Install **"Desktop development with C++"** workload from:  
https://visualstudio.microsoft.com/visual-cpp-build-tools/

> **Important:** Use the **MSVC** toolchain (default on Windows), not MinGW/GNU.  
> Run: `rustup default stable-x86_64-pc-windows-msvc`

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

# 4. Build a release .exe
npm run tauri build
```

The compiled installer will be at:
```
src-tauri/target/release/bundle/nsis/EcoTrace_0.1.0_x64-setup.exe
```

---

## Dependencies overview

| Layer      | Technology        | Managed by        |
|------------|-------------------|-------------------|
| Frontend   | TypeScript + Vite | `npm install`     |
| UI runtime | Tauri v2          | `npm install`     |
| Backend    | Rust              | `cargo` (auto)    |
| Packaging  | NSIS installer    | Tauri CLI (auto)  |

> There is no `requirements.txt` because this is not a Python project.  
> Node deps are in `package.json` and Rust deps are in `src-tauri/Cargo.toml` — both are installed automatically by the commands above.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `windres` / `windres failed` error | You're on the GNU toolchain. Run: `rustup default stable-x86_64-pc-windows-msvc` |
| `cc1.exe` error with spaces in path | Same as above — switch to MSVC toolchain |
| `WebView2 not found` | Install WebView2 runtime (link above) |
| `npm run tauri dev` hangs | Make sure port 5173 is free |
| GitHub push/pull fails (connection reset) | See SSH-over-443 fix in the repo's git config |
