# SampleAndroidApp — EcoTrace Test Fixture

This is a **minimal synthetic Android project** with intentionally planted
energy anti-patterns. It exists solely to validate that EcoTrace's 23 detectors
produce the expected findings on known-bad code.

> **Do not use this code in production.** Every Java file here contains
> deliberate bugs that would cause real battery drain.

---

## Files

| File | Purpose |
|---|---|
| `MainActivity.java` | Entry point; plants **A06** (AlarmManager WAKEUP) |
| `SyncService.java` | Background service; plants **W01**, **W04**, **N02**, **A01** |
| `LocationTracker.java` | Location/sensor helper; plants **L01**, **L03**, **L04** |

---

## Expected EcoTrace Findings

When you run `analyzeProject()` on this fixture the analyzer should report
exactly these findings (sorted Critical → High):

| ID | Severity | Pattern Name | File | Notes |
|---|---|---|---|---|
| W01 | Critical | Unclosed WakeLock | `SyncService.java` | `acquire()` present; `release()` not in a `finally` block |
| W04 | Critical | PARTIAL_WAKE_LOCK in Background Service | `SyncService.java` | `PARTIAL_WAKE_LOCK` inside a `Service` subclass |
| L01 | Critical | GPS Update Interval < 30 Seconds | `LocationTracker.java` | `5000` ms interval (< 30 000 ms threshold) |
| L03 | Critical | Sensor Not Unregistered in onPause/onStop | `LocationTracker.java` | `registerListener()` with no `unregisterListener()` in file |
| N02 | High | No Connection Timeout | `SyncService.java` | `OkHttpClient` with no `connectTimeout()` |
| A01 | High | Service With No stopSelf() | `SyncService.java` | `onStartCommand()` returns `START_STICKY` with no `stopSelf()` |
| A06 | High | AlarmManager WAKEUP for Non-Critical Work | `MainActivity.java` | `RTC_WAKEUP` alarm for periodic sync |
| L04 | High | Full-Rate Accelerometer for Step Counting | `LocationTracker.java` | `TYPE_ACCELEROMETER` + "step" keyword |

> **Note on N06 (Polling Without FCM/WebSocket):** The analyzer may also flag
> this because `MainActivity.java` uses `AlarmManager` + `SyncService` contains
> `OkHttpClient`, and no FCM/WebSocket is present in the project.

---

## How to Run Against This Fixture

```typescript
import { analyzeProject, buildCallGraph } from "../../analyzer/static";
import { invoke } from "@tauri-apps/api/core";

const root = "/path/to/SampleAndroidApp";
const paths: string[] = await invoke("walk_dir", { root });
const files = await Promise.all(
  paths.map(async (p) => ({
    path: p,
    content: await invoke("read_file", { path: p }),
    language: p.endsWith(".kt") ? "kotlin" : "java" as const,
  }))
);

const findings = analyzeProject(files);
const callGraph = buildCallGraph(files);
console.log(`Found ${findings.length} findings`);
```

Expected: **8 findings minimum** (4 Critical, 4 High), grade **F**.
