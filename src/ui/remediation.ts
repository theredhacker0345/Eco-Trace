/**
 * Remediation templates.
 *
 * One authored fix per detector rule. Local templates are always available so
 * the Fix tab is never empty; when IBM Bob 2.0 returns a fix for the same rule,
 * that takes precedence because it is written against the specific call chain
 * rather than against the rule in general.
 *
 * The remediations deliberately target WorkManager, coroutines and the modern
 * lifecycle APIs rather than patching the symptom — an unclosed WakeLock is
 * not fixed by adding a release() call, it is fixed by not needing one.
 */

import type { Finding } from "../analyzer/static.js";

const TEMPLATES: Record<string, string> = {
  W01: `// Always bound a WakeLock and release it in a finally block
val wakeLock = powerManager.newWakeLock(
    PowerManager.PARTIAL_WAKE_LOCK, "EcoTrace:Tag")
try {
    wakeLock.acquire(10 * 60 * 1000L) // hard ceiling, never indefinite
    doWork()
} finally {
    if (wakeLock.isHeld) wakeLock.release()
}`,
  W02: `// Do not hold a WakeLock across an IPC boundary.
// The receiving component acquires its own lock for its own work:

// Sender
startService(Intent(this, SyncService::class.java).apply {
    putExtra(EXTRA_PAYLOAD, payload)
})

// Receiver
override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val lock = acquireBoundedLock()
    try {
        doWork(intent)
    } finally {
        release(lock)
    }
    stopSelf(startId)
    return START_NOT_STICKY
}`,
  W03: `// Replace AsyncTask + WakeLock with a lifecycle-aware coroutine.
// WorkManager acquires and releases wake internally.
lifecycleScope.launch(Dispatchers.IO) {
    doWork()
}`,
  W04: `// Replace Service + PARTIAL_WAKE_LOCK with WorkManager
val request = OneTimeWorkRequestBuilder<SyncWorker>()
    .setConstraints(Constraints(requiresBatteryNotLow = true))
    .build()
WorkManager.getInstance(context).enqueue(request)`,
  W05: `// A BroadcastReceiver has roughly 10 seconds; goAsync() buys time safely
class SyncReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                sync()
            } finally {
                pending.finish()
            }
        }
    }
}`,
  W06: `// Acquire at most one lock per component and re-check the holder.
// Nested acquisition means two owners and no defined release order.
if (lock?.isHeld != true) {
    lock = acquireBoundedLock()
}
try {
    doWork()
} finally {
    lock?.let { if (it.isHeld) it.release() }
    lock = null
}`,
  N01: `// Replace a self-reposting Handler loop with periodic work
val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
    .setConstraints(
        Constraints(requiredNetworkType = NetworkType.CONNECTED)
    )
    .build()
WorkManager.getInstance(context)
    .enqueueUniquePeriodicWork(
        "sync",
        ExistingPeriodicWorkPolicy.KEEP,
        request,
    )`,
  N02: `// Every socket needs a connect timeout
val client = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS)
    .build()`,
  N03: `// A read timeout is what actually bounds a stalled radio
val client = OkHttpClient.Builder()
    .readTimeout(30, TimeUnit.SECONDS)
    .build()`,
  N04: `// Cleartext traffic keeps the radio up and leaks on hostile networks.
// Replace the base URL with its TLS equivalent:
const val BASE = "https://api.example.com/"`,
  N05: `// Move the call off the main thread
lifecycleScope.launch {
    val result = withContext(Dispatchers.IO) {
        client.newCall(request).execute()
    }
}`,
  N06: `// Replace polling with push.
// 1. add the firebase-messaging dependency
// 2. implement FirebaseMessagingService.onMessageReceived
// 3. delete the repeating AlarmManager / Handler chain`,
  L01: `// A 30s floor trades a few metres of accuracy for hours of battery
val locationRequest = LocationRequest.Builder(
    Priority.PRIORITY_BALANCED_POWER_ACCURACY, 30_000L
).setMinUpdateIntervalMillis(15_000L).build()`,
  L02: `// City-level work does not need FINE
val locationRequest = LocationRequest.Builder(
    Priority.PRIORITY_LOW_POWER, 30_000L
).build()
// and request only ACCESS_COARSE_LOCATION`,
  L03: `// Release sensors with the lifecycle that started them
private val listener = object : SensorEventListener { /* ... */ }

override fun onResume() {
    super.onResume()
    sensorManager.registerListener(listener, sensor, SENSOR_DELAY_NORMAL)
}

override fun onPause() {
    super.onPause()
    sensorManager.unregisterListener(listener)
}`,
  L04: `// Step counting is a low-power hardware feature
val stepSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)
sensorManager.registerListener(listener, stepSensor, SENSOR_DELAY_NORMAL)`,
  L05: `// Geofencing is battery-free; polling for it is the bug
val client = LocationServices.getGeofencingClient(context)
client.addGeofences(geofenceRequest)`,
  A01: `// A service that never stops itself pins a process open
override fun onStartCommand(
    intent: Intent?, flags: Int, startId: Int
): Int {
    doWork()
    stopSelf(startId)
    return START_NOT_STICKY
}`,
  A02: `// Deferrable work belongs in a worker, not a foreground service
class SyncWorker(
    ctx: Context, params: WorkerParameters
) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result = try {
        sync()
        Result.success()
    } catch (e: IOException) {
        Result.retry()
    }
}`,
  A03: `// Let the scheduler choose the moment
val constraints = Constraints.Builder()
    .setRequiredNetworkType(NetworkType.UNMETERED)
    .setRequiresBatteryNotLow(true)
    .build()
val job = jobScheduler.schedule(
    JobInfo.Builder(SYNC_JOB_ID, ComponentName(context, SyncService::class.java))
        .setConstraints(constraints)
        .setPeriodic(15, TimeUnit.MINUTES)
        .build(),
)`,
  A04: `// An infinite animator keeps redrawing when the window is not visible
override fun onPause() {
    super.onPause()
    animator.cancel()
}

override fun onResume() {
    super.onResume()
    animator.start()
}`,
  A05: `// onDraw runs every frame: allocate nothing inside it
class PulseView(context: Context) : View(context) {
    private val paint = Paint().apply {
        color = Color.GREEN
        style = Paint.Style.STROKE
        strokeWidth = 2f
        isAntiAlias = true
    }
    private val rect = RectF()

    override fun onDraw(canvas: Canvas) {
        rect.set(cx - radius, cy - radius, cx + radius, cy + radius)
        canvas.drawCircle(cx, cy, radius, paint)
    }
}`,
  A06: `// WAKEUP alarms defeat Doze batching; use a periodic window
val request = PeriodicWorkRequestBuilder<CleanupWorker>(1, TimeUnit.HOURS)
    .build()
WorkManager.getInstance(context)
    .enqueueUniquePeriodicWork(
        "cleanup",
        ExistingPeriodicWorkPolicy.KEEP,
        request,
    )`,
};

export interface FixSource {
  /** Fix produced by IBM Bob 2.0, if the model returned one for this rule. */
  bobFix?: string;
}

/** The fix text to show for a finding, preferring Bob's version. */
export function fixFor(finding: Finding, bobFix?: string): string {
  if (bobFix && bobFix.trim().length > 0) return bobFix;
  return (
    TEMPLATES[finding.patternId] ??
    `// ${finding.patternId} has no authored template.\n` +
      `// ${finding.causalChainHint}\n` +
      `// ${finding.description}`
  );
}

export function hasTemplate(patternId: string): boolean {
  return patternId in TEMPLATES;
}

/** Concatenates the fix for every finding, grouped by file with headers. */
export function allFixes(
  findings: readonly Finding[],
  resolve: (finding: Finding) => string | undefined
): string {
  if (findings.length === 0) return "";
  return findings
    .map((finding) => {
      const fix = resolve(finding) ?? fixFor(finding);
      return [
        `// ${finding.patternId} · ${finding.patternName}`,
        `// ${finding.file}:${finding.line}`,
        fix,
      ].join("\n");
    })
    .join("\n\n");
}
