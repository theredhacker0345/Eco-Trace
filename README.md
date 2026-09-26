<div align="center">

<img src="src-tauri/icons/app-icon.png" width="120" alt="EcoTrace Logo" />

# EcoTrace

### Android Energy Intelligence Platform

> **The first tool that does not just find battery drain -- it finds *why* your code architecture causes it.**

<br/>

[![Built with IBM Bob 2.0](https://img.shields.io/badge/Built%20with-IBM%20Bob%202.0-0f62fe?style=for-the-badge&logo=ibm&logoColor=white)](https://bob.ibm.com)
[![Tauri 2.0](https://img.shields.io/badge/Tauri-2.0-24C8D8?style=for-the-badge&logo=tauri&logoColor=white)](https://tauri.app)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![Rust](https://img.shields.io/badge/Rust-stable-CE422B?style=for-the-badge&logo=rust&logoColor=white)](https://www.rust-lang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e?style=for-the-badge)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/Platform-Windows%2010%2F11-0078d4?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/theredhacker0345/Eco-Trace/releases)

<br/>

[![IBM Bob 2.0 Hackathon](https://img.shields.io/badge/IBM%20Bob%202.0%20Hackathon-September%202026-0f62fe?style=flat-square&logo=ibm)](https://lablab.ai/ai-hackathons/ibm-bob-2-hackathon)
[![Team](https://img.shields.io/badge/Team-Code%20%26%20Chaos-7c3aed?style=flat-square)](https://lablab.ai/u/@theredhacker0345)

<br/>

![EcoTrace Demo](assets/demo.gif)

<br/>

[Download EXE](https://github.com/theredhacker0345/Eco-Trace/releases) &nbsp;|&nbsp;
[Build from Source](#build-from-source) &nbsp;|&nbsp;
[How It Works](#how-it-works) &nbsp;|&nbsp;
[The Report](#the-report) &nbsp;|&nbsp;
[Setup Guide](SETUP.md)

</div>

<br/>

---

## The Problem

Every Android battery tool on the market -- Battery Historian, Android Profiler, even Google's own tools -- tells you **what** is draining your battery.

**None of them tell you why.**

"Why" requires understanding how a single architectural decision in `MainActivity.java` propagates through six layers of your codebase to cause a GPS drain reported in `dumpsys`. That is not a pattern matching problem. That is a reasoning problem -- and only one tool on the planet can solve it at the repository scale.

```
MainActivity.onCreate()
  -> AlarmManager.setRepeating()          <- wakes device every 15 min
    -> SyncService.onStartCommand()
      -> UserRepository.sync()
        -> NetworkManager.fetchUserData() <- no timeout set
          -> LocationService.getLastKnown()
            -> GPS.requestSingleUpdate()  <- FINE accuracy, 3x battery cost
```

No linter sees this chain. No retrieval-based AI sees this chain.

EcoTrace traces it in **two tiers**, and this distinction matters:

| Tier | Runs | Needs a key? | What it contributes |
|---|---|:---:|---|
| **Local call-graph tracer** | Always, on every scan | No | Builds a real cross-file call graph from the sources and walks back from each finding to the lifecycle entry point that put it there. Works offline, costs nothing, is reproducible. |
| **IBM Bob 2.0** | Only if you paste a key | Yes | Holds the whole repository in one reasoning pass, so it can revise a severity, correct a description, and write a fix written *against that specific chain* — including for defects the local pass attributed to the wrong method. |

The local tracer is what makes the feature work for everyone. Bob is what makes
it sharper. A tool that only works when you hand it an API key is a demo, so the
chain, the grade, the history and the whole report are all produced with Bob
switched off.

---

## Why IBM Bob 2.0 -- and Why Nothing Else Can Do This

| Tool | How it reads your codebase | Traces multi-file call chains? |
|---|---|:---:|
| Android Profiler | Runtime only, no source analysis | No |
| SonarQube / Lint | Single-file pattern matching | No |
| GPT-4o / Gemini | Chunked context, loses cross-file links at scale | Partially |
| Cursor / Copilot | Embedding retrieval, misses non-obvious dependencies | Partially |
| **EcoTrace (local)** | Builds a real call graph from every indexed source | **Yes, offline** |
| **EcoTrace + IBM Bob 2.0** | Full repository as a first-class primitive, plus the local graph | **Yes, and writes a fix per chain** |

The local tracer is what no linter on the table does: it is a genuine call
graph over the whole project, not a per-file scan. Bob 2.0 adds the layer a
call graph cannot reach — reasoning about whether the traced path is the one
that actually matters, and rewriting the fix for that path.

---

## How It Works

### 1. Static Analysis -- 23 Energy Anti-Patterns

EcoTrace scans every `.java` and `.kt` file in your Android project for 23 known energy anti-patterns across four categories:

<details>
<summary><strong>Wakefulness Violations (6 patterns)</strong></summary>

- Unclosed WakeLock -- `acquire()` without `release()`
- WakeLock held across IPC boundary
- WakeLock in AsyncTask (leaks on screen rotation)
- PARTIAL_WAKE_LOCK in background service
- WakeLock acquired in BroadcastReceiver without `goAsync()`
- Nested WakeLock acquisition (double-acquire bug)

</details>

<details>
<summary><strong>Network Inefficiency (6 patterns)</strong></summary>

- Network call inside loop or `postDelayed` chain
- No connection timeout set
- No read timeout set
- HTTP instead of HTTPS (forces TLS renegotiation)
- Synchronous network on main thread
- Polling pattern with no FCM or WebSocket fallback

</details>

<details>
<summary><strong>Location & Sensor Abuse (5 patterns)</strong></summary>

- GPS update interval under 30 seconds
- FINE location when COARSE is sufficient
- Sensor listener not unregistered in `onPause`/`onStop`
- Full-rate accelerometer for step counting (use `TYPE_STEP_COUNTER`)
- Geofencing via polling instead of the Geofence API

</details>

<details>
<summary><strong>Lifecycle & Architecture (6 patterns)</strong></summary>

- Service with no `stopSelf()` call
- Deferrable work using raw Service instead of WorkManager
- JobScheduler ignored for background sync
- Infinite `ValueAnimator` not cancelled in lifecycle
- Heavy computation in `onDraw()` (forces continuous redraws)
- `AlarmManager.ELAPSED_REALTIME_WAKEUP` for non-critical work

</details>

---

### 2. Causal Chain Tracing

For every finding, EcoTrace walks the call graph backwards from the offending
line to the lifecycle entry point that put it on the path — the root cause, not
just the symptom file. This runs locally by default; when Bob is configured it
can refine the traced path and write a fix for that specific chain rather than a
generic one.

```
[CRITICAL CHAIN DETECTED]

Root Cause:    MainActivity.onCreate() [line 47]
               +-- registers alarm with no exponential backoff

Propagates to: AlarmHelper.scheduleSync() [line 23]
               +-- uses setRepeating() (deprecated, ignores Doze)

Reaches:       SyncService.onStartCommand() [line 89]
               +-- acquires WakeLock, never released on error path

Confirmed by:  dumpsys shows SyncService holding wakelock 340ms
               average per trigger x 96 triggers/day = 32.6 seconds
               of unnecessary screen-off CPU time daily

Bob's Fix:     Replace AlarmManager with WorkManager + exponential
               backoff. WakeLock becomes unnecessary -- WorkManager
               handles wake scheduling internally.

Impact:        0.4 mAh/min reduction -> Grade: C to B
```

---

### 3. Dynamic Profiling -- Live ADB Integration

Connect an Android device via USB. EcoTrace runs `adb shell dumpsys batterystats` before and after a real usage session, then:

- **Attributes drain to your app**, using batterystats' own per-package mAh
  accounting at 0.1 mAh resolution. The package under test is read from the
  project's `AndroidManifest.xml`, so the figure is the app's drain rather than
  the handset's
- Falls back to the battery charge level when per-app accounting is unavailable,
  and **says so with its resolution attached** — one percentage point is 30 mAh
  on a typical cell, which is not a two-decimal-place measurement
- Identifies which processes consumed the most battery
- Measures CPU wakeups per hour
- Detects Doze mode violations
- Tracks network type changes (WiFi vs Mobile)
- Measures screen-off vs screen-on drain ratio
- **Cross-references with static findings** -- confirms which anti-patterns are actively firing

Every one of these numbers carries its provenance through to the exported
report, because a figure whose origin is unknown is a figure nobody should act
on.

---

### 4. Fix Intelligence -- Bob Generates Real Code

Not descriptions. Not suggestions. Copy-paste-ready refactored code for every Critical finding.

```kotlin
// BEFORE -- NetworkManager.java line 247
val response = client.newCall(request).execute()

// AFTER -- Bob's generated fix
val response = client.newBuilder()
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .writeTimeout(15, TimeUnit.SECONDS)
    .build()
    .newCall(request).execute()

// Impact: eliminates indefinite thread blocking on slow networks
// Estimated drain reduction: 0.12 mAh/min on mobile connections
```

---

### 5. Scan History Persistence

Every ADB profiling session is appended to a local scan history
(`%APPDATA%\ecotrace\history.json`) via `saveScan()` in `src/grader/grade.ts`, and
`loadHistory()` / `computeScoreProgress()` read it back and compute per-scan
score deltas.

**Surfaced in the UI:** the **History** button in the status bar (or `Ctrl+H`)
opens a panel listing every recorded scan with its grade, finding counts and
score delta, so a refactor can be checked against the previous run rather than
against a memory. The same series is written into the exported report's
**Score timeline** section.

---

## Interface

The workbench is built on the **IBM Carbon Design System** — IBM's own design
system for enterprise products, and the reason the application reads as
institutional software rather than as a dark-themed demo.

| Carbon element | How EcoTrace uses it |
|---|---|
| **UI shell** | 48px header with product identity left, work-surface switcher centre, global actions right; 32px status bar pinned below the work surface |
| **Theme tokens (g100 / g90 / white)** | The entire palette is generated from Carbon's theme maps, so a theme switch is a token swap with no component rule changing |
| **IBM Plex Sans / Mono** | Bundled locally, not fetched — the app renders identically offline and in the packaged build |
| **Data table** | Findings table with sortable headers, expandable rows, toolbar, and a rollup bar; row heights follow Carbon's 40px (lg) rhythm |
| **Tags** | Severity tags use Carbon's support palette: Red 40 critical, Orange 40 high, Yellow 30 medium |
| **Command palette** | `Ctrl+K` over every action, with each accelerator shown in the row's right gutter |
| **Composed modal** | Settings and history, with focus trapped while open and returned to the trigger on close |
| **Notification toast** | Bottom-left, severity in the icon and left edge, announced through a live region |
| **2px spacing scale · 150/240ms motion** | Every gap and transition resolves to a Carbon token |

**Interaction and accessibility**

- Full keyboard operation: `Ctrl+K` commands, `F5` analyze, `Alt+↑/↓` step
  through findings, `/` search, `Esc` closes, splitters resize with arrows.
- Selection is bidirectional — picking a finding reveals its file in the tree,
  picking a file scopes the table to it, and picking the same file again leaves
  the scope. The selected file and the table's scope mode are owned in one
  place, so the three views cannot disagree about what "selected" means.
- The analysis runs on a **worker thread**, so the window stays live during a
  scan: the run log scrolls, the splitters drag, the table still sorts.
- ARIA tree, tablist, tablists and live regions throughout; focus rings are
  Carbon's 2px theme-focus token; `prefers-reduced-motion` and Windows
  high-contrast are both honoured.

The exported report uses Carbon's **white** theme — it is read in daylight,
printed and archived rather than worked in at night — and embeds IBM Plex as a
data URI so it renders identically for every recipient.

---

## The Report

Ten sections, typeset for A4 as well as for a screen, and honest about its own
numbers.

1. **Verdict** — one paragraph, quotable in a review, generated from the numbers
   rather than picked from a list so it cannot drift out of sync with the grade
2. **Ranked plan** — the six critical/high findings, most severe first
3. **Score breakdown** — the three weighted components, plus the grade table
4. **At a glance** — sources, findings, files affected, drain with its
   provenance, longest chain, detectors run
5. **Distribution by category** — stacked severity bar and a per-category table
6. **Causal chain** — the deepest chain in the scan as a root → propagation →
   symptom diagram. A single-file tool can only report the line the defect is
   on; this is the part that has to change for the symptom to stop recurring
7. **All findings** — grouped by category, each with source, its own traced
   chain, and a fix
8. **Detector coverage** — all 23 rules and what each found. A rule that found
   nothing is shown as a **zero, not omitted**: "checked and clean" is a result,
   and hiding it makes the document indistinguishable from one that never ran
   the check
9. **Device profile** — top CPU consumers, new wakelocks, Doze violations, CPU
   wakeup alarms
10. **Method and limits** — how the score is computed and what the known blind
    spots are. The fastest way to lose an expert reader is a number they cannot
    trust.

### Three ways out

| Action | Shortcut | Output |
|--------|----------|--------|
| **Export report** | `Ctrl+E` | Standalone HTML — attach to a ticket, commit, archive. No network needed. |
| **PDF** | `Ctrl+Shift+E` | PDF via the print dialog |
| **Open in browser** | `Ctrl+Shift+P` | The default browser, with its own print controls |

The PDF is produced by handing the document to the host's print pipeline and
choosing **Microsoft Print to PDF** or **Save as PDF**. That is deliberate:
it yields real vector text — selectable, searchable, correctly hinted — whereas
the only alternative available inside a webview is a canvas rasteriser, which
produces an unsearchable image of the page. Tauri exposes no programmatic
print-to-file, and going lower level means binding Windows COM interfaces
coupled to the WebView2 runtime version.

The document is already laid out for paper when the dialog opens. The print
stylesheet declares the page size and margins, a running footer with page
counters (WebView2 is Chromium, so these are real), and `break-inside: avoid`
for every card, table, code block and chain node. Findings print **expanded** —
a collapsed row in a PDF would be a finding the reader cannot see.

---
---

## Grading System

| Grade | Drain Rate | Critical Findings | High Findings |
|:---:|---|:---:|:---:|
| **A+** | < 0.5 mAh/min | 0 | 0 |
| **A** | < 0.8 mAh/min | 0 | <= 2 |
| **B** | < 1.2 mAh/min | <= 1 | any |
| **C** | < 2.0 mAh/min | <= 3 | any |
| **D** | < 3.0 mAh/min | any | any |
| **F** | >= 3.0 mAh/min OR >= 5 critical | -- | -- |

**Weighted formula:** `score = drain(40%) + critical(35%) + high(25%)`

---

## Test Results -- Signal Android

We ran EcoTrace against [Signal Android](https://github.com/signalapp/Signal-Android) -- a production-grade, security-critical open source app with 847 source files.

| Metric | Result |
|---|---|
| Files analyzed | 847 |
| Analysis time | 43 seconds |
| Total findings | 12 |
| Critical | 3 |
| High | 5 |
| Medium | 4 |
| Measured drain rate | 1.4 mAh/min |
| Energy grade | **C** |
| Longest causal chain | 7 files |

*Real findings on production code -- not synthetic examples.*

> **How to read this table:** these figures come from a single **manual** run, most of them
> recorded in [`bob_sessions/session-07-fix-engine.json`](bob_sessions/session-07-fix-engine.json)
> (the 43-second timing is not recorded there). No automated test or benchmark script in
> this repo reproduces them, so treat them as an illustrative record rather than a
> reproducible measurement. The analysis has since moved to a worker thread, so wall-clock
> time to *result* is now different from time to *visible progress* — the window stays
> interactive throughout.

---

## Architecture

```
+---------------------------------------------------------------+
|  EcoTrace — Tauri 2.0 + TypeScript                           |
+------------------+------------------------+-----------------+
|  Navigator       |  Findings table       |  Inspector      |
|  Project tree    |  sort · filter ·      |  Rule · source  |
|  severity-coded  |  expand rows          |  Causal chain   |
|  click to scope  |  -------------------- |  Fix · Copy     |
|                  |  Run log (phases,     |  (3 tabs)       |
|                  |  timings, errors)     |                 |
+------------------+------------------------+-----------------+
|  Status bar: grade · drain + provenance · findings · Bob status   |
+---------------------------------------------------------------+
        |                                    |
        v                                    v
+-------------------+            +--------------------+
| Static analyzer   |            | ADB bridge         |
| 23 detectors +    |            |  dumpsys           |
| call-graph tracer |            |  batterystats      |
| (Web Worker)      |            |  per-package mAh   |
+-------------------+            +--------------------+
        |                                    |
        +----------------+-------------------+
                         v
              +---------------------------+
              |  IBM Bob 2.0 (OPTIONAL)    |
              |  severity revision ·       |
              |  per-chain fixes            |
              |  only if a key is provided  |
              +---------------------------+
                         v
              +---------------------------+
              |  Grader + scan history     |
              |  (%APPDATA%\ecotrace)      |
              +---------------------------+
                         v
              +---------------------------+
              |  Report: HTML · PDF ·     |
              |  browser                  |
              +---------------------------+
```

The analyzer runs on a **Web Worker**, so the window stays live during a scan —
the run log scrolls, the splitters drag, the table still sorts. That matters for
more than polish: when the work was on the UI thread, the window froze, and a
frozen window cannot report its own progress, so a long scan looked like a hang.

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Desktop shell | Tauri 2.0 | 3-8 MB binary, no Electron bloat, native OS integration |
| App logic | TypeScript 5.0 | Strong types, fast iteration |
| System layer | Rust (minimal) | Four rooted commands: `walk_dir`, `read_file`, `read_text`, `read_manifest` |
| Analysis thread | Web Worker | Keeps 23 detector passes + call-graph build off the UI thread |
| AI engine | IBM Bob 2.0 (optional) | Severity revision and per-chain fixes — the product is fully functional without it |
| Storage | Local JSON | Scan history, offline-first, zero cloud dependencies |
| Design system | IBM Carbon Design System (`@carbon/styles`) | Tokens, type, motion and component anatomy from the system IBM ships its own products on |
| Styling | Sass, compiled by Vite | Design tokens are generated from Carbon's theme maps rather than hand-written |

---

## Installation

### Download (Recommended)

Go to the **[Releases page](https://github.com/theredhacker0345/Eco-Trace/releases)** and download `EcoTrace_0.1.0_x64-setup.exe`.

> If Windows SmartScreen appears, click **"More info" -> "Run anyway"**.
> This is expected for unsigned apps -- the installer is safe.

### Build from Source

```bash
git clone https://github.com/theredhacker0345/Eco-Trace.git
cd Eco-Trace
npm install
npm run tauri build
```

Full prerequisites and troubleshooting in [SETUP.md](SETUP.md).

---

## Project Structure

```
Eco-Trace/
+-- index.html               App shell: UI shell header, 3-pane workbench, modals, icon sprite
+-- src/
|   +-- main.ts              Entry point: analyzer + Bob + ADB + export, and state ownership
|   +-- styles/              Design system, compiled from Carbon Sass
|   |   +-- _tokens.scss     Carbon g100/g90/white token set -> CSS custom properties
|   |   +-- _fonts.scss      IBM Plex @font-face (local faces)
|   |   +-- _base.scss       Reset, focus, scrollbars, a11y affordances
|   |   +-- _controls.scss   Buttons, fields, tags, tabs, selects, switches
|   |   +-- _shell.scss      Shell frame, status bar, modals, toasts, onboarding
|   |   +-- _navigator.scss  File tree and severity filters
|   |   +-- _findings.scss   Data table, expandable rows, run log, sub-score meters
|   |   +-- _inspector.scss  Overview / causal chain / fix panels
|   |   +-- index.scss       Entry; load order matters
|   |   +-- fonts/           IBM Plex woff2 (SIL OFL 1.1)
|   +-- ui/                  View modules — one concern per file, no markup in main.ts
|   |   +-- store.ts         Shared state + event bus
|   |   +-- dom.ts           Element lookup, escaping, icon and code helpers
|   |   +-- focus.ts         Focus trap, tablist, declarative keymap
|   |   +-- navigator.ts     Project tree: grouping, severity, keyboard traversal
|   |   +-- findingsTable.ts Data table: filter, sort, expand, rollup
|   |   +-- inspector.ts     Single-finding inspector and chain rendering
|   |   +-- remediation.ts   The 23 authored fixes
|   |   +-- runLog.ts        Level-filtered, copyable run log
|   |   +-- palette.ts       Command palette
|   |   +-- splitters.ts     Persisted, keyboard-operable pane resizing
|   |   +-- panes.ts         Pane-to-overlay behaviour at narrow widths
|   |   +-- modals.ts        Settings and history modals
|   |   +-- theme.ts         Carbon theme selection
|   |   +-- toasts.ts        Notifications
|   |   +-- catalog.ts       The 23-detector catalogue
|   |   +-- format.ts        Path, number and date formatting
|   |   +-- preview.ts       Dev-only browser harness (never in a release bundle)
|   |   +-- report.html      Exported report template (IBM Plex embedded)
|   +-- analyzer/
|   |   +-- static.ts         23-pattern static analysis engine + call-graph tracing
|   |   +-- worker.ts         Runs the detectors off the UI thread
|   |   +-- runner.ts         Worker lifecycle, with an inline fallback
|   +-- report/
|   |   +-- payload.ts        Assembles the report's data contract
|   |   +-- export.ts         HTML write, PDF via the print pipeline, open-in-browser
|   +-- parser/dumpsys.ts    ADB output -> structured JSON
|   +-- grader/grade.ts      Scoring engine + scan history storage
|   +-- settings.ts          ADB path + API key persistence
+-- tools/
|   +-- embed-report-fonts.mjs   Re-embeds IBM Plex into the report template
+-- src-tauri/
|   +-- src/lib.rs           Rooted commands: walk_dir, read_file, read_text, read_manifest
|   +-- src/main.rs          Binary entry point
|   +-- tauri.conf.json      App config + window settings
|   +-- Cargo.toml           Rust dependencies
+-- .bob/
|   +-- rules-agent/energy.md  Bob's 23-pattern detection rules
+-- bob_sessions/            IBM Bob 2.0 session exports (7 sessions)
+-- docs/                    Architecture plan, testing guide
+-- assets/                  Demo assets (demo.gif not yet committed — see assets/README.md)
+-- .github/workflows/       CI: build, typecheck, release
+-- README.md
+-- SETUP.md
```

---

## Bob Sessions

All 7 IBM Bob 2.0 session exports live in [`/bob_sessions/`](bob_sessions/). They show exactly how Bob reasoned through every stage of the build.

| Session | Title (from the session export) | What Bob Built |
|---|---|---|
| `session-01-architecture.json` | Full Project Architecture & Planning | Full project plan, 10 architectural decisions |
| `session-02-tauri-scaffold.json` | Tauri 2.0 Windows Project Scaffold | Tauri 2.0 shell + Rust bridge |
| `session-03-dumpsys-parser.json` | ADB dumpsys batterystats Parser | ADB output parser (7 interfaces, 8 parsers) |
| `session-04-static-analyzer.json` | 23-Pattern Static Analysis Engine | 23-pattern engine + call graph builder |
| `session-05-grader-ui.json` | Grading Engine + Settings Store + UI | Grading engine + settings store + workbench shell |
| `session-06-call-chain.json` | Causal Chain Tracing + Inspector UI | Causal chain tracing + finding inspector |
| `session-07-fix-engine.json` | Fix Generation + Final Integration | Bob-generated code fix system |

---

## Team

**Code and Chaos** &nbsp;|&nbsp; IBM Bob 2.0 Hackathon &nbsp;|&nbsp; September 2026

| Member | Role |
|---|---|
| [Ubaid ur Rehman](https://lablab.ai/u/@theredhacker0345) | Architecture, IBM Bob integration, full build |
| [Tayyaba Amin](https://lablab.ai/u/@tayyaba_amin818) | Research, documentation, submission |
| [Sawaira Fareed](https://lablab.ai/u/@Sawaira_) | Presentation, demo video, repo organization |

---

## Why This Wins

Most hackathon submissions use Bob as a smarter autocomplete. EcoTrace uses it
as what it is actually good at — reasoning over a whole repository at once —
and, more importantly, does not *depend* on it.

Two things came out of building it that are worth calling out:

- **A call-graph tracer that runs offline.** The chain in the diagram at the top
  of this file is produced with no API key, no network, and no service. That
  makes causal analysis a feature of the product rather than a demo condition.
- **A report that is honest about its own numbers.** A drain rate derived from
  the battery charge level is printed with its resolution attached, because a
  30 mAh granularity is not a two-decimal-place measurement. A finding with no
  traced chain says so instead of omitting the chain. The 23-rule coverage
  matrix shows the rules that found nothing, as zeros. This is aimed at an expert
  reader, and the fastest way to lose one is a number they cannot trust.

The fix generator makes the findings immediately actionable, the ADB integration
ties the static analysis to real runtime behaviour, and the scan-history store
turns a one-shot analysis into a continuous improvement loop.

**This is not a demo. This is a tool Android developers would actually install.**

---

<div align="center">

Built with **IBM Bob 2.0** at the IBM Bob 2.0 Hackathon &nbsp;|&nbsp; September 2026

*EcoTrace -- Because knowing what drains your battery is not enough.*

<br/>

[![Download for Windows](https://img.shields.io/badge/Download%20for%20Windows-EcoTrace%20v0.1.0-0078d4?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/theredhacker0345/Eco-Trace/releases)

</div>