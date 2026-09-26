---
name: ecotrace
description: >
  Analyze Android projects for battery energy anti-patterns using EcoTrace.
  Triggers: "analyze this Android app for battery issues", "check battery drain",
  "why is my app draining battery", "find energy anti-patterns",
  "EcoTrace analysis", "run EcoTrace on this project".
---

# EcoTrace Skill

## What EcoTrace Is

EcoTrace is a desktop static-analysis tool that detects **23 Android battery
anti-patterns** across Java and Kotlin source files. For each finding it traces
a **causal chain** backwards through the call graph (up to 6 hops) to identify
the architectural root cause. It then generates a grade (A+ → F) and
concrete fix suggestions.

Most detectors use a **single combined regex** that happens to match both Java and
Kotlin syntax, because the Android API surface they look for is identical in both
languages. Only a handful of detectors that key off *class declaration* syntax add a
separate Kotlin alternative: **W03, W04, W05, N05, A01, A02, A03** (Java `extends Base`
vs Kotlin `: Base()`). Do not assume there are two full regex variants per pattern.

**Stack:** Tauri 2.0 (Rust backend) + TypeScript frontend.  
**Key exports from `src/analyzer/static.ts`:**
- `analyzeProject(files: FileContent[]): Finding[]` — runs all 23 detectors
- `buildCallGraph(files: FileContent[]): CallGraph`
- `traceCallChain(finding: Finding, callGraph: CallGraph, maxHops?: number): ChainNode[]`

---

## When To Use This Skill

Activate this skill when the user says any of:

- "analyze this Android app for battery issues"
- "check battery drain"
- "why is my app draining battery"
- "find energy anti-patterns"
- "EcoTrace analysis"
- "run EcoTrace on this project"
- "what's causing my app's battery drain"
- "battery optimization review"

---

## How EcoTrace Works (for the AI)

### Step 1 — Load the project

Call the Rust `walk_dir` command to enumerate all Java/Kotlin source files:

```typescript
const paths: string[] = await invoke("walk_dir", { root: projectRootPath });
```

Then read each file using the Rust `read_file` command:

```typescript
const files: FileContent[] = await Promise.all(
  paths.map(async (p) => ({
    path: p,
    content: await invoke("read_file", { path: p }),
    language: p.endsWith(".kt") ? "kotlin" : "java",
  }))
);
```

### Step 2 — Analyze

Pass the loaded files to the analyzer. It runs all 23 detectors and returns
findings sorted Critical → High → Medium:

```typescript
import { analyzeProject, buildCallGraph } from "./src/analyzer/static";

const findings: Finding[] = analyzeProject(files);
const callGraph: CallGraph = buildCallGraph(files);
```

Each `Finding` has:
| Field | Type | Description |
|---|---|---|
| `patternId` | `string` | e.g. `"W01"` |
| `patternName` | `string` | Human-readable name |
| `severity` | `"Critical" \| "High" \| "Medium"` | Impact level |
| `category` | `"Wakefulness" \| "Network" \| "Location/Sensors" \| "Lifecycle/Architecture"` | Pattern group |
| `file` | `string` | Absolute path to the file |
| `line` | `number` | 1-based line number |
| `snippet` | `string` | The offending line (trimmed) |
| `description` | `string` | What the problem is |
| `causalChainHint` | `string` | Where to start tracing backwards |

### Step 3 — Trace causal chains

For any Critical or High finding, walk backwards through the call graph:

```typescript
const chain: ChainNode[] = traceCallChain(finding, callGraph);
// maxHops defaults to 6; lifecycle roots (onCreate, onStartCommand, etc.) stop the walk early
```

Each `ChainNode` has `{ file, method, line, role: "root"|"intermediate"|"symptom", description }`.

---

## Pattern Reference (all 23)

### Wakefulness (W)

| ID | Name | Severity | What to look for |
|---|---|---|---|
| W01 | Unclosed WakeLock | Critical | `.acquire()` on a WakeLock with no `.release()`, or release not on a guaranteed path (`finally`, lifecycle pair, scoped API) |
| W02 | WakeLock Across IPC Boundary | Critical | WakeLock `.acquire()` immediately before `startService()`/`sendBroadcast()` |
| W03 | WakeLock in AsyncTask | Critical | `.acquire()` inside a class extending `AsyncTask` |
| W04 | PARTIAL_WAKE_LOCK in Background Service | Critical | `newWakeLock(PARTIAL_WAKE_LOCK)` **acquired** in a non-foreground `Service` |
| W05 | WakeLock in BroadcastReceiver Without goAsync | Critical | `.acquire()` in a `BroadcastReceiver` subclass without `goAsync()` |
| W06 | Nested WakeLock Acquisition | High | The same lock, or one unit of work, `.acquire()`d twice in the same method or via the same receiver |

### Network (N)

| ID | Name | Severity | What to look for |
|---|---|---|---|
| N01 | Network Call in PostDelayed Loop / Inside Loop | Critical | `postDelayed()` self-re-post + network call, or network inside `for`/`while` |
| N02 | No Connection Timeout | High | An HTTP client **constructed** in the file with no `connectTimeout()` (an import or an injected client does not count) |
| N03 | No Read Timeout | High | Connect timeout set but no `readTimeout()` |
| N04 | HTTP Instead of HTTPS | High | `"http://"` URL literal with a real endpoint host — namespaces (`schemas.android.com`, `w3.org`) and localhost excluded |
| N05 | Synchronous Network on Main Thread | Critical | `.newCall(...).execute()` or `getInputStream()` in an Activity/Fragment/View with no `doInBackground()` |
| N06 | Polling Without FCM/WebSocket | High | A repeating scheduler **plus** a real network call in the file, no push channel anywhere in project |

### Location / Sensors (L)

| ID | Name | Severity | What to look for |
|---|---|---|---|
| L01 | GPS Update Interval < 30 Seconds | Critical | `requestLocationUpdates(...)` whose time argument — literal or named constant — resolves under 30 000 ms |
| L02 | FINE Location When COARSE Sufficient | High | A location **request** using `ACCESS_FINE_LOCATION` / `GPS_PROVIDER` / `PRIORITY_HIGH_ACCURACY`; a permission check alone does not count |
| L03 | Listener Not Unregistered in onPause/onStop | Critical | `registerListener()` / `requestLocationUpdates()` with no `unregisterListener()` / `removeUpdates()` anywhere in the file |
| L04 | Full-Rate Accelerometer for Step Counting | High | `TYPE_ACCELEROMETER` + step-counting keyword in the same file |
| L05 | Geofencing via Polling | High | Location polling + distance math, no `GeofencingClient` in project |

### Lifecycle / Architecture (A)

| ID | Name | Severity | What to look for |
|---|---|---|---|
| A01 | Service With No stopSelf() | High | `Service` subclass with `onStartCommand()` and no `stopSelf(...)`/`stopService(...)`; bound services and `IntentService` excluded |
| A02 | Deferrable Work Using Raw Service | High | `Service`/`IntentService` doing sync/upload/backup, no WorkManager in project |
| A03 | JobScheduler Ignored for Background Sync | Medium | `new JobInfo.Builder(...)` never submitted via `schedule()`, **or** a network `Service` with no `JobScheduler`/`WorkManager` constraints |
| A04 | Infinite Animator Not Cancelled in Lifecycle | High | `INFINITE` `ValueAnimator`, no `cancel()` in `onPause`/`onStop` |
| A05 | Heavy Work in onDraw() | Critical | `new Paint()` or `BitmapFactory` inside `onDraw()` method body |
| A06 | AlarmManager WAKEUP for Non-Critical Work | High | `ELAPSED_REALTIME_WAKEUP`, `RTC_WAKEUP`, or `setExactAndAllowWhileIdle()`; `setAlarmClock()` is excluded |

---

## Suppressing a finding

Some findings are correct about the code and still wrong about the verdict: the
WakeLock is released by a lifecycle observer in another file, the sync really is
user-initiated, the client is configured in a DI module the detector cannot see.
The local regex tier has none of that context, so the developer who does is given
the last word — in the source, next to the code:

```java
wakeLock.acquire();               // ecotrace-ignore W01
```

```java
// ecotrace-disable-next-line N02
OkHttpClient c = new OkHttpClient();
```

```java
// ecotrace-ignore-file L02      — FINE is required by the map-matching feature
```

```kotlin
@Suppress("EcoTrace:W01")        // whole file
```

Directives are read from the source as written (comments are stripped before
detectors run, so this is a separate pass), an `ecotrace-ignore` on the line
*above* a finding counts, and a bare `// ecotrace-ignore` suppresses every rule
on that line. Suppression applies after every detector has run.

Also excluded from every scan, with no directive needed: `src/test`,
`src/androidTest`, `*Test.java`/`*Tests.java`/`*Spec.java`, and `generated/` —
test doubles and codegen are real matches and useless findings.

**Precision is enforced, not asserted.** `npm run analyzer:check` runs the demo
corpus and the test fixture through the real analyzer, checks every rule their
READMEs document still fires, checks no undocumented rule fires, checks the
clean files stay silent, and runs 15 known-correct Android patterns plus every
suppression form through it. CI runs it on every push.

---

## How to Interpret Results

### Severity meanings

| Severity | Meaning | Action |
|---|---|---|
| **Critical** | Immediate energy drain; can keep CPU/GPS/radio active continuously | Fix before any release; architectural change required |
| **High** | Significant drain under typical usage conditions | Optimize; track in backlog as P1 |
| **Medium** | Informational; only matters at scale or in edge conditions | Address when refactoring; low urgency |

### Grade scale

| Grade | Score | Meaning |
|---|---|---|
| A+ | ≥ 95 | Excellent; ship it |
| A | 85–94 | Good; minor polish |
| B | 70–84 | Acceptable; some optimizations needed |
| C | 50–69 | Below average; real-world drain expected |
| D | 30–49 | Poor; significant battery issues |
| **F** | < 30 (or ≥ 5 criticals, or drain ≥ 3.0 mAh/min) | **DO NOT SHIP** without fixing all criticals |

**Grade formula:** `score = drainScore × 0.40 + criticalScore × 0.35 + highScore × 0.25`

Hard-fail thresholds: **5+ Critical findings** or **drain rate ≥ 3.0 mAh/min** → automatic F regardless of score.

---

## How to Generate a Fix

### W01 — Unclosed WakeLock
Wrap `acquire()`/`release()` in a `try/finally` block so the lock is always
released even when an exception is thrown.

### W02 — WakeLock Across IPC Boundary
Use `WakefulBroadcastReceiver` (API < 26) or schedule via `WorkManager` which
manages its own `WakeLock` internally across IPC.

### W03 — WakeLock in AsyncTask
Replace the `AsyncTask` with a `lifecycleScope.launch(Dispatchers.IO)` coroutine;
the lifecycle scope is automatically cancelled on Activity destruction.

### W04 — PARTIAL_WAKE_LOCK in Background Service
Replace the `Service` with a `CoroutineWorker` managed by `WorkManager`; WorkManager
holds a `WakeLock` only for the duration of `doWork()`.

### W05 — WakeLock in BroadcastReceiver Without goAsync
Call `goAsync()` immediately in `onReceive()`, hold the `PendingResult`, and
complete work on a background thread before calling `result.finish()`.

### W06 — Nested WakeLock Acquisition
Add a reference-count guard (e.g. `isHeld()` check or a boolean flag) before
each `acquire()` to prevent double-acquisition on the same `WakeLock` instance.

### N01 — Network Call in PostDelayed Loop / Inside Loop
Replace the self-posting `Handler` or loop with a `WorkManager` `PeriodicWorkRequest`;
batch all items before the loop and issue a single network call.

### N02 — No Connection Timeout
Add `.connectTimeout(15, TimeUnit.SECONDS)` (and `.readTimeout(30, TimeUnit.SECONDS)`)
to the `OkHttpClient.Builder` before calling `.build()`.

### N03 — No Read Timeout
Add `.readTimeout(30, TimeUnit.SECONDS)` to the same `OkHttpClient.Builder` that
already has `connectTimeout`.

### N04 — HTTP Instead of HTTPS
Change the URL scheme from `http://` to `https://`; update the server if needed.
If cleartext is required for a specific host, declare it explicitly in `network_security_config.xml`.

### N05 — Synchronous Network on Main Thread
Move the HTTP call to `lifecycleScope.launch(Dispatchers.IO) { ... }` or convert
the synchronous `.execute()` to an async `.enqueue()` callback.

### N06 — Polling Without FCM/WebSocket
Replace the polling scheduler with Firebase Cloud Messaging for server-initiated
updates; use `WorkManager` with network constraints only for genuinely periodic
background sync that does not need real-time delivery.

### L01 — GPS Update Interval < 30 Seconds
Increase the `minTimeMs` parameter to at least `30_000` (30 s); use
`LocationRequest.Builder.setIntervalMillis(30_000)` on modern APIs.

### L02 — FINE Location When COARSE Sufficient
Request `ACCESS_COARSE_LOCATION` and use `PRIORITY_BALANCED_POWER_ACCURACY` in the
`LocationRequest`; only escalate to FINE if the feature genuinely needs sub-10 m precision.

### L03 — Sensor Not Unregistered in onPause/onStop
Call `sensorManager.unregisterListener(listener)` in `onPause()` (Activity) or
`onDestroyView()` (Fragment) to stop sensor delivery when backgrounded.

### L04 — Full-Rate Accelerometer for Step Counting
Replace `TYPE_ACCELEROMETER` with `TYPE_STEP_COUNTER`; the dedicated hardware
sensor runs at a fraction of the power and delivers pre-counted steps.

### L05 — Geofencing via Polling
Replace the manual distance loop with the `GeofencingClient` API
(`LocationServices.getGeofencingClient(context)`), which uses hardware-optimized
boundary detection with no continuous polling.

### A01 — Service With No stopSelf()
Call `stopSelf()` after work completes in `onStartCommand()`, or return
`START_NOT_STICKY` and let the caller manage the lifecycle.

### A02 — Deferrable Work Using Raw Service
Replace with a `CoroutineWorker` submitted via `WorkManager.enqueueUniqueWork()`;
add `setRequiredNetworkType(NetworkType.CONNECTED)` constraint.

### A03 — JobScheduler Ignored for Background Sync
Add a `WorkRequest` with `.setConstraints(Constraints.Builder().setRequiredNetworkType(UNMETERED).setRequiresCharging(true).build())`
so sync only runs on Wi-Fi and while charging.

### A04 — Infinite Animator Not Cancelled in Lifecycle
Store the `ValueAnimator` reference in a field and call `animator.cancel()` in
`onPause()` (Activity) or `onDestroyView()` (Fragment).

### A05 — Heavy Work in onDraw()
Move all `Paint` construction and `Bitmap` decoding to `init { }` or
`onSizeChanged()`; pass pre-allocated objects into `onDraw()` as fields.

### A06 — AlarmManager WAKEUP for Non-Critical Work
Replace with `WorkManager` periodic work; only keep a wakeup alarm for
genuinely time-critical alarms (e.g. calendar reminders, medication alerts).

---

## Causal Chain Format

When reporting a finding with a traced chain, use this format in the
Intelligence Feed:

```
🔴 CRITICAL CHAIN: [PatternID] [PatternName]
Root Cause:    ClassName.method() [file:line]
               └─ why this is the architectural root cause

Propagates to: ClassName.method() [file:line]
               └─ what this intermediate step does wrong

Symptom:       ClassName.method() [file:line]
               └─ the actual energy drain that the user observes
```

Rules:
- Use `🔴 CRITICAL CHAIN` for Critical severity, `🟠 HIGH CHAIN` for High.
- `Root Cause` = the `ChainNode` with `role: "root"` (lifecycle entry point).
- `Propagates to` = zero or more `ChainNode` items with `role: "intermediate"`.
- `Symptom` = the `ChainNode` with `role: "symptom"` (the finding site).
- Each `└─` line is 1–2 sentences explaining that node's contribution.

---

## Example Session

**User:** "Run EcoTrace on my project at `/home/user/MyApp`"

**Bob:**

### Step 1 — Load project
```
walk_dir("/home/user/MyApp") → 47 Java/Kotlin files found
```

### Step 2 — Analyze
```
analyzeProject(files) → 12 findings
  Critical × 4  (W01, W04, L01, L03)
  High     × 6  (N02, A01, A06, L02, N06, W06)
  Medium   × 2  (A03, A03)

Grade: D (score 38) — multiple criticals, no drain data
```

### Step 3 — Trace W01 (Unclosed WakeLock in SyncService.java)
```
traceCallChain(w01Finding, callGraph) →
  ChainNode { role: "root",         method: "onCreate",         file: "MainActivity.java",  line: 18 }
  ChainNode { role: "intermediate", method: "onStartCommand",   file: "SyncService.java",   line: 22 }
  ChainNode { role: "symptom",      method: "acquire",          file: "SyncService.java",   line: 28 }
```

### Intelligence Feed output

```
🔴 CRITICAL CHAIN: W01 Unclosed WakeLock
Root Cause:    MainActivity.onCreate() [MainActivity.java:18]
               └─ Schedules SyncService via AlarmManager every 15 min.
                  This is the architectural decision that starts the drain chain.

Propagates to: SyncService.onStartCommand() [SyncService.java:22]
               └─ Acquires PARTIAL_WAKE_LOCK to keep CPU alive during sync,
                  but the try/catch block has no finally clause.

Symptom:       WakeLockManager.acquire() [SyncService.java:28]
               └─ WakeLock is never released on the error path — CPU stays
                  awake indefinitely after a failed sync attempt.
```

### Suggested fix
```java
// SyncService.java — wrap acquire/release in try/finally
wakeLock.acquire(10 * 60 * 1000L); // 10-min timeout as safety net
try {
    client.newCall(request).execute();
} finally {
    if (wakeLock.isHeld()) wakeLock.release();
}
```

> **Architectural recommendation:** Replace `SyncService` + `AlarmManager`
> with a `WorkManager` `PeriodicWorkRequest`. WorkManager manages its own
> internal WakeLock correctly and respects Doze mode, eliminating both W01
> and A06 in one refactor.
