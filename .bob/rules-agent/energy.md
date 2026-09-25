# EcoTrace — Bob's Energy Detection Rules

## Purpose

This file is Bob's authoritative reference for detecting Android energy anti-patterns during static analysis. When analyzing an Android project, Bob reads this file first, then applies each pattern's detection signals to every `.java` and `.kt` file in the repository simultaneously.

**This is not a linter spec.** This is a reasoning guide. Regex signals indicate where to look; Bob's judgment determines whether the code is actually problematic given its architectural context.

---

## Severity Definitions

| Severity | Meaning | Grade Impact |
|---|---|---|
| **Critical** | Causes measurable, continuous battery drain. Device stays awake when it should sleep. | Counts toward the 35% critical weight; 5+ = F grade |
| **High** | Significant inefficiency. Wastes CPU cycles, network bandwidth, or sensor time. | Counts toward 25% high weight |
| **Medium** | Suboptimal pattern. Low immediate drain but compounds in scale. | Informational; no grade impact |

---

## Causal Chain Tracing Protocol

For every **Critical** finding, Bob traces the call graph backwards from the finding's file and method to find the **architectural root cause** — the decision point where a developer made a choice that propagated downstream to cause the drain.

**Tracing process:**
1. Identify the method containing the finding (the "symptom site")
2. Find all call sites that invoke this method across the entire codebase
3. Walk each call site's containing method upward (who calls that?)
4. Continue until reaching a lifecycle entry point: `onCreate`, `onStartCommand`, `onReceive`, `onBind`, `Application.onCreate`, or a constructor
5. Record the full chain: `[root] → [caller] → ... → [symptom site]`
6. Identify which node in the chain is the true root cause (usually the earliest architectural decision — e.g., using `AlarmManager` instead of `WorkManager`)
7. Generate a fix that addresses the root cause, not just the symptom

**Chain format for the Intelligence Feed:**
```
🔴 CRITICAL CHAIN: [PatternID] [PatternName]
Root Cause:    ClassName.methodName() [file:line]
               └─ [why this is the root decision]
Propagates to: ClassName.methodName() [file:line]
               └─ [what this does wrong]
...
Symptom:       ClassName.methodName() [file:line]
               └─ [the actual energy drain here]
```

---

## Category 1 — Wakefulness Violations

### W01 — Unclosed WakeLock

**Severity:** Critical  
**Description:** A WakeLock is acquired but `release()` is never called on all code paths — including error paths, early returns, and exception handlers. The device CPU stays awake indefinitely after the screen turns off.

**Detection Signals — Java:**
```
PowerManager.WakeLock.*acquire()           ← acquisition
.release()                                  ← look for this in same method/class
```
Look for: `acquire(` with no paired `release(` in any reachable code path. Check `try/catch/finally` blocks — `release()` in `finally` is correct; `release()` only in `try` is a bug.

**Detection Signals — Kotlin:**
```kotlin
wakeLock.acquire()
wakeLock.acquire(timeout)   // timeout form is safer — flag if > 10 minutes
// Missing: wakeLock.release() or use.withWakeLock { }
```

**Causal Chain Hook:** Trace from `acquire()` upward. Root cause is usually the method that decides *when* to hold the wakelock (often a Service or BroadcastReceiver).

**Fix Template:**
```kotlin
// Wrap in try/finally always
try {
    wakeLock.acquire(10 * 60 * 1000L) // 10-minute max
    doWork()
} finally {
    if (wakeLock.isHeld) wakeLock.release()
}
```

---

### W02 — WakeLock Held Across IPC Boundary

**Severity:** Critical  
**Description:** A WakeLock is acquired before an IPC call (AIDL, `startService`, `bindService`, `sendBroadcast`) and released only after the IPC returns — or worse, released in a callback that may never fire. IPC calls can block indefinitely.

**Detection Signals — Java:**
```java
wakeLock.acquire()
// followed within same method by any of:
context.startService(...)
context.bindService(...)
context.sendBroadcast(...)
aidlInterface.someMethod(...)
```

**Detection Signals — Kotlin:**
```kotlin
wakeLock.acquire()
// followed by:
startService(intent)
bindService(intent, connection, flags)
sendBroadcast(intent)
```

**Causal Chain Hook:** Find the Service or BroadcastReceiver being started. Trace whether it ever completes reliably.

---

### W03 — WakeLock in AsyncTask

**Severity:** Critical  
**Description:** WakeLock acquired inside an `AsyncTask` — which is not lifecycle-aware. When the Activity is rotated or destroyed, the AsyncTask orphans with the WakeLock held.

**Detection Signals — Java:**
```java
class SomeTask extends AsyncTask<...> {
    // Any acquire() call inside doInBackground or onPreExecute
    wakeLock.acquire()
}
```

**Detection Signals — Kotlin:**
```kotlin
// AsyncTask subclass (rare in modern Kotlin but still found in legacy code)
class SomeTask : AsyncTask<Void, Void, Void>() {
    // wakeLock.acquire() anywhere in overridden methods
}
```

**Causal Chain Hook:** Root cause is the Activity/Fragment that creates and executes the AsyncTask. Fix: replace with `CoroutineScope(lifecycleOwner.lifecycleScope)`.

---

### W04 — PARTIAL_WAKE_LOCK in Background Service

**Severity:** Critical  
**Description:** A `PARTIAL_WAKE_LOCK` is used inside a Service — especially one started with `startService()`. Unlike `WorkManager`, Services have no built-in job scheduling or wake constraint handling.

**Detection Signals — Java:**
```java
PowerManager.PARTIAL_WAKE_LOCK
// inside a class that extends Service
```

**Detection Signals — Kotlin:**
```kotlin
PowerManager.PARTIAL_WAKE_LOCK
// inside a class : Service()
```

**Causal Chain Hook:** Find the caller of `startService()` or `startForeground()`. Root cause is the architectural choice of Service over WorkManager.

**Fix Template:** Replace with `WorkManager` — it handles partial wakes internally via `WakefulBroadcastReceiver` equivalent.

---

### W05 — WakeLock in BroadcastReceiver Without goAsync()

**Severity:** Critical  
**Description:** A WakeLock is acquired in `BroadcastReceiver.onReceive()` but `goAsync()` is not called. `onReceive()` returns immediately — the system may reclaim the process before `release()` is called, OR the WakeLock outlives the receiver window.

**Detection Signals — Java:**
```java
class SomeReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        // wakeLock.acquire() present
        // no goAsync() call
    }
}
```

**Detection Signals — Kotlin:**
```kotlin
class SomeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // wakeLock.acquire() + no goAsync()
    }
}
```

**Causal Chain Hook:** Root cause is the decision to do heavy work in a BroadcastReceiver rather than delegating to a WorkManager task.

---

### W06 — Nested WakeLock Acquisition

**Severity:** High  
**Description:** `acquire()` is called on the same WakeLock instance in two different code paths that can execute concurrently (e.g., two threads, or re-entrant method calls). The reference count increases but `release()` only decrements once — lock never fully released.

**Detection Signals — Java:**
```java
// Two acquire() calls on same WakeLock field in same class
// without corresponding paired release() calls
mWakeLock.acquire()
// ... later in same class ...
mWakeLock.acquire()  ← second call
```

**Detection Signals — Kotlin:**
```kotlin
wakeLock.acquire()
// in another method of same class:
wakeLock.acquire()  // same instance, no isHeld check
```

**Causal Chain Hook:** Find all callers of both methods. Is there a code path where both are invoked sequentially?

---

## Category 2 — Network Inefficiency

### N01 — Network Call Inside Loop or PostDelayed Chain

**Severity:** Critical  
**Description:** A network request is made inside a `for`/`while`/`do-while` loop, or inside a `Handler.postDelayed()` that re-posts itself — creating unbounded repeated network calls that keep the radio awake continuously.

**Detection Signals — Java:**
```java
for (...) {
    // HttpURLConnection, OkHttp, Retrofit call inside loop
    client.newCall(request).execute()
    // or: connection.getInputStream()
}
// or:
handler.postDelayed(new Runnable() {
    public void run() {
        fetchData();
        handler.postDelayed(this, interval); // ← self-re-posting
    }
}, interval);
```

**Detection Signals — Kotlin:**
```kotlin
for (item in list) {
    client.newCall(request).execute()
}
// or:
handler.postDelayed({
    fetchData()
    handler.postDelayed(this, interval) // self-re-posting
}, interval)
```

**Causal Chain Hook:** Find what triggers the loop. Root cause is often an Activity.onCreate or a Service that starts the polling chain.

**Fix Template:** Batch requests outside loop; replace self-posting Handler with `WorkManager` periodic work.

---

### N02 — No Connection Timeout

**Severity:** High  
**Description:** An HTTP client is created without setting a connection timeout. On slow or absent networks, the calling thread blocks indefinitely, holding the radio in an active state.

**Detection Signals — Java:**
```java
OkHttpClient client = new OkHttpClient();             // ← no builder with connectTimeout
// or:
new OkHttpClient.Builder().build()                    // ← builder used but no .connectTimeout()
// or:
HttpURLConnection conn = (HttpURLConnection) url.openConnection();
// no conn.setConnectTimeout(...)
```

**Detection Signals — Kotlin:**
```kotlin
val client = OkHttpClient()                           // no timeout
val client = OkHttpClient.Builder().build()           // builder, no connectTimeout
val conn = url.openConnection() as HttpURLConnection  // no setConnectTimeout
```

**Causal Chain Hook:** Find where this client is instantiated and passed/used. Is it a singleton that all network calls share?

**Fix Template:**
```kotlin
val client = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .writeTimeout(15, TimeUnit.SECONDS)
    .build()
```

---

### N03 — No Read Timeout

**Severity:** High  
**Description:** Connection timeout is set but read timeout is not — or neither is set. A server that accepts the connection but sends data slowly holds the radio and the calling thread open.

**Detection Signals — Java:**
```java
.connectTimeout(...)    // present
// but no .readTimeout(...)
```
Also flag: `HttpURLConnection` with `setConnectTimeout` but no `setReadTimeout`.

**Detection Signals — Kotlin:**
```kotlin
OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS)
    // missing: .readTimeout(...)
```

---

### N04 — HTTP Instead of HTTPS

**Severity:** High  
**Description:** Plaintext HTTP URLs are used. Beyond security, HTTP on Android 9+ is blocked by default network security config — but on older targets it forces TLS renegotiation overhead or causes cleartext failures that trigger retries, wasting radio time.

**Detection Signals — Java + Kotlin:**
```
"http://"   ← in string literals assigned to URL variables or passed to network calls
```
Exclude: `"http://localhost"`, `"http://127.0.0.1"`, `"http://10.0.2.2"` (emulator addresses — not real drain).

**Causal Chain Hook:** Find where the URL is defined. Is it a constant? A config file? Trace to the network call site.

---

### N05 — Synchronous Network on Main Thread

**Severity:** Critical  
**Description:** A network call is made on the main (UI) thread — causes `NetworkOnMainThreadException` on API 11+ and, before that, freezes the UI and holds the radio in the highest-power state while the main thread is blocked.

**Detection Signals — Java:**
```java
// execute() (not enqueue()) called in an Activity/Fragment method
call.execute()
connection.getInputStream()  // in onCreate, onResume, onClick, etc.
```

**Detection Signals — Kotlin:**
```kotlin
// .execute() in a non-coroutine context in an Activity/Fragment
response = client.newCall(request).execute()   // in main-thread callback
```

**Causal Chain Hook:** Root cause is always the Activity/Fragment method where this is called. Fix: move to `Dispatchers.IO` coroutine or `enqueue()` async callback.

---

### N06 — Polling Pattern Without FCM or WebSocket

**Severity:** High  
**Description:** The app implements a polling loop (repeated HTTP calls to check for updates) when it could use push notifications (FCM) or a persistent connection (WebSocket). Polling keeps the radio in active mode on every poll cycle.

**Detection Signals — Java + Kotlin:**
- Combination of: a repeating `AlarmManager`, `Handler.postDelayed` self-chain, or `ScheduledExecutorService`, AND a network call inside the triggered method
- No `FirebaseMessaging`, `WebSocket`, or `SSEClient` import anywhere in the codebase

**Causal Chain Hook:** Find the scheduling entry point. Is this triggered from `Application.onCreate` or a Service?

---

## Category 3 — Location & Sensor Abuse

### L01 — GPS Update Interval < 30 Seconds

**Severity:** Critical  
**Description:** `requestLocationUpdates()` is called with a `minTime` interval below 30,000ms (30 seconds). GPS at high frequency is one of the single largest battery consumers on a mobile device.

**Detection Signals — Java:**
```java
locationManager.requestLocationUpdates(
    LocationManager.GPS_PROVIDER,
    interval,     // ← numeric literal or variable < 30000
    distance,
    listener
);
// or FusedLocationProviderClient:
LocationRequest.create().setInterval(interval)  // interval < 30000
```

**Detection Signals — Kotlin:**
```kotlin
locationManager.requestLocationUpdates(GPS_PROVIDER, interval, 0f, listener)
// interval < 30000

LocationRequest.create().apply {
    interval = 5000L  // ← Critical if < 30000
}
```

**Causal Chain Hook:** Find where the `LocationRequest` or interval value is defined. Is it a constant? A user setting? Trace to the entry point that starts location tracking.

---

### L02 — FINE Location When COARSE Is Sufficient

**Severity:** High  
**Description:** `ACCESS_FINE_LOCATION` permission and `GPS_PROVIDER` or `PRIORITY_HIGH_ACCURACY` are used where the feature only needs city-level or network-level location (`ACCESS_COARSE_LOCATION`).

**Detection Signals — Java + Kotlin:**
```java
// AndroidManifest.xml:
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>

// In code:
LocationManager.GPS_PROVIDER
// or:
LocationRequest.PRIORITY_HIGH_ACCURACY
```
Cross-reference: does the feature using this location need sub-10-meter accuracy? If it's showing nearby restaurants, weather, or city-level content — flag as L02.

**Causal Chain Hook:** Find the feature that consumes the location result. Is precision actually needed?

---

### L03 — Sensor Listener Not Unregistered in onPause or onStop

**Severity:** Critical  
**Description:** A sensor listener is registered in `onResume` or `onCreate` but never unregistered in `onPause` or `onStop`. The sensor hardware remains active when the app is backgrounded, continuously consuming power.

**Detection Signals — Java:**
```java
sensorManager.registerListener(listener, sensor, rate);  // in onResume or onCreate
// Missing in onPause/onStop:
sensorManager.unregisterListener(listener);
```

**Detection Signals — Kotlin:**
```kotlin
sensorManager.registerListener(listener, sensor, rate)
// no sensorManager.unregisterListener(listener) in onPause/onStop
```

**Causal Chain Hook:** Find the Activity or Fragment's lifecycle methods. Root cause is the registration in `onResume` without a matching `onPause` deregistration.

---

### L04 — Full-Rate Accelerometer for Step Counting

**Severity:** High  
**Description:** `TYPE_ACCELEROMETER` at `SENSOR_DELAY_NORMAL` or faster is used to implement step counting, when Android provides a dedicated `TYPE_STEP_COUNTER` or `TYPE_STEP_DETECTOR` sensor that uses dedicated low-power hardware.

**Detection Signals — Java + Kotlin:**
```java
Sensor.TYPE_ACCELEROMETER
// in a class that contains step-counting logic keywords:
// "step", "pedometer", "walk", "pace", "stride"
```
The keyword proximity test is important — accelerometer for other purposes (shake detection, rotation) is not this pattern.

**Causal Chain Hook:** Find the feature intent. Is this a fitness app or step-tracking feature? Root cause is choosing TYPE_ACCELEROMETER over TYPE_STEP_COUNTER.

---

### L05 — Geofencing via Polling Instead of Geofence API

**Severity:** High  
**Description:** The app checks the user's location on a timer to detect geographic boundaries, instead of using Android's `GeofencingClient` which uses hardware-optimized boundary detection with minimal wake events.

**Detection Signals — Java + Kotlin:**
- Repeating location requests (alarm + network/location call) AND
- Distance calculation logic: `distanceTo()`, `Location.distanceBetween()`, or manual Haversine formula
- No `GeofencingClient` or `Geofence.Builder` import

**Causal Chain Hook:** Find the entry point for the repeating location check. Was GeofencingClient available at the time this was written (API 17+)?

---

## Category 4 — Lifecycle & Architecture

### A01 — Service With No stopSelf() Call

**Severity:** High  
**Description:** A `Service` (non-foreground, non-bound) starts and performs work but never calls `stopSelf()` or `stopService()`. The Service stays running indefinitely, preventing the OS from reclaiming its process.

**Detection Signals — Java:**
```java
class SomeService extends Service {
    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // ... work ...
        return START_STICKY;  // or any return
        // no stopSelf() or stopSelf(startId) anywhere in class
    }
}
```

**Detection Signals — Kotlin:**
```kotlin
class SomeService : Service() {
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // no stopSelf() in class
        return START_STICKY
    }
}
```

**Causal Chain Hook:** Find what starts this Service (`startService()` calls). Is it triggered repeatedly? Root cause is the caller not using `bindService` (which auto-stops) or `WorkManager`.

---

### A02 — Deferrable Work Using Raw Service Instead of WorkManager

**Severity:** High  
**Description:** Work that doesn't need to run immediately (sync, upload, backup, analytics flush) is implemented as a raw Service instead of a `WorkManager` task. WorkManager handles battery constraints, Doze mode, and job coalescing automatically.

**Detection Signals — Java + Kotlin:**
- Class extends `Service` or `IntentService`
- Work keyword in class name or comments: "sync", "upload", "backup", "analytics", "report", "flush"
- No `WorkManager`, `Worker`, or `CoroutineWorker` class anywhere in the project

**Causal Chain Hook:** Find what triggers `startService()`. Is it on a schedule (alarm/timer) or on a user action? Deferrable scheduled work = WorkManager. Immediate user-triggered work = foreground service.

---

### A03 — JobScheduler Ignored for Background Sync

**Severity:** Medium  
**Description:** Background sync that would benefit from constraint-based scheduling (only on WiFi, only charging) is implemented without `JobScheduler` or `WorkManager` constraints. The work runs even on metered connections or while on battery.

**Detection Signals — Java + Kotlin:**
- Network operations in a Service or BroadcastReceiver triggered by AlarmManager
- No `JobScheduler.schedule()` or `WorkManager` constraints (`setRequiredNetworkType`, `setRequiresCharging`)

**Causal Chain Hook:** What triggers the sync? Is there a WiFi/charging check before the sync starts? If not, every trigger fires regardless of device state.

---

### A04 — Infinite ValueAnimator Not Cancelled in Lifecycle

**Severity:** High  
**Description:** A `ValueAnimator` or `ObjectAnimator` with `setRepeatCount(INFINITE)` is started but never cancelled in `onPause()`, `onStop()`, or `onDestroyView()`. Infinite animations force the GPU to redraw continuously even when the app is backgrounded.

**Detection Signals — Java:**
```java
animator.setRepeatCount(ValueAnimator.INFINITE)
// or:
animator.setRepeatCount(-1)
// without animator.cancel() or animator.end() in onPause/onStop
```

**Detection Signals — Kotlin:**
```kotlin
animator.repeatCount = ValueAnimator.INFINITE
// or: = -1
// no .cancel() in onPause/onStop
```

**Causal Chain Hook:** Find the Activity or Fragment. Is `onPause()` defined? Does it cancel the animator?

---

### A05 — Heavy Computation in onDraw()

**Severity:** Critical  
**Description:** `onDraw()` performs object allocation, I/O, complex calculation, or calls methods that do so. `onDraw()` is called every frame — on high-refresh devices, up to 120 times per second. Heavy work here forces continuous CPU + GPU load.

**Detection Signals — Java:**
```java
@Override
protected void onDraw(Canvas canvas) {
    // Any of:
    new Paint()            // allocation in draw loop
    BitmapFactory.decode...  // I/O in draw
    getString(...)         // resource access
    // loops with many iterations
    for (int i = 0; i < largeCount; i++) { ... }
}
```

**Detection Signals — Kotlin:**
```kotlin
override fun onDraw(canvas: Canvas) {
    Paint()               // allocation
    BitmapFactory.decode... // I/O
    for (item in largeList) { ... }
}
```

**Causal Chain Hook:** Find who calls `invalidate()` — continuous calls to `invalidate()` compound the problem. Is it a recursive `postInvalidate`?

**Fix Template:** Pre-allocate all `Paint` objects as class fields. Move computation to `onSizeChanged()`. Use `invalidate(Rect)` with dirty region instead of full invalidate.

---

### A06 — AlarmManager ELAPSED_REALTIME_WAKEUP for Non-Critical Work

**Severity:** High  
**Description:** `AlarmManager.ELAPSED_REALTIME_WAKEUP` or `RTC_WAKEUP` is used for work that is not time-critical (sync, cleanup, analytics). Wakeup alarms force the device out of Doze mode. Android 6+ Doze intentionally batches these — using `setExact()` or `setRepeating()` with a wakeup type defeats Doze.

**Detection Signals — Java:**
```java
alarmManager.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, ...)
alarmManager.setRepeating(AlarmManager.RTC_WAKEUP, ...)
alarmManager.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, ...)
alarmManager.setExactAndAllowWhileIdle(...)
```

**Detection Signals — Kotlin:**
```kotlin
alarmManager.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, ...)
alarmManager.setRepeating(AlarmManager.RTC_WAKEUP, ...)
alarmManager.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, ...)
```

**Causal Chain Hook:** What work is triggered by this alarm? Trace to the PendingIntent's target. If the target Service/BroadcastReceiver does anything deferrable, the root cause is using a wakeup alarm instead of `WorkManager` with appropriate constraints.

**Fix Template:** Replace with `WorkManager` periodic work with `setRequiredNetworkType(NetworkType.CONNECTED)` constraint. For truly time-sensitive work (calendar alarms, medication reminders), wakeup alarms are acceptable — flag only when the triggered work is deferrable.

---

## Pattern Reference Index

| ID | Pattern Name | Category | Severity |
|---|---|---|---|
| W01 | Unclosed WakeLock | Wakefulness | Critical |
| W02 | WakeLock Across IPC Boundary | Wakefulness | Critical |
| W03 | WakeLock in AsyncTask | Wakefulness | Critical |
| W04 | PARTIAL_WAKE_LOCK in Background Service | Wakefulness | Critical |
| W05 | WakeLock in BroadcastReceiver Without goAsync | Wakefulness | Critical |
| W06 | Nested WakeLock Acquisition | Wakefulness | High |
| N01 | Network Call in Loop/PostDelayed Chain | Network | Critical |
| N02 | No Connection Timeout | Network | High |
| N03 | No Read Timeout | Network | High |
| N04 | HTTP Instead of HTTPS | Network | High |
| N05 | Synchronous Network on Main Thread | Network | Critical |
| N06 | Polling Without FCM/WebSocket | Network | High |
| L01 | GPS Interval < 30 Seconds | Location/Sensors | Critical |
| L02 | FINE Location When COARSE Sufficient | Location/Sensors | High |
| L03 | Sensor Not Unregistered in onPause | Location/Sensors | Critical |
| L04 | Full-Rate Accelerometer for Step Counting | Location/Sensors | High |
| L05 | Geofencing via Polling | Location/Sensors | High |
| A01 | Service No stopSelf | Lifecycle/Architecture | High |
| A02 | Deferrable Work in Raw Service | Lifecycle/Architecture | High |
| A03 | JobScheduler Ignored for Background Sync | Lifecycle/Architecture | Medium |
| A04 | Infinite Animator Not Cancelled | Lifecycle/Architecture | High |
| A05 | Heavy Work in onDraw | Lifecycle/Architecture | Critical |
| A06 | AlarmManager WAKEUP for Non-Critical Work | Lifecycle/Architecture | High |

**Critical count: 8** (W01, W02, W03, W04, W05, N01, N05, L01, L03, A05)  
**High count: 13** (W06, N02, N03, N04, N06, L02, L04, L05, A01, A02, A04, A06)  
**Medium count: 1** (A03)  
**Total: 23 patterns**
