/**
 * EcoTrace — main.ts
 * Full app wiring: UI ↔ Tauri backend ↔ TypeScript modules
 *
 * Responsibilities:
 *  - Open Project: folder picker → walk_dir → populate Navigator
 *  - Analyze: read each file → run analyzer → stream findings to Feed
 *  - Finding click: populate Fix Station with detail + causal chain + fix
 *  - ADB profiling: Start/Stop Profile via tauri-plugin-shell
 *  - Grade badge: update in real-time as findings accumulate
 *  - Export Report: generate report.html with injected scan data
 *  - Settings modal: load/save ADB path + API key
 */

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { Command } from "@tauri-apps/plugin-shell";

import { analyzeProject, buildCallGraph, traceCallChain, type Finding, type FileContent, type ChainNode, type CallGraph } from "./analyzer/static.js";
import { parseDumpsys, computeDelta, type DumpsysResult } from "./parser/dumpsys.js";
import { calculateGrade, saveScan, type GradeResult, type ScanRecord } from "./grader/grade.js";
import { loadSettings, saveSettings, getDefaultSettings, type AppSettings } from "./settings.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let projectPath: string | null = null;
let allFiles: FileContent[] = [];
let findings: Finding[] = [];
let gradeResult: GradeResult | null = null;
let adbBefore: DumpsysResult | null = null;
let profilingActive = false;
let settings: AppSettings = getDefaultSettings();
let cachedCallGraph: CallGraph | null = null;

// ---------------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------------

const btnOpenProject   = document.getElementById("btn-open-project")    as HTMLButtonElement;
const btnAnalyze       = document.getElementById("btn-analyze")          as HTMLButtonElement;
const btnStartProfile  = document.getElementById("btn-start-profile")    as HTMLButtonElement;
const btnStopProfile   = document.getElementById("btn-stop-profile")     as HTMLButtonElement;
const btnExport        = document.getElementById("btn-export")           as HTMLButtonElement;
const btnSettings      = document.getElementById("btn-settings")         as HTMLButtonElement;
const btnSettingsSave  = document.getElementById("btn-settings-save")    as HTMLButtonElement;
const btnSettingsCancel= document.getElementById("btn-settings-cancel")  as HTMLButtonElement;
const btnToggleApiKey  = document.getElementById("btn-toggle-api-key")   as HTMLButtonElement;
const btnCopyFix       = document.getElementById("btn-copy-fix")         as HTMLButtonElement;

const fileTreeEmpty    = document.getElementById("file-tree-empty")!;
const fileTreeList     = document.getElementById("file-tree-list")!;
const intelligenceFeed = document.getElementById("intelligence-feed")!;
const feedEmpty        = document.getElementById("feed-empty")!;
const feedStatus       = document.getElementById("feed-status")!;

const gradeBadge       = document.getElementById("grade-badge")!;
const vitalsDrain      = document.getElementById("vitals-drain")!;
const vitalsCritical   = document.getElementById("vitals-critical")!;
const vitalsHigh       = document.getElementById("vitals-high")!;
const vitalsStatus     = document.getElementById("vitals-status")!;
const progressBar      = document.getElementById("scan-progress-bar")!;

const settingsOverlay  = document.getElementById("settings-overlay")!;
const inputAdbPath     = document.getElementById("input-adb-path")      as HTMLInputElement;
const inputApiKey      = document.getElementById("input-api-key")        as HTMLInputElement;

const findingDetail    = document.getElementById("finding-detail")!;
const fixEmpty         = document.getElementById("fix-empty")!;
const detailSeverity   = document.getElementById("detail-severity-badge")!;
const detailPatternName= document.getElementById("detail-pattern-name")!;
const detailPatternId  = document.getElementById("detail-pattern-id")!;
const detailFile       = document.getElementById("detail-file")!;
const detailDescription= document.getElementById("detail-description")!;
const detailSnippet    = document.getElementById("detail-snippet")!;
const chainTree        = document.getElementById("chain-tree")!;
const fixCode          = document.getElementById("fix-code")!;

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function init() {
  settings = await loadSettings();
  feedLog("system", "EcoTrace ready. Open an Android project to begin.");
}

init();

// ---------------------------------------------------------------------------
// Open Project
// ---------------------------------------------------------------------------

btnOpenProject.addEventListener("click", async () => {
  const selected = await openDialog({ directory: true, multiple: false, title: "Open Android Project" });
  if (!selected || typeof selected !== "string") return;
  projectPath = selected;
  feedLog("system", `Project opened: ${projectPath}`);
  await loadProjectFiles(projectPath);
});

async function loadProjectFiles(root: string) {
  feedLog("system", "Walking directory tree…");
  setProgress(10);
  const paths: string[] = await invoke("walk_dir", { root });
  allFiles = [];

  for (const p of paths) {
    const content: string = await invoke("read_file", { path: p });
    allFiles.push({
      path: p,
      content,
      language: p.endsWith(".kt") ? "kotlin" : "java",
    });
  }

  renderFileTree(allFiles);
  feedLog("success", `Loaded ${allFiles.length} source files (Java + Kotlin).`);
  btnAnalyze.disabled = false;
  setProgress(0);
}

// ---------------------------------------------------------------------------
// File tree render
// ---------------------------------------------------------------------------

function renderFileTree(files: FileContent[]) {
  fileTreeEmpty.style.display = "none";
  fileTreeList.innerHTML = "";

  for (const f of files) {
    const item = document.createElement("div");
    item.className = "file-item";
    item.dataset.path = f.path;

    const dot = document.createElement("span");
    dot.className = "severity-dot clean";

    const name = document.createElement("span");
    name.className = "file-name";
    name.title = f.path;
    name.textContent = f.path.split(/[\\/]/).pop() ?? f.path;

    item.appendChild(dot);
    item.appendChild(name);
    fileTreeList.appendChild(item);

    item.addEventListener("click", () => selectFile(f.path));
  }
}

function updateFileTreeSeverities() {
  const fileSeverity = new Map<string, { level: string; count: number }>();
  for (const f of findings) {
    const existing = fileSeverity.get(f.file);
    if (!existing) {
      fileSeverity.set(f.file, { level: f.severity, count: 1 });
    } else {
      existing.count++;
      if (f.severity === "Critical") existing.level = "Critical";
      else if (f.severity === "High" && existing.level !== "Critical") existing.level = "High";
    }
  }

  const items = Array.from(fileTreeList.querySelectorAll<HTMLDivElement>(".file-item"));
  for (const item of items) {
    const path = item.dataset.path!;
    const dot = item.querySelector(".severity-dot") as HTMLSpanElement;
    const info = fileSeverity.get(path);
    if (info) {
      const cls = info.level.toLowerCase();
      dot.className = `severity-dot ${cls}`;
      item.className = `file-item has-${cls}`;
      let countEl = item.querySelector(".finding-count") as HTMLSpanElement | null;
      if (!countEl) {
        countEl = document.createElement("span");
        countEl.className = "finding-count";
        item.appendChild(countEl);
      }
      countEl.textContent = `${info.count}`;
    }
  }
}

function selectFile(path: string) {
  const items = Array.from(fileTreeList.querySelectorAll<HTMLDivElement>(".file-item"));
  for (const item of items) {
    item.classList.toggle("active", item.dataset.path === path);
  }
  // Show first finding in this file, if any
  const fileFinding = findings.find((f) => f.file === path);
  if (fileFinding) showFinding(fileFinding);
}

// ---------------------------------------------------------------------------
// Analyze
// ---------------------------------------------------------------------------

btnAnalyze.addEventListener("click", async () => {
  if (!allFiles.length) return;
  btnAnalyze.disabled = true;
  findings = [];
  gradeResult = null;
  cachedCallGraph = null;
  resetVitals();
  feedLog("system", `Starting analysis on ${allFiles.length} files…`);
  feedStatus.textContent = "ANALYZING";
  progressBar.classList.add("running");

  cachedCallGraph = buildCallGraph(allFiles);

  // Run all 23 detectors once with the full file list so cross-file
  // detectors (N06, L05, A02, A03) have project-wide visibility.
  findings = analyzeProject(allFiles);

  // Group by file for streaming output, preserving per-file order
  const byFile = new Map<string, typeof findings>();
  for (const finding of findings) {
    const arr = byFile.get(finding.file) ?? [];
    arr.push(finding);
    byFile.set(finding.file, arr);
  }

  let processed = 0;
  for (const f of allFiles) {
    const fileFindings = byFile.get(f.path) ?? [];

    // Stream findings to Intelligence Feed as they're "discovered"
    for (const finding of fileFindings) {
      const rel = finding.file.replace(projectPath ?? "", "").replace(/^[\\/]/, "");
      feedLog(
        finding.severity.toLowerCase() as FeedLevel,
        `[${finding.patternId}] ${finding.patternName} — ${rel}:${finding.line}`,
        rel
      );
    }

    processed++;
    setProgress(Math.round((processed / allFiles.length) * 85));
    // Yield to DOM between files so the feed actually renders
    await new Promise((r) => setTimeout(r, 0));
  }

  // Trace causal chains for critical findings
  const criticals = findings.filter((f) => f.severity === "Critical");
  if (criticals.length && cachedCallGraph) {
    feedLog("system", `Tracing causal chains for ${criticals.length} critical finding(s)…`);
    for (const f of criticals.slice(0, 5)) {
      const chain = traceCallChain(f, cachedCallGraph);
      if (chain.length > 1) {
        feedLog("critical", `🔴 CHAIN: ${f.patternName} root → ${chain[0].method}() in ${chain[0].file.split(/[\\/]/).pop()}`);
      }
    }
  }

  // Grade
  gradeResult = calculateGrade(findings, 0);
  updateVitals(gradeResult);
  updateFileTreeSeverities();
  setProgress(100);
  progressBar.classList.remove("running");

  feedLog("success", `Analysis complete — ${findings.length} findings. Grade: ${gradeResult.letter}`);
  feedStatus.textContent = "DONE";
  vitalsStatus.textContent = `Grade ${gradeResult.letter}`;
  btnExport.disabled = false;
  btnAnalyze.disabled = false;

  // Auto-select first critical finding in Fix Station
  if (findings.length) showFinding(findings[0]);
});

// ---------------------------------------------------------------------------
// Fix Station
// ---------------------------------------------------------------------------

function showFinding(f: Finding) {
  fixEmpty.style.display = "none";
  findingDetail.style.display = "block";

  const sev = f.severity.toLowerCase();
  detailSeverity.className = `severity-badge ${sev}`;
  detailSeverity.textContent = f.severity.toUpperCase();
  detailPatternName.textContent = f.patternName;
  detailPatternId.textContent = `[${f.patternId}]`;
  detailFile.textContent = `${f.file.replace(projectPath ?? "", "")}:${f.line}`;
  detailDescription.textContent = f.description;
  detailSnippet.textContent = f.snippet;

  // Causal chain (only for Critical) — use the cached call graph built during analysis
  chainTree.innerHTML = "";
  if (f.severity === "Critical" && allFiles.length) {
    const callGraph = cachedCallGraph ?? buildCallGraph(allFiles);
    const chain = traceCallChain(f, callGraph);
    renderChainTree(chain);
  }

  // Fix code
  fixCode.textContent = generateFix(f);
}

function renderChainTree(chain: ChainNode[]) {
  chainTree.innerHTML = "";
  for (const node of chain) {
    const li = document.createElement("li");
    li.className = `chain-${node.role}`;
    li.innerHTML = `
      <div class="chain-method">${escHtml(node.method)}()</div>
      <div class="chain-file">${escHtml(node.file.split(/[\\/]/).pop() ?? node.file)}:${node.line}</div>
      <div class="chain-desc">${escHtml(node.description)}</div>
    `;
    chainTree.appendChild(li);
  }
}

function generateFix(f: Finding): string {
  const fixes: Record<string, string> = {
    W01: `// ✅ FIX: W01 — Always release WakeLock in finally block\nval wakeLock = powerManager.newWakeLock(\n    PowerManager.PARTIAL_WAKE_LOCK, "EcoTrace:Tag")\ntry {\n    wakeLock.acquire(10 * 60 * 1000L) // 10-min max\n    doWork()\n} finally {\n    if (wakeLock.isHeld) wakeLock.release()\n}`,
    W02: `// ✅ FIX: W02 — Release WakeLock before IPC; let the Service acquire its own\n// Don't hold a WakeLock across startService().\n// Use a WakefulBroadcastReceiver pattern or WorkManager instead.`,
    W03: `// ✅ FIX: W03 — Replace AsyncTask + WakeLock with lifecycle-aware coroutine\nlifecycleScope.launch(Dispatchers.IO) {\n    // WakeLock not needed — WorkManager handles wake internally\n    doWork()\n}`,
    W04: `// ✅ FIX: W04 — Replace Service + PARTIAL_WAKE_LOCK with WorkManager\nval request = OneTimeWorkRequestBuilder<SyncWorker>()\n    .setConstraints(Constraints(requiresCharging = false))\n    .build()\nWorkManager.getInstance(context).enqueue(request)`,
    W05: `// ✅ FIX: W05 — Use goAsync() if you must do work in BroadcastReceiver\nclass MyReceiver : BroadcastReceiver() {\n    override fun onReceive(context: Context, intent: Intent) {\n        val result = goAsync()\n        // Or better: delegate to WorkManager and skip the WakeLock\n        CoroutineScope(Dispatchers.IO).launch {\n            try { doWork() } finally { result.finish() }\n        }\n    }\n}`,
    N01: `// ✅ FIX: N01 — Replace polling loop with WorkManager periodic work\nval request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)\n    .setConstraints(Constraints(requiredNetworkType = NetworkType.CONNECTED))\n    .build()\nWorkManager.getInstance(context)\n    .enqueueUniquePeriodicWork("sync", ExistingPeriodicWorkPolicy.KEEP, request)`,
    N02: `// ✅ FIX: N02 + N03 — Set connection AND read timeouts\nval client = OkHttpClient.Builder()\n    .connectTimeout(10, TimeUnit.SECONDS)\n    .readTimeout(30, TimeUnit.SECONDS)\n    .writeTimeout(15, TimeUnit.SECONDS)\n    .build()`,
    N03: `// ✅ FIX: N03 — Add missing read timeout\nval client = OkHttpClient.Builder()\n    .connectTimeout(10, TimeUnit.SECONDS)\n    .readTimeout(30, TimeUnit.SECONDS)  // ← add this\n    .build()`,
    N04: `// ✅ FIX: N04 — Use HTTPS\n// Change: "http://api.example.com/"\n// To:     "https://api.example.com/"`,
    N05: `// ✅ FIX: N05 — Move network call off main thread\nlifecycleScope.launch {\n    val result = withContext(Dispatchers.IO) {\n        client.newCall(request).execute()\n    }\n    // update UI with result here (back on Main)\n}`,
    N06: `// ✅ FIX: N06 — Replace polling with FCM push notifications\n// 1. Add firebase-messaging dependency\n// 2. Implement FirebaseMessagingService\n// 3. Remove the repeating AlarmManager / Handler chain`,
    L01: `// ✅ FIX: L01 — Increase GPS interval to >= 30 seconds\nval locationRequest = LocationRequest.create().apply {\n    interval = 30_000L           // 30 seconds minimum\n    fastestInterval = 15_000L\n    priority = LocationRequest.PRIORITY_BALANCED_POWER_ACCURACY\n}`,
    L02: `// ✅ FIX: L02 — Use COARSE location if city-level precision is sufficient\n// AndroidManifest.xml:\n// <uses-permission android:name=\"android.permission.ACCESS_COARSE_LOCATION\"/>\n\nval locationRequest = LocationRequest.create().apply {\n    priority = LocationRequest.PRIORITY_LOW_POWER  // network/WiFi only\n}`,
    L03: `// ✅ FIX: L03 — Unregister sensor listener in onPause\noverride fun onPause() {\n    super.onPause()\n    sensorManager.unregisterListener(sensorListener)\n}\n\noverride fun onResume() {\n    super.onResume()\n    sensorManager.registerListener(sensorListener, sensor, SensorManager.SENSOR_DELAY_NORMAL)\n}`,
    L04: `// ✅ FIX: L04 — Use hardware step counter instead of raw accelerometer\nval stepSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)\n// TYPE_STEP_COUNTER uses dedicated low-power hardware\n// No need to process raw accelerometer data`,
    L05: `// ✅ FIX: L05 — Use GeofencingClient instead of manual polling\nval geofencingClient = LocationServices.getGeofencingClient(context)\nval geofence = Geofence.Builder()\n    .setRequestId("my-geofence")\n    .setCircularRegion(lat, lng, radiusMeters)\n    .setExpirationDuration(Geofence.NEVER_EXPIRE)\n    .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_ENTER or Geofence.GEOFENCE_TRANSITION_EXIT)\n    .build()`,
    A01: `// ✅ FIX: A01 — Call stopSelf() when work is complete\noverride fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {\n    doWork()\n    stopSelf(startId)  // ← stop when done\n    return START_NOT_STICKY\n}`,
    A02: `// ✅ FIX: A02 — Replace raw Service with WorkManager for deferrable work\nclass SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {\n    override suspend fun doWork(): Result {\n        sync()\n        return Result.success()\n    }\n}`,
    A03: `// ✅ FIX: A03 — Add network/charging constraints to background sync\nval constraints = Constraints.Builder()\n    .setRequiredNetworkType(NetworkType.UNMETERED)  // WiFi only\n    .setRequiresCharging(false)\n    .build()\nval request = OneTimeWorkRequestBuilder<SyncWorker>()\n    .setConstraints(constraints)\n    .build()`,
    A04: `// ✅ FIX: A04 — Cancel infinite animator in onPause\noverride fun onPause() {\n    super.onPause()\n    animator.cancel()  // ← stop GPU redraws when backgrounded\n}\n\noverride fun onResume() {\n    super.onResume()\n    animator.start()\n}`,
    A05: `// ✅ FIX: A05 — Pre-allocate Paint outside onDraw\nclass MyView(context: Context) : View(context) {\n    // Allocated once, reused every frame\n    private val paint = Paint().apply {\n        color = Color.GREEN\n        strokeWidth = 2f\n    }\n\n    override fun onDraw(canvas: Canvas) {\n        // Use pre-allocated paint — no allocation here\n        canvas.drawCircle(cx, cy, r, paint)\n    }\n}`,
    A06: `// ✅ FIX: A06 — Replace wakeup alarm with WorkManager for deferrable work\nval request = PeriodicWorkRequestBuilder<CleanupWorker>(1, TimeUnit.HOURS)\n    .setConstraints(Constraints(requiredNetworkType = NetworkType.NOT_REQUIRED))\n    .build()\nWorkManager.getInstance(context)\n    .enqueueUniquePeriodicWork("cleanup", ExistingPeriodicWorkPolicy.KEEP, request)\n// WorkManager respects Doze mode — no wakeup alarm needed`,
  };
  return fixes[f.patternId] ?? `// No automated fix available for ${f.patternId}.\n// ${f.causalChainHint}`;
}

// Copy fix button
btnCopyFix.addEventListener("click", async () => {
  const text = fixCode.textContent ?? "";
  await navigator.clipboard.writeText(text);
  btnCopyFix.textContent = "Copied!";
  btnCopyFix.classList.add("copied");
  setTimeout(() => {
    btnCopyFix.textContent = "Copy";
    btnCopyFix.classList.remove("copied");
  }, 2000);
});

// ---------------------------------------------------------------------------
// ADB Dynamic Profiling
// ---------------------------------------------------------------------------

btnStartProfile.addEventListener("click", async () => {
  if (profilingActive) return;
  profilingActive = true;
  btnStartProfile.disabled = true;
  btnStopProfile.disabled = false;
  feedLog("info", "▶ ADB profile started — use your app, then click Stop.");
  adbBefore = await runDumpsys();
  if (adbBefore) {
    feedLog("success", "Before snapshot captured.");
  } else {
    feedLog("system", "⚠ ADB not reachable. Check ADB path in Settings.");
    resetProfilingState();
  }
});

btnStopProfile.addEventListener("click", async () => {
  if (!profilingActive) return;
  feedLog("info", "■ Stopping profile…");
  const adbAfter = await runDumpsys();
  if (!adbAfter) {
    feedLog("system", "⚠ ADB snapshot failed — could not capture 'after' state. Check ADB connection.");
    resetProfilingState();
    return;
  }
  if (adbBefore) {
    const delta = computeDelta(adbBefore, adbAfter);
    feedLog("success", `Dynamic profile: drain rate ${delta.drainRateMahPerMin.toFixed(2)} mAh/min over ${delta.elapsedMinutes.toFixed(1)} min.`);
    gradeResult = calculateGrade(findings, delta.drainRateMahPerMin);
    updateVitals(gradeResult);
    // Save scan record
    if (projectPath) {
      const record: ScanRecord = {
        id: Date.now().toString(),
        timestamp: Date.now(),
        projectPath,
        grade: gradeResult,
        totalFindings: findings.length,
        criticalFindings: gradeResult.criticalCount,
        highFindings: gradeResult.highCount,
        mediumFindings: gradeResult.mediumCount,
        drainRateMahPerMin: delta.drainRateMahPerMin,
      };
      await saveScan(record);
      feedLog("system", "Scan saved to history.");
    }
  }
  resetProfilingState();
});

async function runDumpsys(): Promise<DumpsysResult | null> {
  try {
    const cmd = Command.create(settings.adbPath, ["shell", "dumpsys", "batterystats"]);
    const output = await cmd.execute();
    if (output.code !== 0) return null;
    return parseDumpsys(output.stdout);
  } catch {
    return null;
  }
}

function resetProfilingState() {
  profilingActive = false;
  adbBefore = null;
  btnStartProfile.disabled = false;
  btnStopProfile.disabled = true;
}

// ---------------------------------------------------------------------------
// Export Report
// ---------------------------------------------------------------------------

btnExport.addEventListener("click", async () => {
  if (!findings.length) return;

  // Fetch the report template through the WebView's own origin — works in both
  // dev (Vite dev server) and production (tauri://localhost) without needing a
  // filesystem path, which breaks on Windows with URL.pathname stripping.
  let reportTemplate = "";
  try {
    const resp = await fetch("/src/ui/report.html");
    if (resp.ok) reportTemplate = await resp.text();
  } catch { /* fall through */ }

  if (!reportTemplate) {
    feedLog("system", "⚠ Could not load report template.");
    return;
  }

  const callGraph = cachedCallGraph ?? buildCallGraph(allFiles);
  const scanData = {
    projectPath: projectPath ?? "Unknown",
    timestamp: Date.now(),
    grade: gradeResult ?? calculateGrade(findings, 0),
    findings: findings.slice(0, 50), // cap at 50 for report size
    chain: findings[0] && allFiles.length ? traceCallChain(findings[0], callGraph) : [],
    history: [],
  };

  const injected = reportTemplate.replace(
    '<script id="scan-data" type="application/json"></script>',
    `<script id="scan-data" type="application/json">${JSON.stringify(scanData)}</script>`
  );

  const savePath = await saveDialog({
    title: "Save EcoTrace Report",
    defaultPath: `ecotrace-report-${Date.now()}.html`,
    filters: [{ name: "HTML Report", extensions: ["html"] }],
  });

  if (savePath) {
    await writeTextFile(savePath, injected);
    feedLog("success", `Report exported to ${savePath}`);
  }
});

// ---------------------------------------------------------------------------
// Vitals bar
// ---------------------------------------------------------------------------

function updateVitals(g: GradeResult) {
  // Grade badge
  const gradeClass: Record<string, string> = {
    "A+": "grade-aplus", "A": "grade-a", "B": "grade-b",
    "C": "grade-c", "D": "grade-d", "F": "grade-f",
  };
  gradeBadge.className = `grade-badge ${gradeClass[g.letter] ?? "grade-none"}`;
  gradeBadge.textContent = g.letter;

  vitalsDrain.textContent = g.drainRateMahPerMin > 0
    ? `${g.drainRateMahPerMin.toFixed(2)} mAh/min`
    : "—";
  vitalsCritical.textContent = String(g.criticalCount);
  vitalsCritical.className = `vitals-value${g.criticalCount > 0 ? " critical" : ""}`;
  vitalsHigh.textContent = String(g.highCount);
}

function resetVitals() {
  gradeBadge.className = "grade-badge grade-none";
  gradeBadge.textContent = "—";
  vitalsDrain.textContent = "—";
  vitalsCritical.textContent = "0";
  vitalsHigh.textContent = "0";
  vitalsStatus.textContent = "Scanning…";
}

function setProgress(pct: number) {
  (progressBar as HTMLElement).style.width = `${pct}%`;
}

// ---------------------------------------------------------------------------
// Intelligence Feed
// ---------------------------------------------------------------------------

type FeedLevel = "critical" | "high" | "medium" | "info" | "success" | "system";

function feedLog(level: FeedLevel, message: string, file?: string) {
  feedEmpty.style.display = "none";
  const entry = document.createElement("div");
  entry.className = `feed-entry ${level}`;
  const now = new Date().toLocaleTimeString("en-GB", { hour12: false });
  entry.innerHTML = `
    <div class="feed-ts">${now}</div>
    <div class="feed-msg">${escHtml(message)}</div>
    ${file ? `<div class="feed-file">${escHtml(file)}</div>` : ""}
  `;
  intelligenceFeed.appendChild(entry);
  intelligenceFeed.scrollTop = intelligenceFeed.scrollHeight;
}

// ---------------------------------------------------------------------------
// Settings modal
// ---------------------------------------------------------------------------

btnSettings.addEventListener("click", () => {
  inputAdbPath.value = settings.adbPath;
  inputApiKey.value = settings.apiKey;
  settingsOverlay.classList.add("visible");
});

btnSettingsCancel.addEventListener("click", () => {
  settingsOverlay.classList.remove("visible");
});

settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) settingsOverlay.classList.remove("visible");
});

btnSettingsSave.addEventListener("click", async () => {
  settings = {
    adbPath: inputAdbPath.value.trim() || "adb",
    apiKey: inputApiKey.value.trim(),
  };
  await saveSettings(settings);
  settingsOverlay.classList.remove("visible");
  feedLog("system", `Settings saved. ADB path: ${settings.adbPath}`);
});

btnToggleApiKey.addEventListener("click", () => {
  const isPassword = inputApiKey.type === "password";
  inputApiKey.type = isPassword ? "text" : "password";
  btnToggleApiKey.textContent = isPassword ? "Hide" : "Show";
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
