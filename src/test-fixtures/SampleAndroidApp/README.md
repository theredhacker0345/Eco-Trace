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
exactly these findings — no more, no fewer. `npm run analyzer:check` asserts
both directions: every row below must fire, and nothing outside it may.

| ID | Severity | Pattern Name | File | Notes |
|---|---|---|---|---|
| W01 | Critical | Unclosed WakeLock | `SyncService.java` | `acquire()` present; `release()` not in a `finally` block |
| W04 | Critical | PARTIAL_WAKE_LOCK in Background Service | `SyncService.java` | `PARTIAL_WAKE_LOCK` acquired inside a `Service` subclass |
| L01 | Critical | GPS Update Interval < 30 Seconds | `LocationTracker.java` | `5000` ms interval (< 30 000 ms threshold) |
| L03 | Critical | Listener Not Unregistered in onPause/onStop | `LocationTracker.java` | location and sensor registrations with no teardown in file |
| N02 | High | No Connection Timeout | `SyncService.java` | `OkHttpClient` constructed with no `connectTimeout()` |
| A01 | High | Service With No stopSelf() | `SyncService.java` | `onStartCommand()` returns `START_STICKY` with no `stopSelf(...)` |
| A06 | High | AlarmManager WAKEUP for Non-Critical Work | `MainActivity.java` | `RTC_WAKEUP` alarm for periodic sync |
| L02 | High | FINE Location When COARSE Sufficient | `LocationTracker.java` | `GPS_PROVIDER` requested with no power priority |
| L04 | High | Full-Rate Accelerometer for Step Counting | `LocationTracker.java` | `TYPE_ACCELEROMETER` + "step" keyword |
| A02 | High | Deferrable Work Using Raw Service | `SyncService.java` | sync work in a raw `Service`, no WorkManager in project |
| A03 | Medium | JobScheduler Ignored for Background Sync | `SyncService.java` | network `Service` with no scheduling constraints |

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

Expected: **11 findings** (4 Critical, 6 High, 1 Medium), grade **F**.
