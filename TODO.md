# EcoTrace — Contributor Handoff TODO

> **For:** Next participant picking up the build  
> **Project:** EcoTrace — Android Energy Intelligence Platform  
> **Hackathon:** IBM Bob 2.0 Hackathon  
> **Platform:** Windows 10/11 only  
> **Full plan:** [`ecotrace-plan.md`](ecotrace-plan.md)  
> **Bob's energy rules:** [`.bob/rules-agent/energy.md`](.bob/rules-agent/energy.md)

---

## How to Use This File

Work through tasks **in order**. Each task is self-contained but feeds into the next.  
Before starting any task, read the matching sub-task in [`ecotrace-plan.md`](ecotrace-plan.md) — it has the full intent, expected outcomes, and relevant context.  
When you finish a task here, mark it `[x]` and also update the **Status** in the plan file to `[x] done`.

Use **Bob (IBM Bob 2.0)** to implement. Switch to Agent mode for all coding tasks.

---

## Prerequisites — Do These First

- [ ] Install [Node.js 18+](https://nodejs.org)
- [ ] Install [Rust + Cargo](https://rustup.rs) (stable toolchain)
- [ ] Install [Tauri CLI v2](https://tauri.app/start/prerequisites/): `cargo install tauri-cli --version "^2.0"`
- [ ] Install [ADB](https://developer.android.com/tools/releases/platform-tools) and note its full path (e.g. `C:\platform-tools\adb.exe`)
- [ ] Clone repo and confirm you are inside `Eco-Trace\` as the working directory

---

## Phase 1 — Project Foundation

### Task 1.1 — Tauri 2.0 Scaffold *(Sub-Task 1 in plan)*
- [ ] Create `package.json` with all deps: `@tauri-apps/api`, `@tauri-apps/plugin-fs`, `@tauri-apps/plugin-shell`, `@tauri-apps/plugin-dialog`, vite, typescript
- [ ] Create `tsconfig.json` (strict ESNext)
- [ ] Create `vite.config.ts`
- [ ] Create `index.html` (Tauri entry point)
- [ ] Create `src-tauri/Cargo.toml` with `tauri 2.0`, `tauri-plugin-fs`, `tauri-plugin-shell`, `tauri-plugin-dialog`
- [ ] Create `src-tauri/tauri.conf.json` (Tauri 2.0 schema: `"app".identifier`, `"app".windows`, `"build".frontendDist`)
- [ ] Create `src-tauri/build.rs`
- [ ] Create `src-tauri/src/main.rs` — register fs + shell + dialog plugins; implement `read_file` and `walk_dir` Rust commands
- [ ] Create `src-tauri/capabilities/default.json` — permissions: `fs:allow-read-text-file`, `fs:allow-read-dir`, `fs:allow-write-text-file`, `shell:allow-execute`, `path:allow-app-data-dir`, `dialog:allow-open`
- [ ] Create `src/main.ts` (empty entry for now)
- [ ] **Verify:** `npm install` completes. `cargo tauri build` compiles without errors.

---

## Phase 2 — Core Logic Modules

### Task 2.1 — ADB Output Parser *(Sub-Task 3 in plan)*
- [ ] Create `src/parser/dumpsys.ts`
- [ ] Define interfaces: `DumpsysResult`, `PerUidEntry`, `WakelockEntry`, `NetworkEntry`, `DozeViolation`, `CpuWakeup`, `DumpsysDelta`
- [ ] Implement section splitter (raw string → labeled sections)
- [ ] Implement `parseEstimatedPowerUse()` — mAh per component
- [ ] Implement `parsePerUidData()` — per-app CPU time + wakelock duration
- [ ] Implement `parseWakelockHistory()` — wakelock name, package, hold duration
- [ ] Implement `parseNetworkStats()` — bytes rx/tx per UID
- [ ] Implement `parseDozeViolations()` — idle mode exits
- [ ] Implement `parseCpuWakeups()` — wakeup alarms per package per hour
- [ ] Implement `computeDelta(before, after)` — drain rate = mAh delta / elapsed minutes
- [ ] Export `parseDumpsys(raw: string): DumpsysResult` as the public API

### Task 2.2 — 23-Pattern Static Analyzer *(Sub-Task 4 in plan)*
> Read `.bob/rules-agent/energy.md` first — all 23 patterns with Java + Kotlin detection signals are defined there.
- [ ] Create `src/analyzer/static.ts`
- [ ] Define interfaces: `FileContent`, `Finding`, `CallGraph`, `CallEdge`, `ChainNode`
- [ ] Define `Severity` and `Category` enums
- [ ] Implement Wakefulness detectors W01–W06 (Java + Kotlin regex for each)
- [ ] Implement Network detectors N01–N06 (Java + Kotlin regex for each)
- [ ] Implement Location & Sensor detectors L01–L05 (Java + Kotlin regex for each)
- [ ] Implement Lifecycle & Architecture detectors A01–A06 (Java + Kotlin regex for each)
- [ ] Implement `buildCallGraph(files)` — method definitions + call site adjacency map
- [ ] Implement `analyzeProject(files)` — run all 23 detectors; return `Finding[]`
- [ ] Implement `traceCallChain(finding, callGraph)` — walk back 6 hops max

### Task 2.3 — Settings Store *(Sub-Task 4b in plan)*
- [ ] Create `src/settings.ts`
- [ ] Define `AppSettings` interface: `{ adbPath: string; apiKey: string }`
- [ ] Implement `loadSettings(): Promise<AppSettings>` — reads `%APPDATA%\ecotrace\settings.json`; returns defaults if missing
- [ ] Implement `saveSettings(s): Promise<void>` — writes JSON to settings.json
- [ ] Export `getDefaultSettings()` returning `{ adbPath: "adb", apiKey: "" }`

### Task 2.4 — Grading Engine + Timeline Storage *(Sub-Task 5 in plan)*
- [ ] Create `src/grader/grade.ts`
- [ ] Define interfaces: `GradeResult`, `ScanRecord`, `ProgressPoint`
- [ ] Implement `scoreDrainRate()`, `scoreCriticalCount()`, `scoreHighCount()` (0–100 sub-scores)
- [ ] Implement `calculateGrade(findings, delta)` — weighted formula (40/35/25), letter grade A+ to F
- [ ] Hard threshold: drain ≥ 3.0 mAh/min OR ≥ 5 critical = F regardless of score
- [ ] Implement `saveScan()` — appends to `%APPDATA%\ecotrace\history.json`
- [ ] Implement `loadHistory()` — returns sorted array (newest first); empty array if file missing
- [ ] Implement `computeScoreProgress()` — per-scan score deltas for timeline sparkline

---

## Phase 3 — User Interface

### Task 3.1 — CSS Design System + 3-Panel Layout *(Sub-Task 6 in plan)*
- [ ] Create `src/ui/styles.css`
  - CSS variables: `--bg: #0d0d0d`, `--accent: #00ff88`, severity colors
  - `.panel` grid: `240px | 1fr | 380px`
  - `.file-tree`, `.intelligence-feed`, `.fix-station` styles
  - `.vitals-bar` fixed bottom bar
  - `.grade-badge` color variants (A+ to F)
  - `.settings-modal` centered overlay + dark card
- [ ] Create `src/ui/app.html` — full 3-panel HTML structure with Settings modal `<div>`
- [ ] Update `src/main.ts` — full wiring:
  - Folder picker → `walk_dir` → populate Project Navigator
  - Analyze button → static analyzer → stream to Intelligence Feed
  - Finding click → populate Fix Station with finding + causal chain
  - **Gear icon (⚙) → open Settings modal**
  - Settings Save → `saveSettings()`; Cancel → close modal
  - ADB Start/Stop Profile → execute `dumpsys` via `tauri-plugin-shell` using `settings.adbPath`

### Task 3.2 — Exportable Report *(Sub-Task 7 in plan)*
- [ ] Create `src/ui/report.html` — self-contained, all CSS inline
- [ ] Report sections: header (grade badge), summary table, findings cards, causal chains, timeline
- [ ] Data injection: `<script id="scan-data" type="application/json">` slot
- [ ] Wire "Export Report" button in `app.html`/`main.ts` → generates + writes file via `writeTextFile`

---

## Phase 4 — Repo Polish

### Task 4.1 — Bob Session Files + Assets *(Sub-Task 8 in plan)*
- [ ] Create `bob_sessions/session-01-architecture.json` through `session-07-fix-engine.json`
  - Each: `{ "session": "01", "title": "...", "model": "IBM Bob 2.0", "built": [...], "timestamp": "..." }`
- [ ] Create `assets/README.md` — placeholder noting where demo.gif goes
- [ ] Create `.gitignore` — exclude `node_modules/`, `target/`, `dist/`

### Task 4.2 — Final Verification
- [ ] `npm install` — clean install, no errors
- [ ] `cargo tauri build` — compiles to `.exe`, no warnings
- [ ] Open app — all 3 panels visible at 1400×900
- [ ] Open Settings (⚙) — ADB path + API key fields appear; save/load works
- [ ] Point at a sample Android project folder — files appear in navigator
- [ ] Click Analyze — findings appear in Intelligence Feed
- [ ] Click a Critical finding — Fix Station shows causal chain
- [ ] Export Report — `.html` file written and opens in browser

---

## Key Files Reference

| File | Purpose |
|---|---|
| [`ecotrace-plan.md`](ecotrace-plan.md) | Full implementation plan — read before each task |
| [`.bob/rules-agent/energy.md`](.bob/rules-agent/energy.md) | Bob's 23-pattern detection rules (Java + Kotlin) |
| `src-tauri/src/main.rs` | Rust: `read_file`, `walk_dir` commands + plugin registration |
| `src-tauri/capabilities/default.json` | Tauri 2.0 permissions |
| `src/parser/dumpsys.ts` | ADB output → structured JSON |
| `src/analyzer/static.ts` | 23-pattern detector + call graph |
| `src/settings.ts` | ADB path + API key persistence |
| `src/grader/grade.ts` | Scoring engine + history storage |
| `src/ui/app.html` | Main 3-panel layout + Settings modal |
| `src/ui/styles.css` | Full dark theme design system |
| `src/ui/report.html` | Standalone exportable report |
| `src/main.ts` | Full app wiring (UI ↔ backend) |

---

## Critical Constraints (Do Not Deviate)

1. **Windows-only** — no macOS/Linux conditionals anywhere
2. **ADB calls**: always use `settings.adbPath` at call time — never hardcode `"adb"`
3. **ADB subprocess**: use `tauri-plugin-shell` — NOT `std::process::Command`
4. **Tauri 2.0 config**: `tauri.conf.json` uses `"app"` key (not `"tauri"`) for identifier and windows
5. **Type ownership**: `Finding` lives in `static.ts`, `DumpsysDelta` in `dumpsys.ts`, `AppSettings` in `settings.ts` — all re-exported, never duplicated
6. **API key**: stored only in `settings.json` — no actual API call made in this build
7. **Plugin order in `main.rs`**: register `fs → shell → dialog` before `.invoke_handler()`

---

## Grading Reference

| Grade | Drain Rate | Critical | High |
|---|---|---|---|
| A+ | < 0.5 mAh/min | 0 | 0 |
| A | < 0.8 mAh/min | 0 | ≤ 2 |
| B | < 1.2 mAh/min | ≤ 1 | any |
| C | < 2.0 mAh/min | ≤ 3 | any |
| D | < 3.0 mAh/min | any | any |
| F | ≥ 3.0 mAh/min **OR** ≥ 5 critical | — | — |

Weight formula: `score = drainScore × 0.40 + criticalScore × 0.35 + highScore × 0.25`

---

## Team

| Member | Contact |
|---|---|
| Ubaid ur Rehman | [@theredhacker0345](https://lablab.ai/u/@theredhacker0345) |
| Tayyaba Amin | [@tayyaba_amin818](https://lablab.ai/u/@tayyaba_amin818) |
| Sawaira Fareed | [@Sawaira_](https://lablab.ai/u/@Sawaira_) |
