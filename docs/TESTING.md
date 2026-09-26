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
10. [Performance Characteristics](#10-performance-characteristics)

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

### Windows-specific: use the MSVC toolchain

EcoTrace is compiled with the **MSVC toolchain** on Windows. This is the default
for `rustup` on Windows and is pinned explicitly in two places:

- `.cargo/config.toml` sets `[build] target = "x86_64-pc-windows-msvc"`
- `.github/workflows/build-windows.yml` and `.github/workflows/release.yml` both pin `toolchain: stable-x86_64-pc-windows-msvc`

If your default toolchain is not MSVC, switch back to it:

```bash
rustup default stable-x86_64-pc-windows-msvc
```

You also need the MSVC linker and C++ toolset — install the **"Desktop development with C++"** workload from the [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/). See [SETUP.md](../SETUP.md) for the full prerequisite list.

> **Why MSVC?** `windres` is a GNU-toolchain-only tool. Errors mentioning it mean you are accidentally building with MinGW/GNU, which is not the configuration this project targets. See [Known Issues](#8-known-issues--workarounds).

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
   - **Run log** (bottom panel) — records each phase of the scan, with timings
   - **Findings table** (centre) — every finding, grouped by severity
   - **File tree** (left) — files containing anti-patterns are highlighted in red (Critical), orange (High), or yellow (Medium)
   - **Grade badge** — an A–F battery health grade updates once analysis completes

5. **Verify selection is bidirectional**
   - Click a row in the **findings table** → the file tree highlights that file
   - Click that file in the **tree** → the table scopes to it and the scope
     selector switches to **Selected file**
   - Click the same file again → the scope returns to **All files**
   - The **Critical + High** scope filters out medium findings

6. **Inspect a finding**
   - Click any **Critical** finding
   - The **inspector** panel (right) shows the rule, the offending source, the
     traced causal chain, and a recommended fix with a **Copy** action

7. **Test clipboard copy**
   - In the inspector, click **"Copy"**
   - Paste into a text editor and verify the fix code was copied correctly

8. **Verify the UI stayed responsive during the scan**
   - Start an analysis on a large project and drag the panel splitters, sort the
     table, and scroll the run log *while it runs*. The analysis executes on a
     worker thread, so all of these stay live. On a slow machine the scan should
     be visibly reported as in progress rather than as a frozen window.

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

4. **Note on the API key**
   The key is stored as a `type="password"` field, so it is visually masked while
   you type, but it is written to `settings.json` as plaintext. That is a
   deliberate trade for a local single-user tool with no keychain dependency —
   if that is not acceptable for your deployment, the storage layer is
   `src/settings.ts` and the one function to change is `saveSettings`.

5. **Test the connection indicator**
   - With a key saved, click the Bob status chip in the header
   - The status should move from `Not configured` to a live state
   - Without a network connection it should report **Network error**, not a
     silent failure

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

2. Click **"▶ Start Profile"** in the toolbar above the findings table

3. **Use your Android app** for 2–5 minutes — navigate screens, trigger background syncs, or run the features you want to profile

4. Click **"■ Stop"** to end the profiling session

5. **Verify the results**
   - The **grade badge** recalculates, incorporating both static findings and measured runtime drain
   - The run log reports the drain rate together with **how it was measured**:
     - `from batterystats per-app mAh` — resolution 0.1 mAh, scoped to the
       packages named in the project's `AndroidManifest.xml`. This is the
       trustworthy figure.
     - `from charge level (±30 mAh resolution …)` — derived from the battery
       percentage against a nominal 3000 mAh cell. Coarse; profile for longer to
       tighten it. The report prints this caveat alongside the number.
     - `no usable measurement in this window` — the battery did not move enough
       to measure. Expected on a very short session.

---

## 6. Testing Report Export

1. Complete a static analysis (Section 3) or a profiling session (Section 5)

2. Pick a delivery path:

   | Action | Shortcut | Output |
   |--------|----------|--------|
   | **Export report** | `Ctrl+E` | Standalone `.html` file |
   | **PDF** (printer icon) | `Ctrl+Shift+E` | PDF via the print dialog |
   | **Open in browser** (launch icon) | `Ctrl+Shift+P` | HTML in the default browser |

3. **Verify the HTML report contains:**
   - [ ] A grade hero (ring, letter, score) matching what the app showed
   - [ ] A one-paragraph verdict, and a ranked "fix these first" plan
   - [ ] Score breakdown with all three weighted components, plus the grade table
   - [ ] At-a-glance metrics and a distribution-by-category breakdown
   - [ ] The deepest causal chain, with root → propagation → symptom roles
   - [ ] Every finding grouped by category, each with source, chain and fix
   - [ ] The **full 23-rule coverage matrix**, including rules that found nothing
   - [ ] Device profile (if one was recorded), including the drain provenance
   - [ ] Score timeline (when 2+ scans are in the history)
   - [ ] Method and limits, stating the known blind spots

4. **Verify the PDF**
   - Choose **Microsoft Print to PDF** or **Save as PDF**
   - Confirm the document is typeset for A4, that no card or table is split
     across a page, and that the footer carries the page number
   - Open the PDF and try to **search for a finding name** — the text must be
     selectable, which is the whole reason the print pipeline is used rather than
     a canvas rasteriser

5. **Verify robustness**
   - The report opens with no network access
   - A finding whose description contains `</script>` does not truncate the
     document (the exporter escapes `<` in the payload)
   - Opening `src/ui/report.html` directly, with no payload attached, shows an
     explicit "no scan data" notice rather than a plausible-looking fake scan

> The exported report is fully self-contained HTML — no internet connection needed
> to view it. The **Save as PDF** and **Expand all findings** buttons in the
> report header are for whoever opens the file; they are hidden when printing.

---

## 7. Building for Production

> **Important:** EcoTrace pins the Rust build target to the MSVC target triple in `.cargo/config.toml` (`[build] target = "x86_64-pc-windows-msvc"`). Because a target triple is set, Cargo nests its output under a target-triple subdirectory — this is why the build artifacts live in `src-tauri/target/x86_64-pc-windows-msvc/release/` rather than `src-tauri/target/release/`.

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
src-tauri/target/x86_64-pc-windows-msvc/release/ecotrace.exe
```

The installer bundle (if WiX completes successfully) will be under:

```
src-tauri/target/x86_64-pc-windows-msvc/release/bundle/
```

> If the MSI bundle step fails due to a WiX download issue, the `.exe` itself is still usable. See [Known Issues](#8-known-issues--workarounds).

---

## 8. Known Issues & Workarounds

### `windres` error

**Symptom:** Build fails with an error referencing `windres` or `cc1.exe`.

**Fix:** `windres` ships with the GNU (MinGW) toolchain, not MSVC. Seeing it means the build is running on the wrong toolchain. Switch back to MSVC:

```bash
rustup default stable-x86_64-pc-windows-msvc
```

This is the same target triple the repo pins in `.cargo/config.toml` (`[build] target = "x86_64-pc-windows-msvc"`) and in the release workflows. No custom `target-dir` is configured or required.

---

### MSVC linker not found

**Symptom:** `error: linker 'link.exe' not found`, `link.exe failed`, or "MSVC build tools not found" during `cargo build`.

**Fix:** The toolchain is correct; the C++ toolset is missing. Install the **"Desktop development with C++"** workload from the [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/), then open a **new** terminal so the updated `PATH` is picked up. Do not switch to the GNU toolchain — the project targets MSVC.

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

**Fix:** This is a network issue downloading the WiX toolset installer — it does **not** affect the `.exe` build. The standalone executable at `src-tauri/target/x86_64-pc-windows-msvc/release/ecotrace.exe` is fully functional. Skip the MSI step for development purposes.

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

## 10. Performance Characteristics

Three things decide whether EcoTrace feels light on a large project.

**The analysis is off the UI thread.** `src/analyzer/worker.ts` runs the 23
detector passes and the call-graph build in a Web Worker. On a project the size
of a real app that is over a second of solid CPU; on the UI thread it would
freeze the window, and a frozen window cannot report its own progress. If worker
construction fails, `src/analyzer/runner.ts` falls back to inline execution, so
the worst case is a slow scan rather than no scan. Verify: start an analysis and
drag the splitters while it runs.

**The directory walk prunes.** `walk_dir` never descends into `build/`, `.git/`,
`node_modules/`, `out/`, `target/`, `dist/`, `generated/`, `external/`,
`third_party/` or a dozen other generated or vendored trees, stops at 20 000
files, and returns paths in a deterministic order so two runs produce the same
table and the same report.

**Reads are bounded and rooted.** Single files over 2 MB are refused, and every
path is checked against the canonicalised project root after symlink
resolution — so neither `..` segments nor a symlink can read outside the project.

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
