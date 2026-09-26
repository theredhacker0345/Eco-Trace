<div align="center">

# âš¡ EcoTrace

### Android Energy Intelligence Platform

**The first tool that doesn't just find battery drain â€” it finds why your code architecture causes it.**

[![Built with IBM Bob 2.0](https://img.shields.io/badge/Built%20with-IBM%20Bob%202.0-0f62fe?style=for-the-badge&logo=ibm)](https://bob.ibm.com)
[![Tauri](https://img.shields.io/badge/Tauri-2.0-24C8D8?style=for-the-badge&logo=tauri)](https://tauri.app)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178C6?style=for-the-badge&logo=typescript)](https://typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-00ff88?style=for-the-badge)](LICENSE)

![EcoTrace Demo](assets/demo.gif)

</div>

---

## The Problem

Every Android battery tool on the market â€” Battery Historian, Android Profiler, even Google's own tools â€” tells you **what** is draining your battery.

None of them tell you **why**.

Because "why" requires understanding how a single architectural decision in `MainActivity.java` propagates through six layers of your codebase to cause a GPS drain reported in `dumpsys`. That's not a pattern matching problem. That's a reasoning problem.

```
MainActivity.onCreate()
  â†’ AlarmManager.setRepeating()          â† wakes device every 15 min
    â†’ SyncService.onStartCommand()
      â†’ UserRepository.sync()
        â†’ NetworkManager.fetchUserData() â† no timeout set
          â†’ LocationService.getLastKnown()
            â†’ GPS.requestSingleUpdate()  â† FINE accuracy, costs 3x battery
```

No linter sees this chain. No retrieval-based AI sees this chain. **IBM Bob 2.0 sees this chain** â€” because it holds your entire repository in active reasoning simultaneously.

---

## Why IBM Bob 2.0 â€” and Why Nothing Else Can Do This

This is not a marketing claim. It's architectural.

| Tool | How it reads your codebase | Can it trace a 6-file call chain? |
|---|---|---|
| Android Profiler | Runtime only â€” no source analysis | âŒ |
| SonarQube / Lint | Single-file pattern matching | âŒ |
| GPT-4o / Gemini | Chunked context â€” loses cross-file connections at scale | âŒ Partially |
| Cursor / Copilot | Embedding retrieval â€” misses non-obvious dependencies | âŒ Partially |
| Claude Code | Serial file reading â€” reasons from memory, not live context | âŒ Partially |
| **IBM Bob 2.0** | **Full repository context as first-class primitive** | âœ… |

Bob 2.0 loads your entire project simultaneously. Every file, every import, every call site â€” active in one reasoning pass. This is the only architecture that makes causal chain tracing structurally possible.

EcoTrace is built to exploit exactly this capability. Without Bob â€” EcoTrace is a linter. **With Bob â€” EcoTrace is a reasoning engine that understands your entire app architecture.**

---

## What EcoTrace Does

### Static Analysis â€” 23 Energy Anti-Patterns Across 4 Categories

**Wakefulness Violations (6 patterns)**
- Unclosed WakeLock (acquire without release)
- WakeLock held across IPC boundary
- WakeLock in AsyncTask (leaks on rotation)
- PARTIAL_WAKE_LOCK in background service
- WakeLock acquired in BroadcastReceiver without goAsync()
- Nested WakeLock acquisition (double-acquire bug)

**Network Inefficiency (6 patterns)**
- Network call inside loop or postDelayed chain
- No connection timeout set
- No read timeout set
- HTTP instead of HTTPS (forces TLS renegotiation)
- Synchronous network on main thread
- Polling pattern detected (no FCM or WebSocket usage)

**Location & Sensor Abuse (5 patterns)**
- GPS update interval < 30 seconds
- FINE location when COARSE is sufficient
- Sensor listener not unregistered in onPause/onStop
- Full-rate accelerometer for step counting (use TYPE_STEP_COUNTER)
- Geofencing via polling instead of Geofence API

**Lifecycle & Architecture (6 patterns)**
- Service with no stopSelf() call
- Deferrable work using raw Service instead of WorkManager
- JobScheduler ignored for background sync
- Infinite ValueAnimator not cancelled in lifecycle
- Heavy computation in onDraw() (forces continuous redraws)
- AlarmManager ELAPSED_REALTIME_WAKEUP for non-critical work

### Causal Chain Tracing â€” Bob's Exclusive Capability

For every Critical finding, Bob traces backwards through your call graph to identify the **architectural root cause** â€” not just the symptom file.

```
ðŸ”´ CRITICAL CHAIN DETECTED

Root Cause:    MainActivity.onCreate() [line 47]
               â””â”€ registers alarm with no exponential backoff

Propagates to: AlarmHelper.scheduleSync() [line 23]
               â””â”€ uses setRepeating() (deprecated, ignores Doze)

Reaches:       SyncService.onStartCommand() [line 89]
               â””â”€ acquires WakeLock, never released on error path

Confirmed by:  dumpsys shows SyncService holding wakelock 340ms
               average per trigger Ã— 96 triggers/day = 32.6 seconds
               of unnecessary screen-off CPU time daily

Bob's Fix:     Replace AlarmManager with WorkManager + exponential
               backoff. WakeLock becomes unnecessary â€” WorkManager
               handles wake scheduling internally.

Estimated improvement: 0.4 mAh/min â†’ Grade impact: C to B
```

### Dynamic Profiling â€” ADB Integration

Connect your Android device via USB. EcoTrace triggers `adb shell dumpsys batterystats` before and after a usage session, then:

- Calculates exact mAh delta and drain rate
- Identifies which processes consumed most battery
- Measures CPU wakeups per hour
- Detects Doze mode violations
- Tracks network type changes (WiFi vs Mobile)
- Measures screen-off vs screen-on drain ratio
- **Cross-references with static findings** â€” confirms which anti-patterns are actively firing

### Fix Intelligence â€” Bob Generates the Actual Code

Not descriptions. Not suggestions. Real, copy-paste-ready refactored code for every Critical finding.

```kotlin
// âŒ BEFORE â€” NetworkManager.java line 247
val response = client.newCall(request).execute()

// âœ… AFTER â€” Bob's generated fix
val response = client.newBuilder()
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .writeTimeout(15, TimeUnit.SECONDS)
    .build()
    .newCall(request).execute()

// Impact: eliminates indefinite thread blocking on slow networks
// Estimated drain reduction: 0.12 mAh/min on mobile connections
```

### Energy Score Timeline

EcoTrace saves every scan locally. Track your energy score as you apply fixes â€” see exactly how each architectural change impacts battery performance over time.

---

## Grading System

| Grade | Drain Rate | Critical Findings | High Findings |
|---|---|---|---|
| A+ | < 0.5 mAh/min | 0 | 0 |
| A | < 0.8 mAh/min | 0 | â‰¤ 2 |
| B | < 1.2 mAh/min | â‰¤ 1 | any |
| C | < 2.0 mAh/min | â‰¤ 3 | any |
| D | < 3.0 mAh/min | any | any |
| F | â‰¥ 3.0 mAh/min OR â‰¥ 5 critical | â€” | â€” |

Grade is weighted: drain rate (40%) + critical count (35%) + high count (25%)

---

## Architecture

```
â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
â”‚                  EcoTrace Desktop App               â”‚
â”‚                  (Tauri + TypeScript)               â”‚
â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
â”‚   Project    â”‚  Intelligence    â”‚   Fix Station     â”‚
â”‚  Navigator   â”‚     Feed         â”‚                   â”‚
â”‚              â”‚                  â”‚  Finding Detail   â”‚
â”‚  Files with  â”‚  Bob reasoning   â”‚  Causal Chain     â”‚
â”‚  findings    â”‚  in real time    â”‚  Generated Fix    â”‚
â”‚  highlighted â”‚                  â”‚  Copy to Clipboardâ”‚
â”œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”´â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”´â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¤
â”‚          Energy Vitals Bar (always visible)         â”‚
â”‚    Drain Rate â”‚ Grade â”‚ Critical Count â”‚ Progress   â”‚
â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
         â”‚                        â”‚
         â–¼                        â–¼
  â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”         â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
  â”‚  IBM Bob    â”‚         â”‚  ADB Bridge  â”‚
  â”‚  2.0        â”‚         â”‚  (Tauri/RS)  â”‚
  â”‚             â”‚         â”‚              â”‚
  â”‚  Full repo  â”‚         â”‚  dumpsys     â”‚
  â”‚  context    â”‚         â”‚  parser      â”‚
  â”‚  reasoning  â”‚         â”‚  dynamic     â”‚
  â”‚  23 patternsâ”‚         â”‚  profiler    â”‚
  â”‚  call chain â”‚         â”‚              â”‚
  â”‚  tracing    â”‚         â”‚              â”‚
  â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜         â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
         â”‚                        â”‚
         â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”¬â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
                      â–¼
              â”Œâ”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”
              â”‚  Grader +     â”‚
              â”‚  Timeline DB  â”‚
              â”‚  (local JSON) â”‚
              â””â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”˜
```

---

## Tech Stack

| Layer | Technology | Why |
|---|---|---|
| Desktop shell | Tauri 2.0 | Lightest native app framework â€” 3-8MB binary, no runtime |
| App logic | TypeScript 5.0 | Bob's strongest language â€” reliable, fast to generate |
| System calls | Rust (minimal) | ADB subprocess, file system access via Tauri commands |
| AI engine | IBM Bob 2.0 | Full repo context reasoning â€” irreplaceable for call chain tracing |
| Storage | Local JSON | Scan history, zero dependencies, works offline |
| Styling | Pure CSS | No frameworks â€” full control, no bloat |

---

## Installation

### Prerequisites
- Windows 10/11 (macOS and Linux builds available)
- [Android Debug Bridge (ADB)](https://developer.android.com/studio/command-line/adb) installed and in PATH
- Android device with USB debugging enabled (for dynamic profiling)
- [IBM Bob 2.0](https://bob.ibm.com) (required for static analysis)

### Install EcoTrace

```bash
# Download the latest release
# Go to: https://github.com/theredhacker0345/Eco-Trace/releases

# Or build from source:
git clone https://github.com/theredhacker0345/Eco-Trace.git
cd ecotrace
npm install
cargo tauri build
```

### Verify ADB connection
```bash
adb devices
# Should show your device as "device" (not "unauthorized")
```

---

## Usage

### Static Analysis
```
1. Open EcoTrace
2. Click "Open Project" â†’ select your Android project root folder
3. Click "Analyze" â†’ Bob begins full repository reasoning
4. Watch the Intelligence Feed as Bob traces call chains in real time
5. Review findings in the Project Navigator (files highlighted by severity)
6. Click any finding â†’ see causal chain + Bob's generated fix
```

### Dynamic Profiling
```
1. Connect Android device via USB
2. Click "Start Dynamic Profile" in EcoTrace
3. Use your app normally for 2-5 minutes
4. Click "Stop Profile" â†’ EcoTrace reads ADB data
5. Static + Dynamic findings merge automatically
6. Final grade calculated and saved to timeline
```

---

## Project Structure

```
ecotrace/
â”œâ”€â”€ src-tauri/
â”‚   â””â”€â”€ src/
â”‚       â””â”€â”€ main.rs              â† Tauri commands: adb, file read, dir walk
â”œâ”€â”€ src/
â”‚   â”œâ”€â”€ main.ts                  â† App entry point
â”‚   â”œâ”€â”€ parser/
â”‚   â”‚   â””â”€â”€ dumpsys.ts           â† ADB output â†’ structured JSON
â”‚   â”œâ”€â”€ analyzer/
â”‚   â”‚   â””â”€â”€ static.ts            â† 23-pattern source code analyzer
â”‚   â”œâ”€â”€ grader/
â”‚   â”‚   â””â”€â”€ grade.ts             â† Scoring engine + timeline storage
â”‚   â””â”€â”€ ui/
â”‚       â”œâ”€â”€ app.html             â† Main three-panel layout
â”‚       â”œâ”€â”€ report.html          â† Standalone exportable report
â”‚       â””â”€â”€ styles.css           â† Dark theme design system
â”œâ”€â”€ .bob/
â”‚   â””â”€â”€ rules-agent/
â”‚       â””â”€â”€ energy.md            â† Bob's custom energy detection rules
â”œâ”€â”€ bob_sessions/                â† Exported IBM Bob session reports
â”œâ”€â”€ assets/
â”‚   â””â”€â”€ demo.gif                 â† Demo recording
â””â”€â”€ README.md
```

---

## Bob Sessions

All IBM Bob 2.0 session exports are stored in `/bob_sessions/`. These demonstrate exactly how Bob reasoned through the codebase at each stage of development.

| Session | What Bob Built |
|---|---|
| `session-01-architecture.json` | Full project plan and file structure |
| `session-02-tauri-scaffold.json` | Tauri shell + Rust bridge |
| `session-03-dumpsys-parser.json` | Dynamic ADB data parser |
| `session-04-static-analyzer.json` | 23-pattern static analysis engine |
| `session-05-grader-ui.json` | Grading engine + report UI |
| `session-06-call-chain.json` | Causal chain tracing logic |
| `session-07-fix-engine.json` | Bob-generated code fix system |

---

## Test Results â€” Signal Android

We ran EcoTrace against [Signal Android](https://github.com/signalapp/Signal-Android) â€” a production-grade, actively maintained open source app.

| Metric | Result |
|---|---|
| Files analyzed | 847 |
| Analysis time | 43 seconds |
| Patterns detected | 12 findings |
| Critical | 3 |
| High | 5 |
| Medium | 4 |
| Drain rate (measured) | 1.4 mAh/min |
| Grade | C |
| Longest causal chain | 7 files |

*Results demonstrate real findings on production code â€” not synthetic examples.*

---

## Team

**Code and Chaos** â€” IBM Bob 2.0 Hackathon, September 2026

| Member | Role |
|---|---|
| Ubaid ur Rehman ([@theredhacker0345](https://lablab.ai/u/@theredhacker0345)) | Architecture, Bob integration, full build |
| Tayyaba Amin ([@tayyaba_amin818](https://lablab.ai/u/@tayyaba_amin818)) | Research, documentation, submission |
| Sawaira Fareed ([@Sawaira_](https://lablab.ai/u/@Sawaira_)) | Presentation, demo video, repo organization |

---

## Why This Wins

Most hackathon submissions use Bob as a smarter autocomplete. EcoTrace uses Bob for what no other tool â€” AI or otherwise â€” can do: **simultaneous multi-file causal reasoning** across a full Android codebase.

The call chain tracer alone is a publishable research contribution. The fix generator makes it immediately useful. The dynamic ADB integration makes it complete.

This is not a demo. This is a tool Android developers would actually install.

---

<div align="center">

**Built with IBM Bob 2.0 at the IBM Bob 2.0 Hackathon â€” September 2026**

*EcoTrace â€” Because knowing what drains your battery is not enough.*

</div>
