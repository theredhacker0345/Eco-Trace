# EcoTrace — Contributor Handoff TODO

> **For:** Next participant picking up the build  
> **Project:** EcoTrace — Android Energy Intelligence Platform  
> **Hackathon:** IBM Bob 2.0 Hackathon  
> **Platform:** Windows 10/11 only  
> **Full plan:** [`ecotrace-plan.md`](ecotrace-plan.md)  
> **Bob's energy rules:** [`.bob/rules-agent/energy.md`](.bob/rules-agent/energy.md)

---

> **Status:** Core build COMPLETE. All logic modules + UI built. Final polish phase remaining.

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

### Task 1.1 — Tauri 2.0 Scaffold ✅ DONE
- [x] `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`
- [x] `src-tauri/Cargo.toml`, `tauri.conf.json`, `build.rs`, `src/lib.rs`, `src/main.rs`
- [x] `src-tauri/capabilities/default.json` (correct Tauri 2.0 permission names)
- [x] `.cargo/config.toml` — CARGO_TARGET_DIR=C:/ecotrace_target (windres space-path fix)
- [x] Icons generated via `tauri icon`
- [x] **Verified:** `npm install` ✓. `cargo tauri build` → `ecotrace.exe` ✓

---

## Phase 2 — Core Logic Modules ✅ ALL DONE

### Task 2.1 — ADB Output Parser ✅ DONE
- [x] `src/parser/dumpsys.ts` — 7 interfaces + 8 parsers + `computeDelta()`

### Task 2.2 — 23-Pattern Static Analyzer ✅ DONE
- [x] `src/analyzer/static.ts` — all 23 patterns (Java + Kotlin), `buildCallGraph()`, `traceCallChain()`

### Task 2.3 — Settings Store ✅ DONE
- [x] `src/settings.ts` — `loadSettings()`, `saveSettings()`, `AppSettings`

### Task 2.4 — Grading Engine ✅ DONE
- [x] `src/grader/grade.ts` — `calculateGrade()`, `saveScan()`, `loadHistory()`, `computeScoreProgress()`

---

## Phase 3 — User Interface ✅ ALL DONE

### Task 3.1 — CSS Design System + 3-Panel Layout ✅ DONE
- [x] `src/ui/styles.css` — full dark theme, 3-panel grid, all component styles
- [x] `src/ui/app.html` — 3-panel layout + Settings modal
- [x] `index.html` — updated with full app shell (Tauri entry point)
- [x] `src/main.ts` — full wiring: Open Project, Analyze, Fix Station, ADB profiling, Settings, Export

### Task 3.2 — Exportable Report ✅ DONE
- [x] `src/ui/report.html` — 947-line self-contained report with demo mode

---

## Phase 4 — Repo Polish

### Task 4.1 — Bob Session Files ✅ DONE
- [x] `bob_sessions/` — 7 session JSON files (session-01 through session-07)
- [x] `.gitignore` — excludes `node_modules/`, `target/`, `dist/`

### Task 4.2 — Final Verification ⬅ NEXT STEP
- [ ] `tsc --noEmit` — 0 errors (currently passing ✓)
- [ ] `cargo tauri build` — reconfirm clean build
- [ ] Open app — all 3 panels visible at 1400×900
- [ ] Open Settings (⚙) — ADB path + API key fields appear; save/load works
- [ ] Point at a sample Android project folder — files appear in navigator
- [ ] Click Analyze — findings appear in Intelligence Feed
- [ ] Click a Critical finding — Fix Station shows causal chain + generated fix
- [ ] Export Report — `.html` file written and opens in browser
- [ ] Create `assets/README.md` placeholder
- [ ] Final commit + push

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
