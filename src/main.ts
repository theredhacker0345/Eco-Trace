/**
 * EcoTrace — main.ts
 * Full app wiring: UI <-> Tauri backend <-> IBM Bob 2.0 API
 *
 * Key responsibilities:
 *  - Open Project: folder picker -> walk_dir -> populate Navigator
 *  - Analyze: gate on API key, send full project to IBM Bob 2.0, stream findings
 *  - Finding click: populate Fix Station with detail + causal chain + Bob fix
 *  - ADB profiling: Start/Stop Profile via tauri-plugin-shell
 *  - Grade badge: update in real-time as findings accumulate
 *  - Export Report: generate report.html with injected scan data
 *  - Settings: load/save API key + ADB path + Bob model, test connection
 *  - Toast: warn user when API key is missing
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

const btnOpenProject    = document.getElementById("btn-open-project")     as HTMLButtonElement;
const btnAnalyze        = document.getElementById("btn-analyze")           as HTMLButtonElement;
const btnStartProfile   = document.getElementById("btn-start-profile")     as HTMLButtonElement;
const btnStopProfile    = document.getElementById("btn-stop-profile")      as HTMLButtonElement;
const btnExport         = document.getElementById("btn-export")            as HTMLButtonElement;
const btnSettings       = document.getElementById("btn-settings")          as HTMLButtonElement;
const btnSettingsSave   = document.getElementById("btn-settings-save")     as HTMLButtonElement;
const btnSettingsCancel = document.getElementById("btn-settings-cancel")   as HTMLButtonElement;
const btnSettingsClose  = document.getElementById("btn-settings-close")    as HTMLButtonElement;
const btnToggleApiKey   = document.getElementById("btn-toggle-api-key")    as HTMLButtonElement;
const btnCopyFix        = document.getElementById("btn-copy-fix")          as HTMLButtonElement;
const btnTestApi        = document.getElementById("btn-test-api")          as HTMLButtonElement;
const btnToastDismiss   = document.getElementById("toast-dismiss")         as HTMLButtonElement;

const fileTreeEmpty     = document.getElementById("file-tree-empty")!;
const fileTreeList      = document.getElementById("file-tree-list")!;
const intelligenceFeed  = document.getElementById("intelligence-feed")!;
const feedEmpty         = document.getElementById("feed-empty")!;
const feedStatus        = document.getElementById("feed-status")!;

const gradeBadge        = document.getElementById("grade-badge")!;
const vitalsDrain       = document.getElementById("vitals-drain")!;
const vitalsCritical    = document.getElementById("vitals-critical")!;
const vitalsHigh        = document.getElementById("vitals-high")!;
const vitalsStatus      = document.getElementById("vitals-status")!;
const progressBar       = document.getElementById("scan-progress-bar")!;

const settingsOverlay   = document.getElementById("settings-overlay")!;
const inputAdbPath      = document.getElementById("input-adb-path")       as HTMLInputElement;
const inputApiKey       = document.getElementById("input-api-key")         as HTMLInputElement;
const inputBobModel     = document.getElementById("input-bob-model")       as HTMLSelectElement;
const apiConnectionStatus = document.getElementById("api-connection-status")!;

const findingDetail     = document.getElementById("finding-detail")!;
const fixEmpty          = document.getElementById("fix-empty")!;
const detailSeverity    = document.getElementById("detail-severity-badge")!;
const detailPatternName = document.getElementById("detail-pattern-name")!;
const detailPatternId   = document.getElementById("detail-pattern-id")!;
const detailFile        = document.getElementById("detail-file")!;
const detailDescription = document.getElementById("detail-description")!;
const detailSnippet     = document.getElementById("detail-snippet")!;
const chainTree         = document.getElementById("chain-tree")!;
const fixCode           = document.getElementById("fix-code")!;

const bobStatusDot      = document.getElementById("bob-status-dot")!;
const bobStatusLabel    = document.getElementById("bob-status-label")!;

const toastNoApi        = document.getElementById("toast-no-api")!;
const toastMsg          = document.getElementById("toast-msg")!;

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

async function init() {
  settings = await loadSettings();
  updateBobStatusIndicator();
  feedLog("system", "EcoTrace ready. Open an Android project to begin.");
  if (!settings.apiKey) {
    feedLog("system", "⚠  No IBM Bob 2.0 API key configured. Open Settings to add one.");
  }
}

init();

// ---------------------------------------------------------------------------
// IBM Bob 2.0 status indicator
// ---------------------------------------------------------------------------

function updateBobStatusIndicator() {
  if (settings.apiKey) {
    bobStatusDot.className = "bob-status-dot connected";
    bobStatusLabel.textContent = `IBM Bob 2.0 — Connected (${settings.bobModel === "bob-2-mini" ? "Mini" : "Full"})`;
    apiConnectionStatus.innerHTML = `<span class="status-dot-sm connected"></span> Connected`;
  } else {
    bobStatusDot.className = "bob-status-dot disconnected";
    bobStatusLabel.textContent = "IBM Bob 2.0 — Not connected";
    apiConnectionStatus.innerHTML = `<span class="status-dot-sm disconnected"></span> Not connected`;
  }
}

// ---------------------------------------------------------------------------
// Toast helpers
// ---------------------------------------------------------------------------

function showToast(message: string) {
  toastMsg.textContent = message;
  toastNoApi.style.display = "flex";
  setTimeout(() => { toastNoApi.style.display = "none"; }, 6000);
}

btnToastDismiss.addEventListener("click", () => {
  toastNoApi.style.display = "none";
});

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
  feedLog("info", "Scanning project for Java and Kotlin files…");
  try {
    const paths = await invoke<string[]>("walk_dir", { root });
    if (!paths.length) {
      feedLog("system", "No .java or .kt files found. Is this an Android project?");
      return;
    }
    const contents = await Promise.all(
      paths.map(async (p) => {
        const content = await invoke<string>("read_file", { path: p });
        const language: "java" | "kotlin" = p.endsWith(".kt") ? "kotlin" : "java";
        return { path: p, content, language } satisfies FileContent;
      })
    );
    allFiles = contents;
    renderFileTree(allFiles);
    btnAnalyze.disabled = false;
    feedLog("success", `Loaded ${allFiles.length} files (${allFiles.filter(f => f.language === "kotlin").length} Kotlin, ${allFiles.filter(f => f.language === "java").length} Java)`);
  } catch (err) {
    feedLog("system", `Error loading project: ${String(err)}`);
  }
}

function renderFileTree(files: FileContent[]) {
  fileTreeEmpty.style.display = "none";
  fileTreeList.innerHTML = "";
  for (const f of files) {
    const name = f.path.split(/[\\/]/).pop() ?? f.path;
    const div = document.createElement("div");
    div.className = "file-item";
    div.dataset.path = f.path;
    div.innerHTML = `<span class="severity-dot clean"></span><span class="file-name" title="${escHtml(f.path)}">${escHtml(name)}</span>`;
    div.addEventListener("click", () => selectFile(f.path));
    fileTreeList.appendChild(div);
  }
}

function updateFileTreeSeverities() {
  const sevMap = new Map<string, "critical" | "high" | "medium">();
  for (const f of findings) {
    const existing = sevMap.get(f.file);
    if (!existing || (f.severity === "Critical") || (f.severity === "High" && existing === "medium")) {
      sevMap.set(f.file, f.severity.toLowerCase() as "critical" | "high" | "medium");
    }
  }
  const items = fileTreeList.querySelectorAll<HTMLElement>(".file-item");
  const countMap = new Map<string, number>();
  for (const f of findings) countMap.set(f.file, (countMap.get(f.file) ?? 0) + 1);

  items.forEach((el) => {
    const p = el.dataset.path ?? "";
    const sev = sevMap.get(p);
    const count = countMap.get(p) ?? 0;
    el.className = `file-item${sev ? ` has-${sev}` : ""}`;
    const dot = el.querySelector<HTMLElement>(".severity-dot");
    if (dot) dot.className = `severity-dot ${sev ?? "clean"}`;
    let badge = el.querySelector<HTMLElement>(".finding-count");
    if (count > 0) {
      if (!badge) { badge = document.createElement("span"); badge.className = "finding-count"; el.appendChild(badge); }
      badge.textContent = String(count);
    }
  });
}

function selectFile(path: string) {
  document.querySelectorAll(".file-item").forEach(el => el.classList.remove("active"));
  const el = fileTreeList.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
  if (el) el.classList.add("active");
  const first = findings.find(f => f.file === path);
  if (first) showFinding(first);
}

// ---------------------------------------------------------------------------
// Analyze — IBM Bob 2.0 API
// ---------------------------------------------------------------------------

btnAnalyze.addEventListener("click", async () => {
  if (!allFiles.length) return;

  // Gate on API key
  if (!settings.apiKey) {
    showToast("IBM Bob 2.0 API key required. Open Settings to add it.");
    btnSettings.click();
    return;
  }

  btnAnalyze.disabled = true;
  findings = [];
  gradeResult = null;
  cachedCallGraph = null;
  resetVitals();
  setProgress(0);
  feedLog("system", `Starting IBM Bob 2.0 analysis on ${allFiles.length} files…`);
  feedStatus.textContent = "ANALYZING";
  progressBar.classList.add("running");

  // Phase 1: Local static analysis (fast, catches definite patterns)
  feedLog("info", "Phase 1 — Running local 23-pattern detector…");
  cachedCallGraph = buildCallGraph(allFiles);
  const localFindings = analyzeProject(allFiles);
  findings = [...localFindings];
  setProgress(30);

  // Phase 2: Send to IBM Bob 2.0 for causal chain reasoning
  feedLog("info", `Phase 2 — Sending ${allFiles.length} files to IBM Bob 2.0 for causal chain analysis…`);
  try {
    const bobFindings = await runBobAnalysis(allFiles, localFindings);
    if (bobFindings) {
      // Merge Bob's enhanced findings (Bob may add chain context or new findings)
      mergeBobFindings(bobFindings);
      feedLog("success", `IBM Bob 2.0 analysis complete — ${bobFindings.length} findings with causal chains traced.`);
    }
  } catch (err) {
    feedLog("system", `⚠  Bob API error: ${String(err)}`);
    feedLog("system", "Falling back to local analysis results.");
  }

  setProgress(70);

  // Stream all findings to Intelligence Feed
  const byFile = new Map<string, typeof findings>();
  for (const finding of findings) {
    const arr = byFile.get(finding.file) ?? [];
    arr.push(finding);
    byFile.set(finding.file, arr);
  }

  let processed = 0;
  for (const f of allFiles) {
    const fileFindings = byFile.get(f.path) ?? [];
    for (const finding of fileFindings) {
      const rel = finding.file.replace(projectPath ?? "", "").replace(/^[\\/]/, "");
      feedLog(
        finding.severity.toLowerCase() as FeedLevel,
        `[${finding.patternId}] ${finding.patternName} — ${rel}:${finding.line}`,
        rel
      );
    }
    processed++;
    setProgress(70 + Math.round((processed / allFiles.length) * 20));
    await new Promise((r) => setTimeout(r, 0));
  }

  // Trace causal chains for critical findings
  const criticals = findings.filter((f) => f.severity === "Critical");
  if (criticals.length && cachedCallGraph) {
    feedLog("system", `Tracing causal chains for ${criticals.length} critical finding(s)…`);
    for (const f of criticals.slice(0, 5)) {
      const chain = traceCallChain(f, cachedCallGraph);
      if (chain.length > 1) {
        feedLog("critical", `CHAIN: ${f.patternName} — root: ${chain[0].method}() in ${chain[0].file.split(/[\\/]/).pop()}`);
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

  if (findings.length) showFinding(findings[0]);
});

// ---------------------------------------------------------------------------
// IBM Bob 2.0 API integration
// ---------------------------------------------------------------------------

const BOB_API_BASE = "https://api.bob.ibm.com/v2";

interface BobMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface BobFinding {
  patternId: string;
  patternName: string;
  severity: "Critical" | "High" | "Medium";
  file: string;
  line: number;
  description: string;
  causalChain: string[];
  fix: string;
}

async function runBobAnalysis(files: FileContent[], localFindings: Finding[]): Promise<BobFinding[] | null> {
  if (!settings.apiKey) return null;

  // Build a compact project summary for Bob
  // Only send files that have findings + a few context files to keep payload size down
  const findingFiles = new Set(localFindings.map(f => f.file));
  const relevantFiles = files.filter(f => findingFiles.has(f.path)).slice(0, 20);

  const projectSummary = relevantFiles.map(f => {
    const rel = f.path.replace(projectPath ?? "", "").replace(/^[\\/]/, "");
    return `=== ${rel} ===\n${f.content.slice(0, 3000)}`; // cap per-file to keep context tight
  }).join("\n\n");

  const localFindingsSummary = localFindings.map(f => {
    const rel = f.file.replace(projectPath ?? "", "").replace(/^[\\/]/, "");
    return `[${f.patternId}] ${f.severity} — ${f.patternName} at ${rel}:${f.line}`;
  }).join("\n");

  const prompt = `You are analyzing an Android project for battery drain issues.

Local static analysis found these energy anti-patterns:
${localFindingsSummary}

Project source files (relevant subset):
${projectSummary}

For each finding above:
1. Trace the complete causal chain — how does the code flow from an architectural entry point (e.g. Activity.onCreate) through multiple files to reach this anti-pattern?
2. Confirm or adjust the severity based on context
3. Generate a precise Kotlin/Java fix

Respond with a JSON array of findings in this exact shape:
[
  {
    "patternId": "W01",
    "patternName": "Unclosed WakeLock",
    "severity": "Critical",
    "file": "relative/path/File.kt",
    "line": 42,
    "description": "...",
    "causalChain": ["Entry: MainActivity.onCreate() calls AlarmHelper.schedule()", "AlarmHelper.schedule() sets repeating alarm", "SyncService.onStartCommand() acquires WakeLock without release"],
    "fix": "// fixed code here"
  }
]`;

  const messages: BobMessage[] = [
    {
      role: "system",
      content: "You are IBM Bob 2.0, an AI with full-repository context reasoning. You specialize in Android battery optimization and can trace multi-file causal chains that no other tool can follow. Always respond with valid JSON only — no markdown, no explanation outside the JSON array."
    },
    { role: "user", content: prompt }
  ];

  const response = await fetch(`${BOB_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${settings.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: settings.bobModel,
      messages,
      temperature: 0.1,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Bob API ${response.status}: ${errText.slice(0, 200)}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  const content = data.choices?.[0]?.message?.content ?? "";
  try {
    // Strip any accidental markdown code fences
    const jsonStr = content.replace(/^```(?:json)?\n?/m, "").replace(/\n?```$/m, "").trim();
    return JSON.parse(jsonStr) as BobFinding[];
  } catch {
    throw new Error("Bob returned invalid JSON. Raw: " + content.slice(0, 300));
  }
}

function mergeBobFindings(bobFindings: BobFinding[]) {
  // Bob may return updated/enhanced versions of local findings
  // Override local findings with Bob's richer data where patternId matches
  const bobMap = new Map(bobFindings.map(b => [b.patternId + "|" + b.file + "|" + b.line, b]));
  findings = findings.map(f => {
    const key = f.patternId + "|" + f.file.replace(projectPath ?? "", "").replace(/^[\\/]/, "") + "|" + f.line;
    const bob = bobMap.get(key);
    if (!bob) return f;
    return {
      ...f,
      severity: bob.severity,
      description: bob.description,
      causalChainHint: bob.causalChain?.join(" -> ") ?? f.causalChainHint,
    };
  });
  // Also store Bob fixes keyed by patternId for use in Fix Station
  bobFindings.forEach(b => {
    if (b.fix) bobFixCache.set(b.patternId, b.fix);
    if (b.causalChain) bobChainCache.set(b.patternId, b.causalChain);
  });
}

// Cache for Bob-generated fixes and chains
const bobFixCache = new Map<string, string>();
const bobChainCache = new Map<string, string[]>();

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

  // Causal chain
  chainTree.innerHTML = "";
  if (f.severity === "Critical") {
    // Use Bob's chain if available, otherwise fall back to local call graph
    const bobChain = bobChainCache.get(f.patternId);
    if (bobChain && bobChain.length) {
      renderBobChain(bobChain);
    } else if (allFiles.length) {
      const callGraph = cachedCallGraph ?? buildCallGraph(allFiles);
      renderChainTree(traceCallChain(f, callGraph));
    }
  }

  // Fix code: prefer Bob's generated fix, fall back to local template
  fixCode.textContent = bobFixCache.get(f.patternId) ?? generateFix(f);
}

function renderBobChain(chain: string[]) {
  chainTree.innerHTML = "";
  chain.forEach((step, i) => {
    const li = document.createElement("li");
    li.className = i === 0 ? "chain-root" : i === chain.length - 1 ? "chain-symptom" : "chain-intermediate";
    li.innerHTML = `<div class="chain-method">${escHtml(step)}</div>`;
    chainTree.appendChild(li);
  });
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
    W01: `// FIX: W01 — Always release WakeLock in finally block\nval wakeLock = powerManager.newWakeLock(\n    PowerManager.PARTIAL_WAKE_LOCK, "EcoTrace:Tag")\ntry {\n    wakeLock.acquire(10 * 60 * 1000L) // 10-min max\n    doWork()\n} finally {\n    if (wakeLock.isHeld) wakeLock.release()\n}`,
    W02: `// FIX: W02 — Release WakeLock before IPC; let the Service acquire its own\n// Don't hold a WakeLock across startService().\n// Use a WakefulBroadcastReceiver pattern or WorkManager instead.`,
    W03: `// FIX: W03 — Replace AsyncTask + WakeLock with lifecycle-aware coroutine\nlifecycleScope.launch(Dispatchers.IO) {\n    // WakeLock not needed — WorkManager handles wake internally\n    doWork()\n}`,
    W04: `// FIX: W04 — Replace Service + PARTIAL_WAKE_LOCK with WorkManager\nval request = OneTimeWorkRequestBuilder<SyncWorker>()\n    .setConstraints(Constraints(requiresCharging = false))\n    .build()\nWorkManager.getInstance(context).enqueue(request)`,
    W05: `// FIX: W05 — Use goAsync() in BroadcastReceiver\nclass MyReceiver : BroadcastReceiver() {\n    override fun onReceive(context: Context, intent: Intent) {\n        val result = goAsync()\n        CoroutineScope(Dispatchers.IO).launch {\n            try { doWork() } finally { result.finish() }\n        }\n    }\n}`,
    N01: `// FIX: N01 — Replace polling with WorkManager periodic work\nval request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)\n    .setConstraints(Constraints(requiredNetworkType = NetworkType.CONNECTED))\n    .build()\nWorkManager.getInstance(context)\n    .enqueueUniquePeriodicWork("sync", ExistingPeriodicWorkPolicy.KEEP, request)`,
    N02: `// FIX: N02 + N03 — Set connection AND read timeouts\nval client = OkHttpClient.Builder()\n    .connectTimeout(10, TimeUnit.SECONDS)\n    .readTimeout(30, TimeUnit.SECONDS)\n    .writeTimeout(15, TimeUnit.SECONDS)\n    .build()`,
    N03: `// FIX: N03 — Add missing read timeout\nval client = OkHttpClient.Builder()\n    .connectTimeout(10, TimeUnit.SECONDS)\n    .readTimeout(30, TimeUnit.SECONDS)  // add this\n    .build()`,
    N04: `// FIX: N04 — Use HTTPS\n// Change: "http://api.example.com/"\n// To:     "https://api.example.com/"`,
    N05: `// FIX: N05 — Move network call off main thread\nlifecycleScope.launch {\n    val result = withContext(Dispatchers.IO) {\n        client.newCall(request).execute()\n    }\n}`,
    N06: `// FIX: N06 — Replace polling with FCM push notifications\n// 1. Add firebase-messaging dependency\n// 2. Implement FirebaseMessagingService\n// 3. Remove the repeating AlarmManager / Handler chain`,
    L01: `// FIX: L01 — Increase GPS interval to >= 30 seconds\nval locationRequest = LocationRequest.create().apply {\n    interval = 30_000L\n    fastestInterval = 15_000L\n    priority = LocationRequest.PRIORITY_BALANCED_POWER_ACCURACY\n}`,
    L02: `// FIX: L02 — Use COARSE location if city-level precision is sufficient\nval locationRequest = LocationRequest.create().apply {\n    priority = LocationRequest.PRIORITY_LOW_POWER\n}`,
    L03: `// FIX: L03 — Unregister sensor listener in onPause\noverride fun onPause() {\n    super.onPause()\n    sensorManager.unregisterListener(sensorListener)\n}`,
    L04: `// FIX: L04 — Use hardware step counter\nval stepSensor = sensorManager.getDefaultSensor(Sensor.TYPE_STEP_COUNTER)`,
    L05: `// FIX: L05 — Use GeofencingClient\nval geofencingClient = LocationServices.getGeofencingClient(context)`,
    A01: `// FIX: A01 — Call stopSelf() when work is complete\noverride fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {\n    doWork()\n    stopSelf(startId)\n    return START_NOT_STICKY\n}`,
    A02: `// FIX: A02 — Replace raw Service with WorkManager\nclass SyncWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {\n    override suspend fun doWork(): Result {\n        sync()\n        return Result.success()\n    }\n}`,
    A03: `// FIX: A03 — Add constraints to background sync\nval constraints = Constraints.Builder()\n    .setRequiredNetworkType(NetworkType.UNMETERED)\n    .build()`,
    A04: `// FIX: A04 — Cancel infinite animator in onPause\noverride fun onPause() {\n    super.onPause()\n    animator.cancel()\n}`,
    A05: `// FIX: A05 — Pre-allocate Paint outside onDraw\nclass MyView(context: Context) : View(context) {\n    private val paint = Paint().apply { color = Color.GREEN; strokeWidth = 2f }\n    override fun onDraw(canvas: Canvas) { canvas.drawCircle(cx, cy, r, paint) }\n}`,
    A06: `// FIX: A06 — Replace wakeup alarm with WorkManager\nval request = PeriodicWorkRequestBuilder<CleanupWorker>(1, TimeUnit.HOURS)\n    .build()\nWorkManager.getInstance(context)\n    .enqueueUniquePeriodicWork("cleanup", ExistingPeriodicWorkPolicy.KEEP, request)`,
  };
  return fixes[f.patternId] ?? `// No automated fix available for ${f.patternId}.\n// ${f.causalChainHint}`;
}

// Copy fix button
btnCopyFix.addEventListener("click", async () => {
  const text = fixCode.textContent ?? "";
  await navigator.clipboard.writeText(text);
  btnCopyFix.textContent = "Copied!";
  btnCopyFix.classList.add("copied");
  setTimeout(() => { btnCopyFix.innerHTML = `<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/><path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/></svg> Copy`; btnCopyFix.classList.remove("copied"); }, 2000);
});

// ---------------------------------------------------------------------------
// ADB Dynamic Profiling
// ---------------------------------------------------------------------------

btnStartProfile.addEventListener("click", async () => {
  if (profilingActive) return;
  profilingActive = true;
  btnStartProfile.disabled = true;
  btnStopProfile.disabled = false;
  feedLog("info", "ADB profile started — use your app, then click Stop.");
  adbBefore = await runDumpsys();
  if (adbBefore) {
    feedLog("success", "Before snapshot captured.");
  } else {
    feedLog("system", "⚠  ADB not reachable. Check ADB path in Settings.");
    resetProfilingState();
  }
});

btnStopProfile.addEventListener("click", async () => {
  if (!profilingActive) return;
  feedLog("info", "Stopping profile…");
  const adbAfter = await runDumpsys();
  if (!adbAfter) {
    feedLog("system", "⚠  ADB snapshot failed. Check ADB connection.");
    resetProfilingState();
    return;
  }
  if (adbBefore) {
    const delta = computeDelta(adbBefore, adbAfter);
    feedLog("success", `Dynamic profile: drain rate ${delta.drainRateMahPerMin.toFixed(2)} mAh/min over ${delta.elapsedMinutes.toFixed(1)} min.`);
    gradeResult = calculateGrade(findings, delta.drainRateMahPerMin);
    updateVitals(gradeResult);
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
  let reportTemplate = "";
  try {
    const resp = await fetch("/src/ui/report.html");
    if (resp.ok) reportTemplate = await resp.text();
  } catch { /* fall through */ }
  if (!reportTemplate) {
    feedLog("system", "⚠  Could not load report template.");
    return;
  }
  const callGraph = cachedCallGraph ?? buildCallGraph(allFiles);
  const scanData = {
    projectPath: projectPath ?? "Unknown",
    timestamp: Date.now(),
    grade: gradeResult ?? calculateGrade(findings, 0),
    findings: findings.slice(0, 50),
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
  const gradeClass: Record<string, string> = {
    "A+": "grade-aplus", "A": "grade-a", "B": "grade-b",
    "C": "grade-c", "D": "grade-d", "F": "grade-f",
  };
  gradeBadge.className = `grade-badge ${gradeClass[g.letter] ?? "grade-none"}`;
  gradeBadge.textContent = g.letter;
  vitalsDrain.textContent = g.drainRateMahPerMin > 0 ? `${g.drainRateMahPerMin.toFixed(2)} mAh/min` : "—";
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

function openSettings() {
  inputAdbPath.value = settings.adbPath;
  inputApiKey.value = settings.apiKey;
  inputBobModel.value = settings.bobModel;
  settingsOverlay.classList.add("visible");
}

function closeSettings() {
  settingsOverlay.classList.remove("visible");
}

btnSettings.addEventListener("click", openSettings);
btnSettingsCancel.addEventListener("click", closeSettings);
btnSettingsClose.addEventListener("click", closeSettings);
settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) closeSettings();
});

btnSettingsSave.addEventListener("click", async () => {
  settings = {
    adbPath: inputAdbPath.value.trim() || "adb",
    apiKey: inputApiKey.value.trim(),
    bobModel: (inputBobModel.value as AppSettings["bobModel"]) || "bob-2",
  };
  await saveSettings(settings);
  closeSettings();
  updateBobStatusIndicator();
  feedLog("system", `Settings saved. Bob model: ${settings.bobModel}. ADB: ${settings.adbPath}`);
});

btnToggleApiKey.addEventListener("click", () => {
  const isPassword = inputApiKey.type === "password";
  inputApiKey.type = isPassword ? "text" : "password";
  btnToggleApiKey.textContent = isPassword ? "Hide" : "Show";
});

// Test Bob connection
btnTestApi.addEventListener("click", async () => {
  const key = inputApiKey.value.trim();
  if (!key) {
    apiConnectionStatus.innerHTML = `<span class="status-dot-sm error"></span> Enter an API key first`;
    return;
  }
  btnTestApi.disabled = true;
  btnTestApi.textContent = "Testing…";
  apiConnectionStatus.innerHTML = `<span class="status-dot-sm connecting"></span> Connecting…`;
  try {
    const resp = await fetch(`${BOB_API_BASE}/models`, {
      headers: { "Authorization": `Bearer ${key}` },
    });
    if (resp.ok) {
      apiConnectionStatus.innerHTML = `<span class="status-dot-sm connected"></span> Connected successfully`;
    } else {
      apiConnectionStatus.innerHTML = `<span class="status-dot-sm error"></span> Auth failed (${resp.status})`;
    }
  } catch {
    apiConnectionStatus.innerHTML = `<span class="status-dot-sm error"></span> Network error`;
  }
  btnTestApi.disabled = false;
  btnTestApi.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/><path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/></svg> Test Connection`;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
