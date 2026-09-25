# EcoTrace Testing Guide

A step-by-step guide for running, testing, and building EcoTrace — a Tauri 2.0 + TypeScript desktop app that analyzes Android projects for battery drain anti-patterns.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Quick Start (Development)](#2-quick-start-development)
3. [Testing Static Analysis (No Device Needed)](#3-testing-static-analysis-no-device-needed)
4. [Testing Settings Panel](#4-testing-settings-panel)
5. [Testing Dynamic ADB Profiling (Device Required)](#5-testing-dynamic-adb-profiling-device-required)
6. [Testing Report Export](#6-testing-report-export)
7. [Building for Production](#7-building-for-production)
8. [Known Issues & Workarounds](#8-known-issues--workarounds)
9. [Test Fixtures](#9-test-fixtures)

---

## 1. Prerequisites

Make sure the following tools are installed and available on your `PATH` before you begin.

| Tool | Minimum Version | Purpose |
|------|----------------|---------|
| [Node.js](https://nodejs.org/) | 18+ | Frontend build tooling and npm |
| [Rust (stable)](https://rustup.rs/) | stable | Tauri backend compilation |
| [ADB](https://developer.android.com/tools/releases/platform-tools) | any recent | Dynamic device profiling (optional) |

### Verify your environment

```bash
node -v
# Expected: v18.x.x or higher

rustc --version
# Expected: rustc 1.xx.x (... stable)

adb version
# Expected: Android Debug Bridge version 1.x.x
```

### Windows-specific: use the MinGW GNU toolchain

EcoTrace must be compiled with the **MinGW GNU toolchain** on Windows (not MSVC). If you haven't set it up yet:

```bash
rustup default stable-x86_64-pc-windows-gnu
```

> **Why?** The MSVC linker causes `windres` path-with-spaces errors. The GNU toolchain avoids this entirely. See [Known Issues](#8-known-issues--workarounds) for details.

### Install links

- **Node.js**: https://nodejs.org/en/download
- **Rust / rustup**: https://rustup.rs/
- **Android Platform Tools (ADB)**: https://developer.android.com/tools/releases/platform-tools

---

## 2. Quick Start (Development)

Clone the repo and spin up the frontend dev server:

```bash
git clone https://github.com/theredhacker0345/Eco-Trace.git
cd Eco-Trace
npm install
npx vite   # opens at http://localhost:5173
```

The Vite dev server gives you instant hot-reload for UI changes without launching the full Tauri shell. Use this when working on frontend logic or testing static analysis features in a browser.

To run the full desktop app with Tauri (required for native file dialogs, settings persistence, and ADB):

```bash
cargo tauri dev
# or equivalently:
npx tauri dev
```

---

## 3. Testing Static Analysis (No Device Needed)

Static analysis works entirely from source files — no Android device required.

### Steps

1. **Open the app**
   - Browser (UI only): navigate to `http://localhost:5173` after running `npx vite`
   - Full desktop app: run `cargo tauri dev` and wait for the window to appear

2. **Open an Android project**
   - Click the **"Open Project"** button
   - Navigate to an Android project folder. Recommended options:
     - The included test fixture: `src/test-fixtures/SampleAndroidApp/` (see [Section 9](#9-test-fixtures))
     - Any real Android project, e.g. clone [Signal Android](https://github.com/signalapp/Signal-Android)

3. **Run analysis**
   - Click **"Analyze"**
   - Analysis runs locally — no network required

4. **Verify the results UI**
   After a moment you should see:
   - **Intelligence Feed** — streams findings in real time as they are detected
   - **File tree** — files containing anti-patterns are highlighted in red (Critical), orange (High), or yellow (Medium)
   - **Grade badge** — an A–F battery health grade updates once analysis completes

5. **Inspect a finding**
   - Click any **Critical** finding in the Intelligence Feed
   - The **Fix Station** panel should open on the right, showing:
     - A causal chain explaining why the pattern drains battery
     - Generated fix code you can apply directly

6. **Test clipboard copy**
   - In the Fix Station panel, click **"Copy"**
   - Paste into a text editor and verify the fix code was copied correctly

---

## 4. Testing Settings Panel

1. Click the **⚙ gear icon** in the bottom bar to open Settings

2. **ADB path**
   - Change the ADB path field to a custom value (e.g. `C:\platform-tools\adb.exe`)
   - Click **Save**

3. **Verify persistence**
   - Reload the app (press `F5` in the Tauri window, or restart `cargo tauri dev`)
   - Reopen Settings — the ADB path you entered should still be there
   - You can also inspect the settings file directly:
     ```
     %APPDATA%\ecotrace\settings.json
     ```

4. **API key masking**
   - Enter any value in the API key field (e.g. `test-api-key-1234`)
   - Click **Save**
   - The field should display a masked value (e.g. `••••••••••••1234`), not the raw key

---

## 5. Testing Dynamic ADB Profiling (Device Required)

This section requires a physical Android device or a running Android emulator.

### Prerequisites

- USB debugging enabled on your device:
  `Settings → Developer Options → USB Debugging → ON`
- Device connected and recognized:
  ```bash
  adb devices
  # Expected output includes your device serial, e.g.:
  # List of devices attached
  # emulator-5554   device
  ```
- ADB path configured in Settings ⚙ if `adb` is not on your system `PATH`

### Steps

1. Open EcoTrace and open an Android project (same as Section 3, steps 1–2)

2. Click **"▶ Start Profile"** in the vitals bar

3. **Use your Android app** for 2–5 minutes — navigate screens, trigger background syncs, or run the features you want to profile

4. Click **"■ Stop"** to end the profiling session

5. **Verify the results**
   - The **vitals bar** should now show a drain rate in **mAh/min**
   - The **grade badge** recalculates, incorporating both static findings and measured runtime drain
   - If battery drain exceeds expected thresholds, new dynamic findings may appear in the Intelligence Feed

---

## 6. Testing Report Export

1. Complete a static analysis (Section 3) or a profiling session (Section 5)

2. Click **"Export Report"**

3. Choose a save location in the file dialog — the report is saved as an `.html` file

4. Open the saved file in any web browser

5. **Verify the report contains:**
   - [ ] Grade badge (A–F) matching what was shown in the app
   - [ ] Full findings list with severity levels
   - [ ] Causal chain for at least one Critical finding
   - [ ] Timeline section (populated if ADB profiling was run)

> The exported report is fully self-contained HTML — no internet connection needed to view it.

---

## 7. Building for Production

> **Important:** EcoTrace uses a custom Cargo target directory to avoid the `windres` spaces-in-path bug on Windows. This is already configured in `.cargo/config.toml` — do not change it.

```bash
# Build the frontend assets first
npm run build

# Then build the Tauri app (exe + optional MSI installer)
cargo tauri build
# or equivalently:
npx tauri build
```

The compiled executable will be at:

```
C:\ecotrace_target\release\ecotrace.exe
```

The installer bundle (if WiX completes successfully) will be under:

```
src-tauri/target/release/bundle/
```

> If the MSI bundle step fails due to a WiX download issue, the `.exe` itself is still usable. See [Known Issues](#8-known-issues--workarounds).

---

## 8. Known Issues & Workarounds

### `windres` error — spaces in path

**Symptom:** Build fails with an error referencing `windres` or a path containing spaces.

**Fix:** EcoTrace's `.cargo/config.toml` sets:
```toml
[build]
target-dir = "C:/ecotrace_target"
```
This moves the Cargo output directory to a path without spaces. If you moved the repo to a folder with spaces in its path, this setting resolves the conflict.

---

### MSVC linker not found

**Symptom:** `error: linker 'link.exe' not found` or similar MSVC errors during `cargo build`.

**Fix:** Switch to the MinGW GNU toolchain:
```bash
rustup default stable-x86_64-pc-windows-gnu
```

---

### ADB not found

**Symptom:** Dynamic profiling fails with "ADB not found" or a similar error.

**Fix:** Set the full ADB path in Settings ⚙:
```
C:\platform-tools\adb.exe
```
Alternatively, add ADB's folder to your system `PATH` and restart the app.

---

### WiX MSI bundle fails

**Symptom:** `cargo tauri build` fails during the MSI packaging step with a network or download error.

**Fix:** This is a network issue downloading the WiX toolset installer — it does **not** affect the `.exe` build. The standalone executable at `C:\ecotrace_target\release\ecotrace.exe` is fully functional. Skip the MSI step for development purposes.

---

### TypeScript error on `NodeListOf`

**Symptom:** TypeScript compilation error such as `Type 'NodeListOf<...>' is not assignable to...`

**Fix:** Already resolved in `main.ts` by wrapping the query result with `Array.from()`:
```typescript
// Before (broken):
const items = document.querySelectorAll('.finding');

// After (fixed):
const items = Array.from(document.querySelectorAll('.finding'));
```
If you see this error again after pulling new code, check that `Array.from()` is used consistently on any `NodeListOf` or `HTMLCollectionOf` values.

---

## 9. Test Fixtures

EcoTrace ships with a small Android project pre-loaded with known anti-patterns so you can verify the analyzer works without cloning a real app.

**Location:** `src/test-fixtures/SampleAndroidApp/`

Point EcoTrace at this folder using **"Open Project"** and run **"Analyze"**. You should see exactly these findings:

| Finding ID | Severity | Anti-Pattern |
|-----------|----------|-------------|
| W01 | 🔴 Critical | Wake lock held indefinitely |
| N02 | 🟠 High | Network call on main thread / no batching |
| A01 | 🟠 High | Alarm manager using inexact repeating at high frequency |

If any of these findings are missing, or if unexpected errors appear, something is misconfigured — check the console output from `cargo tauri dev` for details.

---

*Questions or issues? Open an issue at [github.com/theredhacker0345/Eco-Trace](https://github.com/theredhacker0345/Eco-Trace).*
