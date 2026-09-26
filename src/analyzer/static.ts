/**
 * EcoTrace Static Analyzer
 * Detects all 23 Android energy anti-patterns across Java and Kotlin source files.
 * See .bob/rules-agent/energy.md for the full detection spec.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = "Critical" | "High" | "Medium";
export type Category =
  | "Wakefulness"
  | "Network"
  | "Location/Sensors"
  | "Lifecycle/Architecture";

export interface FileContent {
  path: string; // absolute path
  content: string;
  language: "java" | "kotlin";
}

export interface Finding {
  patternId: string; // e.g. "W01"
  patternName: string;
  severity: Severity;
  category: Category;
  file: string;
  line: number;
  snippet: string; // the offending line (trimmed)
  description: string;
  causalChainHint: string; // where Bob should start tracing backwards
}

export interface CallEdge {
  callerFile: string;
  callerMethod: string;
  callerLine: number;
  calleeMethod: string; // just the method name called
}

export interface CallGraph {
  // method name → list of call edges that invoke it
  callers: Map<string, CallEdge[]>;
  // file+method → list of call edges it makes
  calls: Map<string, CallEdge[]>;
}

export interface ChainNode {
  file: string;
  method: string;
  line: number;
  role: "root" | "intermediate" | "symptom";
  description: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lines(content: string): string[] {
  return content.split(/\r?\n/);
}

/** Return the 1-based line number of the first regex match, or -1. */
function firstMatchLine(content: string, re: RegExp): number {
  const ls = lines(content);
  for (let i = 0; i < ls.length; i++) {
    if (re.test(ls[i])) return i + 1;
  }
  return -1;
}

/** Return all 1-based line numbers matching re. */
function allMatchLines(content: string, re: RegExp): number[] {
  const ls = lines(content);
  const result: number[] = [];
  for (let i = 0; i < ls.length; i++) {
    if (re.test(ls[i])) result.push(i + 1);
  }
  return result;
}

function snippet(content: string, lineNo: number): string {
  const ls = lines(content);
  return (ls[lineNo - 1] ?? "").trim();
}

function finding(
  patternId: string,
  patternName: string,
  severity: Severity,
  category: Category,
  file: string,
  line: number,
  content: string,
  description: string,
  causalChainHint: string
): Finding {
  return {
    patternId,
    patternName,
    severity,
    category,
    file,
    line,
    snippet: snippet(content, line),
    description,
    causalChainHint,
  };
}

// ---------------------------------------------------------------------------
// Pattern detectors — one function per pattern
// ---------------------------------------------------------------------------

// W01 — Unclosed WakeLock
function detectW01(f: FileContent): Finding[] {
  const acquireRe = /\.acquire\(/;
  const releaseRe = /\.release\(/;
  const hasAcquire = acquireRe.test(f.content);
  const hasRelease = releaseRe.test(f.content);
  if (!hasAcquire) return [];
  // If acquire exists but release does not anywhere in the file → definite leak
  // If both exist, check they're in a finally block
  if (!hasRelease) {
    const line = firstMatchLine(f.content, acquireRe);
    return [
      finding(
        "W01",
        "Unclosed WakeLock",
        "Critical",
        "Wakefulness",
        f.path,
        line,
        f.content,
        "WakeLock.acquire() called with no matching release() found in this file.",
        "Trace acquire() call upward to find the lifecycle method that holds this WakeLock."
      ),
    ];
  }
  // Both exist — check if release is only in try body, not finally.
  // Use the 's' (dotAll) flag so '.' matches newlines in multi-line finally blocks.
  const hasFinallyRelease = /finally\s*\{[\s\S]*?\.release\(/.test(f.content);
  if (!hasFinallyRelease) {
    const line = firstMatchLine(f.content, acquireRe);
    return [
      finding(
        "W01",
        "Unclosed WakeLock",
        "Critical",
        "Wakefulness",
        f.path,
        line,
        f.content,
        "WakeLock.acquire() found but release() is not in a finally block — leaked on error paths.",
        "Wrap acquire/release in try/finally. Trace up to find which lifecycle method owns this lock."
      ),
    ];
  }
  return [];
}

// W02 — WakeLock across IPC boundary
function detectW02(f: FileContent): Finding[] {
  const results: Finding[] = [];
  const ls = lines(f.content);
  for (let i = 0; i < ls.length; i++) {
    if (/\.acquire\(/.test(ls[i])) {
      // Look within the next 10 lines for an IPC call
      const window = ls.slice(i + 1, i + 11).join("\n");
      if (
        /startService\(|bindService\(|sendBroadcast\(|\.someMethod\(/.test(
          window
        )
      ) {
        results.push(
          finding(
            "W02",
            "WakeLock Across IPC Boundary",
            "Critical",
            "Wakefulness",
            f.path,
            i + 1,
            f.content,
            "WakeLock acquired immediately before an IPC call (startService/bindService/sendBroadcast). IPC may not complete reliably.",
            "Find the Service or BroadcastReceiver being started. Trace whether it completes reliably and releases the lock."
          )
        );
      }
    }
  }
  return results;
}

// W03 — WakeLock in AsyncTask
function detectW03(f: FileContent): Finding[] {
  const isAsyncTask =
    /extends\s+AsyncTask|:\s*AsyncTask</.test(f.content);
  if (!isAsyncTask) return [];
  const line = firstMatchLine(f.content, /\.acquire\(/);
  if (line === -1) return [];
  return [
    finding(
      "W03",
      "WakeLock in AsyncTask",
      "Critical",
      "Wakefulness",
      f.path,
      line,
      f.content,
      "WakeLock acquired inside an AsyncTask. AsyncTask is not lifecycle-aware — rotation destroys the Activity but the WakeLock stays held.",
      "Find the Activity/Fragment that creates and executes this AsyncTask. Replace with lifecycleScope coroutine."
    ),
  ];
}

// W04 — PARTIAL_WAKE_LOCK in background Service
function detectW04(f: FileContent): Finding[] {
  const isService = /extends\s+Service\b|:\s*Service\(\)/.test(f.content);
  if (!isService) return [];
  const line = firstMatchLine(f.content, /PARTIAL_WAKE_LOCK/);
  if (line === -1) return [];
  return [
    finding(
      "W04",
      "PARTIAL_WAKE_LOCK in Background Service",
      "Critical",
      "Wakefulness",
      f.path,
      line,
      f.content,
      "PARTIAL_WAKE_LOCK used inside a Service. Services have no built-in wake constraint handling — replace with WorkManager.",
      "Find the caller of startService() for this Service. Root cause is choosing Service over WorkManager."
    ),
  ];
}

// W05 — WakeLock in BroadcastReceiver without goAsync
function detectW05(f: FileContent): Finding[] {
  const isReceiver =
    /extends\s+BroadcastReceiver|:\s*BroadcastReceiver\(\)/.test(f.content);
  if (!isReceiver) return [];
  const hasAcquire = /\.acquire\(/.test(f.content);
  if (!hasAcquire) return [];
  const hasGoAsync = /goAsync\(\)/.test(f.content);
  if (hasGoAsync) return [];
  const line = firstMatchLine(f.content, /\.acquire\(/);
  return [
    finding(
      "W05",
      "WakeLock in BroadcastReceiver Without goAsync",
      "Critical",
      "Wakefulness",
      f.path,
      line,
      f.content,
      "WakeLock acquired in BroadcastReceiver.onReceive() without goAsync(). The receiver window is extremely short.",
      "Root cause: doing heavy work in BroadcastReceiver. Delegate to WorkManager instead."
    ),
  ];
}

// W06 — Nested WakeLock acquisition
function detectW06(f: FileContent): Finding[] {
  const acquireLines = allMatchLines(f.content, /\.acquire\(/);
  if (acquireLines.length < 2) return [];
  return [
    finding(
      "W06",
      "Nested WakeLock Acquisition",
      "High",
      "Wakefulness",
      f.path,
      acquireLines[1],
      f.content,
      `WakeLock.acquire() appears ${acquireLines.length} times in this file — possible double-acquire on the same instance.`,
      "Find all callers of both methods. Is there a code path where both execute sequentially?"
    ),
  ];
}

// N01 — Network call inside loop or postDelayed chain
function detectN01(f: FileContent): Finding[] {
  const results: Finding[] = [];
  const ls = lines(f.content);
  // Self-re-posting Handler
  for (let i = 0; i < ls.length; i++) {
    if (/postDelayed\s*\(/.test(ls[i])) {
      const window = ls.slice(Math.max(0, i - 5), i + 15).join("\n");
      if (
        /postDelayed\s*\(/.test(window.replace(ls[i], "")) &&
        /execute\(|enqueue\(|getInputStream\(|fetch\(/.test(window)
      ) {
        results.push(
          finding(
            "N01",
            "Network Call in PostDelayed Loop",
            "Critical",
            "Network",
            f.path,
            i + 1,
            f.content,
            "Handler.postDelayed() self-re-posts with a network call inside — continuous radio wake.",
            "Find the entry point that starts this chain. Replace with WorkManager periodic work."
          )
        );
      }
    }
    // Network inside for/while loop
    if (/\b(for|while)\s*\(/.test(ls[i])) {
      // Look for network calls within the next 15 lines (rough loop body)
      const body = ls.slice(i + 1, i + 16).join("\n");
      if (
        /\.execute\(|\.enqueue\(|getInputStream\(|HttpURLConnection|OkHttpClient|Retrofit/.test(
          body
        )
      ) {
        results.push(
          finding(
            "N01",
            "Network Call Inside Loop",
            "Critical",
            "Network",
            f.path,
            i + 1,
            f.content,
            "Network call detected inside a for/while loop — unbounded repeated HTTP requests.",
            "Batch requests outside the loop. Find what triggers this loop to identify the root cause."
          )
        );
      }
    }
  }
  return results;
}

// N02 — No connection timeout
function detectN02(f: FileContent): Finding[] {
  const hasOkHttp =
    /OkHttpClient|HttpURLConnection|\.openConnection\(\)/.test(f.content);
  if (!hasOkHttp) return [];
  const hasConnectTimeout = /connectTimeout\s*\(|setConnectTimeout\s*\(/.test(
    f.content
  );
  if (hasConnectTimeout) return [];
  const line = firstMatchLine(
    f.content,
    /OkHttpClient|HttpURLConnection|\.openConnection\(\)/
  );
  return [
    finding(
      "N02",
      "No Connection Timeout",
      "High",
      "Network",
      f.path,
      line,
      f.content,
      "HTTP client created without a connection timeout — thread blocks indefinitely on slow networks.",
      "Find where this client is instantiated. Is it a singleton shared across the app?"
    ),
  ];
}

// N03 — No read timeout
function detectN03(f: FileContent): Finding[] {
  const hasOkHttp =
    /OkHttpClient|HttpURLConnection|\.openConnection\(\)/.test(f.content);
  if (!hasOkHttp) return [];
  const hasReadTimeout = /readTimeout\s*\(|setReadTimeout\s*\(/.test(
    f.content
  );
  if (hasReadTimeout) return [];
  // Only flag if connect timeout IS set (N02 already covers the both-missing case)
  const hasConnectTimeout = /connectTimeout\s*\(|setConnectTimeout\s*\(/.test(
    f.content
  );
  if (!hasConnectTimeout) return []; // N02 covers this
  const line = firstMatchLine(
    f.content,
    /OkHttpClient|HttpURLConnection|\.openConnection\(\)/
  );
  return [
    finding(
      "N03",
      "No Read Timeout",
      "High",
      "Network",
      f.path,
      line,
      f.content,
      "Connection timeout is set but read timeout is missing — server can accept then stall indefinitely.",
      "Add .readTimeout() alongside .connectTimeout() on the same OkHttpClient.Builder."
    ),
  ];
}

// N04 — HTTP instead of HTTPS
function detectN04(f: FileContent): Finding[] {
  const results: Finding[] = [];
  const ls = lines(f.content);
  const httpRe = /"http:\/\/(?!localhost|127\.0\.0\.1|10\.0\.2\.2)/;
  for (let i = 0; i < ls.length; i++) {
    if (httpRe.test(ls[i])) {
      results.push(
        finding(
          "N04",
          "HTTP Instead of HTTPS",
          "High",
          "Network",
          f.path,
          i + 1,
          f.content,
          'Plaintext HTTP URL found. On Android 9+ cleartext is blocked by default; retries waste radio time.',
          "Find where this URL is defined. Is it a constant? Trace to the network call site."
        )
      );
    }
  }
  return results;
}

// N05 — Synchronous network on main thread
function detectN05(f: FileContent): Finding[] {
  // Look for .execute() (not .enqueue()) in Activity/Fragment/View context
  const isUiContext =
    /extends\s+(Activity|Fragment|AppCompatActivity|FragmentActivity|View)\b/.test(
      f.content
    ) ||
    /:\s*(Activity|Fragment|AppCompatActivity|FragmentActivity|View)\(/.test(
      f.content
    );
  if (!isUiContext) return [];
  const hasSyncCall = /\.execute\(\)|getInputStream\(\)/.test(f.content);
  if (!hasSyncCall) return [];
  const line = firstMatchLine(f.content, /\.execute\(\)|getInputStream\(\)/);
  return [
    finding(
      "N05",
      "Synchronous Network on Main Thread",
      "Critical",
      "Network",
      f.path,
      line,
      f.content,
      "Synchronous HTTP call (.execute() or getInputStream()) in a UI class (Activity/Fragment/View). Causes NetworkOnMainThreadException on API 11+.",
      "Root cause: this Activity/Fragment method. Move to Dispatchers.IO coroutine or use .enqueue() async callback."
    ),
  ];
}

// N06 — Polling without FCM/WebSocket
function detectN06(files: FileContent[], f: FileContent): Finding[] {
  // Only flag if: this file has a repeating scheduler AND the whole project
  // has no FCM/WebSocket usage
  const hasScheduler =
    /AlarmManager|postDelayed|ScheduledExecutorService|scheduleAtFixedRate/.test(
      f.content
    );
  if (!hasScheduler) return [];
  const hasNetworkCall =
    /OkHttpClient|HttpURLConnection|Retrofit|\.execute\(|\.enqueue\(/.test(
      f.content
    );
  if (!hasNetworkCall) return [];
  const projectHasPush = files.some((fi) =>
    /FirebaseMessaging|WebSocket|SSE|EventSource|FCM/.test(fi.content)
  );
  if (projectHasPush) return [];
  const line = firstMatchLine(
    f.content,
    /AlarmManager|postDelayed|ScheduledExecutorService/
  );
  return [
    finding(
      "N06",
      "Polling Without FCM/WebSocket",
      "High",
      "Network",
      f.path,
      line,
      f.content,
      "Repeating scheduler + network call detected. No push notification (FCM/WebSocket) found in project — this is a polling pattern.",
      "Find the scheduling entry point. Replace polling with FCM for server-push or WorkManager for background sync."
    ),
  ];
}

// L01 — GPS interval < 30 seconds
function detectL01(f: FileContent): Finding[] {
  const results: Finding[] = [];
  const ls = lines(f.content);
  // Match setInterval, requestLocationUpdates(GPS_PROVIDER, interval, ...)
  const intervalRe =
    /requestLocationUpdates|setInterval\s*\(|\.setInterval\s*\(/;
  for (let i = 0; i < ls.length; i++) {
    if (intervalRe.test(ls[i])) {
      // Extract numeric literal on this line or next
      const context = ls.slice(i, i + 3).join(" ");
      const numMatch = context.match(/\b(\d+)\b/);
      if (numMatch) {
        const val = parseInt(numMatch[1], 10);
        // If value looks like ms (< 30000) flag it; if it looks like seconds < 30, flag
        if (val < 30000 && val > 0) {
          results.push(
            finding(
              "L01",
              "GPS Update Interval < 30 Seconds",
              "Critical",
              "Location/Sensors",
              f.path,
              i + 1,
              f.content,
              `Location update interval appears to be ${val}ms (< 30s). High-frequency GPS is the single largest battery drain on mobile.`,
              "Find where the LocationRequest or interval is defined. Trace to the entry point that starts location tracking."
            )
          );
        }
      }
    }
  }
  return results;
}

// L02 — FINE location when COARSE sufficient
function detectL02(f: FileContent): Finding[] {
  const hasFine =
    /ACCESS_FINE_LOCATION|GPS_PROVIDER|PRIORITY_HIGH_ACCURACY/.test(
      f.content
    );
  if (!hasFine) return [];
  const line = firstMatchLine(
    f.content,
    /ACCESS_FINE_LOCATION|GPS_PROVIDER|PRIORITY_HIGH_ACCURACY/
  );
  return [
    finding(
      "L02",
      "FINE Location When COARSE Sufficient",
      "High",
      "Location/Sensors",
      f.path,
      line,
      f.content,
      "ACCESS_FINE_LOCATION / GPS_PROVIDER detected. Verify the feature actually needs sub-10m precision.",
      "Find the feature consuming this location. If it shows nearby POIs, weather, or city-level content — COARSE is sufficient."
    ),
  ];
}

// L03 — Sensor not unregistered in onPause/onStop
function detectL03(f: FileContent): Finding[] {
  const hasRegister = /registerListener\s*\(/.test(f.content);
  if (!hasRegister) return [];
  const hasUnregister = /unregisterListener\s*\(/.test(f.content);
  if (hasUnregister) return [];
  const line = firstMatchLine(f.content, /registerListener\s*\(/);
  return [
    finding(
      "L03",
      "Sensor Not Unregistered in onPause/onStop",
      "Critical",
      "Location/Sensors",
      f.path,
      line,
      f.content,
      "SensorManager.registerListener() called with no matching unregisterListener() in this file — sensor stays active when backgrounded.",
      "Find this Activity/Fragment's onPause()/onStop(). Root cause: registration without deregistration."
    ),
  ];
}

// L04 — Full-rate accelerometer for step counting
function detectL04(f: FileContent): Finding[] {
  const hasAccelerometer = /TYPE_ACCELEROMETER/.test(f.content);
  if (!hasAccelerometer) return [];
  const hasStepKeyword = /step|pedometer|walk|pace|stride/i.test(f.content);
  if (!hasStepKeyword) return [];
  const line = firstMatchLine(f.content, /TYPE_ACCELEROMETER/);
  return [
    finding(
      "L04",
      "Full-Rate Accelerometer for Step Counting",
      "High",
      "Location/Sensors",
      f.path,
      line,
      f.content,
      "TYPE_ACCELEROMETER used in a file with step-counting keywords. Use TYPE_STEP_COUNTER (hardware-assisted, low power).",
      "Root cause: choosing TYPE_ACCELEROMETER over the dedicated step-counter sensor."
    ),
  ];
}

// L05 — Geofencing via polling
function detectL05(files: FileContent[], f: FileContent): Finding[] {
  const hasPollingLocation =
    /requestLocationUpdates|getLastKnownLocation/.test(f.content) &&
    /AlarmManager|postDelayed|Handler/.test(f.content);
  if (!hasPollingLocation) return [];
  const hasDistanceCalc =
    /distanceTo\(|distanceBetween\(|Haversine|Math\.sin\(|Math\.cos\(/.test(
      f.content
    );
  if (!hasDistanceCalc) return [];
  const projectHasGeofence = files.some((fi) =>
    /GeofencingClient|Geofence\.Builder|addGeofences/.test(fi.content)
  );
  if (projectHasGeofence) return [];
  const line = firstMatchLine(f.content, /requestLocationUpdates/);
  return [
    finding(
      "L05",
      "Geofencing via Polling",
      "High",
      "Location/Sensors",
      f.path,
      line,
      f.content,
      "Location polling + distance calculation detected with no GeofencingClient in project — manual geofence polling.",
      "Replace with GeofencingClient API which uses hardware-optimized boundary detection."
    ),
  ];
}

// A01 — Service with no stopSelf
function detectA01(f: FileContent): Finding[] {
  const isService =
    /extends\s+Service\b|extends\s+IntentService\b|:\s*Service\(\)|:\s*IntentService\(/.test(
      f.content
    );
  if (!isService) return [];
  const hasStopSelf = /stopSelf\(\)|stopService\(/.test(f.content);
  if (hasStopSelf) return [];
  const line = firstMatchLine(f.content, /onStartCommand|onHandleIntent/);
  if (line === -1) return [];
  return [
    finding(
      "A01",
      "Service With No stopSelf()",
      "High",
      "Lifecycle/Architecture",
      f.path,
      line,
      f.content,
      "Service.onStartCommand() found with no stopSelf() or stopService() anywhere in the class — Service runs indefinitely.",
      "Find all startService() callers for this Service. Is it triggered repeatedly? Root cause: no termination condition."
    ),
  ];
}

// A02 — Deferrable work using raw Service
function detectA02(files: FileContent[], f: FileContent): Finding[] {
  const isService =
    /extends\s+(Service|IntentService)\b|:\s*(Service|IntentService)\(/.test(
      f.content
    );
  if (!isService) return [];
  const isDeferrableWork =
    /sync|upload|backup|analytics|report|flush/i.test(
      f.path + " " + f.content.slice(0, 500)
    );
  if (!isDeferrableWork) return [];
  const projectHasWorkManager = files.some((fi) =>
    /WorkManager|Worker\b|CoroutineWorker/.test(fi.content)
  );
  if (projectHasWorkManager) return [];
  const line = firstMatchLine(f.content, /onStartCommand|onHandleIntent/);
  if (line === -1) return [];
  return [
    finding(
      "A02",
      "Deferrable Work Using Raw Service",
      "High",
      "Lifecycle/Architecture",
      f.path,
      line,
      f.content,
      "Deferrable work (sync/upload/backup) implemented as a raw Service with no WorkManager in the project.",
      "Find startService() callers. Is this triggered on a schedule? Scheduled deferrable work = WorkManager."
    ),
  ];
}

// A03 — JobScheduler ignored for background sync
function detectA03(files: FileContent[], f: FileContent): Finding[] {
  const hasNetworkInService =
    /extends\s+Service\b|:\s*Service\(\)/.test(f.content) &&
    /OkHttpClient|HttpURLConnection|Retrofit/.test(f.content);
  if (!hasNetworkInService) return [];
  const hasConstraints = /setRequiredNetworkType|setRequiresCharging|JobScheduler|JobInfo/.test(
    f.content
  );
  if (hasConstraints) return [];
  const projectHasWorkManager = files.some((fi) =>
    /WorkManager|JobScheduler/.test(fi.content)
  );
  if (projectHasWorkManager) return [];
  const line = firstMatchLine(f.content, /OkHttpClient|HttpURLConnection/);
  return [
    finding(
      "A03",
      "JobScheduler Ignored for Background Sync",
      "Medium",
      "Lifecycle/Architecture",
      f.path,
      line,
      f.content,
      "Network call in a Service with no JobScheduler/WorkManager constraints — sync runs on metered connections and battery.",
      "Is there a WiFi/charging check before the sync? If not, add WorkManager constraints: setRequiredNetworkType, setRequiresCharging."
    ),
  ];
}

// A04 — Infinite ValueAnimator not cancelled
function detectA04(f: FileContent): Finding[] {
  const hasInfinite =
    /setRepeatCount\s*\(\s*(?:ValueAnimator\.INFINITE|-1)\s*\)|repeatCount\s*=\s*(?:ValueAnimator\.INFINITE|-1)/.test(
      f.content
    );
  if (!hasInfinite) return [];
  const hasCancelInLifecycle =
    /onPause\s*\(\)|onStop\s*\(\)|onDestroyView\s*\(\)/.test(f.content) &&
    /\.cancel\(\)|\.end\(\)/.test(f.content);
  if (hasCancelInLifecycle) return [];
  const line = firstMatchLine(
    f.content,
    /setRepeatCount\s*\(\s*(?:ValueAnimator\.INFINITE|-1)\s*\)|repeatCount\s*=\s*(?:ValueAnimator\.INFINITE|-1)/
  );
  return [
    finding(
      "A04",
      "Infinite Animator Not Cancelled in Lifecycle",
      "High",
      "Lifecycle/Architecture",
      f.path,
      line,
      f.content,
      "ValueAnimator with INFINITE repeat count — no cancel() found in onPause/onStop. GPU redraws continuously when backgrounded.",
      "Find the Activity/Fragment. Is onPause() defined? Does it cancel this animator?"
    ),
  ];
}

// A05 — Heavy computation in onDraw
function detectA05(f: FileContent): Finding[] {
  const results: Finding[] = [];
  const ls = lines(f.content);
  let inOnDraw = false;
  let braceDepth = 0;
  let sawOpenBrace = false; // true once we've counted ≥1 opening brace

  for (let i = 0; i < ls.length; i++) {
    const line = ls[i];
    if (/override\s+fun\s+onDraw\s*\(|protected\s+void\s+onDraw\s*\(/.test(line)) {
      inOnDraw = true;
      braceDepth = 0;
      sawOpenBrace = false;
    }
    if (inOnDraw) {
      braceDepth += (line.match(/\{/g) || []).length;
      braceDepth -= (line.match(/\}/g) || []).length;
      if (braceDepth > 0) sawOpenBrace = true;
      // Exit only after we've seen the opening brace and depth returns to 0
      if (sawOpenBrace && braceDepth <= 0) {
        inOnDraw = false;
        continue;
      }
      // Check for problematic patterns inside onDraw
      if (/new\s+Paint\s*\(\)|Paint\s*\(\)/.test(line)) {
        results.push(
          finding(
            "A05",
            "Heavy Work in onDraw()",
            "Critical",
            "Lifecycle/Architecture",
            f.path,
            i + 1,
            f.content,
            "Paint object allocated inside onDraw() — called up to 120x/sec on high-refresh devices.",
            "Pre-allocate Paint as a class field in init/constructor. Move all allocation out of the draw loop."
          )
        );
      }
      if (/BitmapFactory\.|Bitmap\.createBitmap\(/.test(line)) {
        results.push(
          finding(
            "A05",
            "Heavy Work in onDraw()",
            "Critical",
            "Lifecycle/Architecture",
            f.path,
            i + 1,
            f.content,
            "Bitmap created/decoded inside onDraw() — I/O in the draw loop causes continuous CPU + GPU load.",
            "Decode bitmaps once in onSizeChanged() or init. Cache the result."
          )
        );
      }
    }
  }
  return results;
}

// A06 — AlarmManager WAKEUP for non-critical work
function detectA06(f: FileContent): Finding[] {
  const re =
    /ELAPSED_REALTIME_WAKEUP|RTC_WAKEUP|setExactAndAllowWhileIdle\s*\(/;
  const line = firstMatchLine(f.content, re);
  if (line === -1) return [];
  return [
    finding(
      "A06",
      "AlarmManager WAKEUP for Non-Critical Work",
      "High",
      "Lifecycle/Architecture",
      f.path,
      line,
      f.content,
      "AlarmManager wakeup alarm detected. Wakeup alarms force device out of Doze mode — defeats Android 6+ battery optimization.",
      "Trace the PendingIntent target. If it does deferrable work, replace with WorkManager. Only use wakeup alarms for true time-critical tasks."
    ),
  ];
}

// ---------------------------------------------------------------------------
// Call graph builder
// ---------------------------------------------------------------------------

export function buildCallGraph(files: FileContent[]): CallGraph {
  const callers = new Map<string, CallEdge[]>();
  const calls = new Map<string, CallEdge[]>();

  const methodDefRe =
    /(?:fun\s+|(?:public|private|protected|static|void|override)\s+(?:\w+\s+)*)(\w+)\s*\(/g;
  const callRe = /(\w+)\s*\(/g;

  for (const f of files) {
    const ls = lines(f.content);
    let currentMethod = "<top>";

    for (let i = 0; i < ls.length; i++) {
      const line = ls[i];

      // Detect method definition
      let defMatch: RegExpExecArray | null;
      methodDefRe.lastIndex = 0;
      while ((defMatch = methodDefRe.exec(line)) !== null) {
        const name = defMatch[1];
        // Skip common false positives
        if (!/^(if|for|while|switch|catch|new|return|class|interface)$/.test(name)) {
          currentMethod = name;
        }
      }

      // Detect call sites
      let callMatch: RegExpExecArray | null;
      callRe.lastIndex = 0;
      while ((callMatch = callRe.exec(line)) !== null) {
        const callee = callMatch[1];
        if (
          /^(if|for|while|switch|catch|new|return|class|interface|import|package)$/.test(
            callee
          )
        )
          continue;

        const edge: CallEdge = {
          callerFile: f.path,
          callerMethod: currentMethod,
          callerLine: i + 1,
          calleeMethod: callee,
        };

        // callers map: callee → edges that call it
        const existing = callers.get(callee) ?? [];
        existing.push(edge);
        callers.set(callee, existing);

        // calls map: file+method → edges it makes
        const key = `${f.path}::${currentMethod}`;
        const outgoing = calls.get(key) ?? [];
        outgoing.push(edge);
        calls.set(key, outgoing);
      }
    }
  }

  return { callers, calls };
}

// ---------------------------------------------------------------------------
// Causal chain tracer
// ---------------------------------------------------------------------------

const LIFECYCLE_ROOTS = new Set([
  "onCreate", "onStartCommand", "onReceive", "onBind", "onHandleIntent",
  "onStart", "onResume", "onAttach", "doInBackground", "onPostExecute",
]);

export function traceCallChain(
  finding: Finding,
  callGraph: CallGraph,
  maxHops = 6
): ChainNode[] {
  const symptomMethod = detectMethodAtLine(finding);
  const chain: ChainNode[] = [
    {
      file: finding.file,
      method: symptomMethod,
      line: finding.line,
      role: "symptom",
      description: finding.description,
    },
  ];

  const visited = new Set<string>([symptomMethod]);
  let current = symptomMethod;

  for (let hop = 0; hop < maxHops; hop++) {
    const edges = callGraph.callers.get(current) ?? [];
    if (edges.length === 0) break;
    // Pick the most interesting caller (lifecycle root first, else first edge)
    const lifecycleEdge = edges.find((e) =>
      LIFECYCLE_ROOTS.has(e.callerMethod)
    );
    const edge = lifecycleEdge ?? edges[0];
    if (visited.has(edge.callerMethod)) break;
    visited.add(edge.callerMethod);

    const isRoot =
      LIFECYCLE_ROOTS.has(edge.callerMethod) || hop === maxHops - 1;
    chain.unshift({
      file: edge.callerFile,
      method: edge.callerMethod,
      line: edge.callerLine,
      role: isRoot ? "root" : "intermediate",
      description: isRoot
        ? `Architectural decision point — this is where the drain chain originates.`
        : `Calls ${current}`,
    });

    if (isRoot) break;
    current = edge.callerMethod;
  }

  return chain;
}

function detectMethodAtLine(f: Finding): string {
  // Walk up from the finding's line in the file to find the nearest enclosing
  // method definition. This gives us the actual containing method rather than
  // extracting a name from the causalChainHint text (which points to a callee,
  // not the containing method).
  const file = allFilesForChain.get(f.file);
  if (file) {
    const ls = lines(file.content);
    const methodDefRe =
      /(?:fun\s+|(?:public|private|protected|static|void|override)\s+(?:\w+\s+)*)(\w+)\s*\(/;
    for (let i = Math.min(f.line - 1, ls.length - 1); i >= 0; i--) {
      const m = methodDefRe.exec(ls[i]);
      if (m) {
        const name = m[1];
        if (!/^(if|for|while|switch|catch|new|return|class|interface)$/.test(name)) {
          return name;
        }
      }
    }
  }
  // Fallback: extract from causalChainHint or use a generic name
  const hintMatch = f.causalChainHint.match(/(\w+)\(\)/);
  return hintMatch ? hintMatch[1] : f.patternId.toLowerCase() + "_site";
}

// File content lookup used by detectMethodAtLine — populated by analyzeProject
const allFilesForChain = new Map<string, FileContent>();

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export function analyzeProject(files: FileContent[]): Finding[] {
  const results: Finding[] = [];

  // Populate the file map used by detectMethodAtLine / traceCallChain
  allFilesForChain.clear();
  for (const f of files) allFilesForChain.set(f.path, f);

  for (const f of files) {
    results.push(...detectW01(f));
    results.push(...detectW02(f));
    results.push(...detectW03(f));
    results.push(...detectW04(f));
    results.push(...detectW05(f));
    results.push(...detectW06(f));

    results.push(...detectN01(f));
    results.push(...detectN02(f));
    results.push(...detectN03(f));
    results.push(...detectN04(f));
    results.push(...detectN05(f));
    results.push(...detectN06(files, f));

    results.push(...detectL01(f));
    results.push(...detectL02(f));
    results.push(...detectL03(f));
    results.push(...detectL04(f));
    results.push(...detectL05(files, f));

    results.push(...detectA01(f));
    results.push(...detectA02(files, f));
    results.push(...detectA03(files, f));
    results.push(...detectA04(f));
    results.push(...detectA05(f));
    results.push(...detectA06(f));
  }

  // Sort: Critical first, then High, then Medium; within severity by file
  const severityOrder: Record<Severity, number> = {
    Critical: 0,
    High: 1,
    Medium: 2,
  };
  results.sort((a, b) => {
    const sd = severityOrder[a.severity] - severityOrder[b.severity];
    if (sd !== 0) return sd;
    return a.file.localeCompare(b.file);
  });

  return results;
}
