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

No linter sees this chain. No retrieval-based AI sees this chain. **IBM Bob 2.0 sees this chain** -- because it holds your entire repository in active reasoning simultaneously.

---

## Why IBM Bob 2.0 -- and Why Nothing Else Can Do This

| Tool | How it reads your codebase | Traces 6-file call chains? |
|---|---|:---:|
| Android Profiler | Runtime only, no source analysis | No |
| SonarQube / Lint | Single-file pattern matching | No |
| GPT-4o / Gemini | Chunked context, loses cross-file links at scale | Partially |
| Cursor / Copilot | Embedding retrieval, misses non-obvious dependencies | Partially |
| Claude Code | Serial file reading, reasons from memory not live context | Partially |
| **IBM Bob 2.0** | **Full repository context as a first-class primitive** | **Yes** |

Bob 2.0 loads your entire project simultaneously -- every file, every import, every call site -- active in one reasoning pass. This is the only architecture that makes causal chain tracing structurally possible.

Without Bob, EcoTrace is a linter. **With Bob, EcoTrace is a reasoning engine that understands your entire app architecture.**

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

### 2. Causal Chain Tracing -- Bob's Exclusive Capability

For every **Critical** finding, Bob traces backwards through your call graph to identify the architectural root cause -- not just the symptom file.

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

- Calculates exact mAh delta and drain rate
- Identifies which processes consumed the most battery
- Measures CPU wakeups per hour
- Detects Doze mode violations
- Tracks network type changes (WiFi vs Mobile)
- Measures screen-off vs screen-on drain ratio
- **Cross-references with static findings** -- confirms which anti-patterns are actively firing

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
`loadHistory()` / `computeScoreProgress()` are implemented to read it back and compute
per-scan score deltas.

**Current status:** the persistence layer exists and is written, but the timeline view
is **not yet surfaced in the UI** — no timeline chart is rendered anywhere, and the
exported report payload hardcodes an empty `history` array, so no score-over-time view
is available yet. The storage layer is in place for that view.

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
> reproducible measurement.

---

## Architecture

```
+-----------------------------------------------------+
|                  EcoTrace Desktop App               |
|                  (Tauri 2.0 + TypeScript)           |
+--------------+------------------+-------------------+
|   Project    |  Intelligence    |   Fix Station     |
|  Navigator   |  Feed            |                   |
|              |                  |  Finding detail   |
|  Files with  |  Bob reasoning   |  Causal chain     |
|  findings    |  streaming live  |  Generated fix    |
|  highlighted |                  |  Copy to clipboard|
+--------------+------------------+-------------------+
|        Energy Vitals Bar (always visible)           |
|   Grade  |  Drain Rate  |  Critical Count  |  High Count  |
+-----------------------------------------------------+
        |                          |
        v                          v
  +-----------+            +---------------+
  | IBM Bob   |            |  ADB Bridge   |
  | 2.0       |            |  (Rust/Tauri) |
  |           |            |               |
  | Full repo |            | dumpsys       |
  | context   |            | parser        |
  | reasoning |            | dynamic       |
  | 23 pattern|            | profiler      |
  | call chain|            |               |
  | tracing   |            |               |
  +-----------+            +---------------+
        |                          |
        +------------+-------------+
                     v
              +--------------+
              |  Grader +    |
              |  Scan History|
              |  (local JSON)|
              +--------------+
```

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Desktop shell | Tauri 2.0 | 3-8 MB binary, no Electron bloat, native OS integration |
| App logic | TypeScript 5.0 | Strong types, fast iteration, Bob's strongest language |
| System layer | Rust (minimal) | ADB subprocess, file system access via Tauri commands |
| AI engine | IBM Bob 2.0 | Full-repo context reasoning -- structurally irreplaceable |
| Storage | Local JSON | Scan history, offline-first, zero cloud dependencies |
| Styling | Pure CSS | Full design control, no framework overhead |

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
+-- index.html               Single app shell: 3-panel layout + settings modal
+-- src/
|   +-- main.ts              App entry point + full UI wiring
|   +-- analyzer/static.ts   23-pattern static analysis engine
|   +-- parser/dumpsys.ts    ADB output -> structured JSON
|   +-- grader/grade.ts      Scoring engine + scan history storage
|   +-- settings.ts          ADB path + API key persistence
|   +-- ui/report.html       Standalone exportable HTML report
|   +-- ui/styles.css        Dark theme design system
+-- src-tauri/
|   +-- src/lib.rs           Rust commands: read_file, walk_dir
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
| `session-05-grader-ui.json` | Grading Engine + Settings Store + UI | Grading engine + settings store + three-panel UI |
| `session-06-call-chain.json` | Causal Chain Tracing + Fix Station UI | Causal chain tracing + Fix Station UI |
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

Most hackathon submissions use Bob as a smarter autocomplete. EcoTrace uses Bob for what **no other tool -- AI or otherwise -- can do**: simultaneous multi-file causal reasoning across a full Android codebase.

The call chain tracer is a publishable research contribution. The fix generator makes it immediately useful. The ADB integration makes it complete. And the scan-history store (already persisting every profiled scan) is the foundation for turning a one-shot analysis into a continuous improvement loop.

**This is not a demo. This is a tool Android developers would actually install.**

---

<div align="center">

Built with **IBM Bob 2.0** at the IBM Bob 2.0 Hackathon &nbsp;|&nbsp; September 2026

*EcoTrace -- Because knowing what drains your battery is not enough.*

<br/>

[![Download for Windows](https://img.shields.io/badge/Download%20for%20Windows-EcoTrace%20v0.1.0-0078d4?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/theredhacker0345/Eco-Trace/releases)

</div>