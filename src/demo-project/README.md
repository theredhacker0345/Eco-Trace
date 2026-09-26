# AutoTrack — EcoTrace rule test corpus

This is not a real application. It is a **rule test corpus**: a deliberately
constructed Android-shaped project used to verify that EcoTrace's 23 detectors
fire when they should, stay quiet when they should, and that the causal chain
tracer reaches a lifecycle entry point.

It is served in the hosted demo in place of a real project, because a hosted
build has no folder picker and no way to read a developer's disk. The point of
the demo is that the analysis is genuine: the same detectors, the same call
graph, the same grader and the same report that run against a real repository.
Only the input is fixed.

## What is planted

Seventeen sources: ten carrying known defects, seven deliberately clean.

| File | Planted | Rule |
|---|---|---|
| `MainActivity.java` | `RTC_WAKEUP` repeating alarm on every cold start | A06 |
| `SyncScheduler.java` | `JobScheduler` constraints written and never submitted | A03 |
| `SyncService.java` | `PARTIAL_WAKE_LOCK` in a Service; `START_STICKY`, no `stopSelf()` | W04, A01 |
| `SyncEngine.java` | self-reposting `postDelayed` loop, no backoff, no exit | N01 |
| `NetworkManager.java` | `acquire()` with `release()` only on the success path; no connect or read timeout | W01, N02 |
| `LocationTracker.java` | GPS at 5 s; FINE location; listener never removed | L01, L02, L03 |
| `UploadService.java` | nested wake locks; polling retry loop | W06, N06 |
| `SensorBridge.kt` | partial wake lock in a never-cancelled coroutine scope | W04, N01 |

`UploadQueue`, `AppConfig`, `UserProfile`, `SessionStore`, `BatteryAware`,
`Diagnostics`, `LocationSharingPreferences` and `Analytics` contain no
anti-patterns. They are here because roughly half of any real codebase is
ordinary code, and a corpus where every file is broken demonstrates nothing
about precision. They are what the report's coverage matrix renders as an
explicit zero — "checked and clean" is a result.

## The headline chain

The corpus is arranged so the deepest finding sits four hops from a lifecycle
entry point, across four files:

```
MainActivity.onCreate()        RTC_WAKEUP alarm, no backoff, 96 triggers/day
  -> SyncScheduler.scheduleImmediate()
    -> SyncService.onStartCommand()          lifecycle root
      -> SyncEngine.startSyncCycle()
        -> UserRepository.syncUserProfile()
          -> NetworkManager.fetchUserProfile()   W01: WakeLock leaked on error
```

A single-file analyser can only report the last line. The WakeLock leak is a
symptom; the alarm that re-arms the chain 96 times a day is the cause, and it is
three files and four hops upstream.

## Using it as a regression test

`analyzeProject()` over this directory should produce a finding for every row in
the table above, and nothing at all for the eight clean files. If a detector
changes behaviour, this corpus is where it shows up:

```bash
npm run build          # bundles the analyzer to dist/assets/static-*.js
```

The corpus is bundled into the hosted build via `?raw` imports in
`src/ui/demo.ts`, which Vite inlines at build time. It is never present in the
desktop build's critical path: the module is behind a dynamic import guarded by
a runtime shell check, so it lands in its own lazily-loaded chunk.
