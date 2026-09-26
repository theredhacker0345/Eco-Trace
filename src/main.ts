/**
 * EcoTrace — application entry point.
 *
 * Wires the workbench to the analyzer, the grader, the ADB profiler, the
 * report exporter and IBM Bob 2.0, and owns the state that the view modules
 * in ./ui render from.
 *
 * Structure
 * ---------
 * This file deliberately contains no markup construction and no styling
 * decisions. It is the seam between the domain (analyzer, grader, parser) and
 * the presentation layer (the ./ui modules). Anything that renders lives
 * there; anything that computes or performs I/O lives here.
 *
 * Pipeline
 * --------
 *   open project  → index .java/.kt sources (local, no key required)
 *   analyze       → phase 1 local detectors, phase 2 Bob cross-file tracing
 *   inspect       → causal chain, remediation, grade components
 *   profile       → dumpsys batterystats deltas → measured drain grade
 *   export        → self-contained HTML report
 *
 * IBM Bob is strictly an enhancement. Static analysis, grading, the report and
 * the local remediations all work with no key configured, because a tool that
 * refuses to work without a paid service is a demo, not a product.
 */

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { Command } from "@tauri-apps/plugin-shell";

// The stylesheet is compiled from Sass and imported here rather than linked
// from the document, so the build can resolve the Carbon Sass modules and
// rewrite the bundled font URLs.
import "./styles/index.scss";

import {
  analyzeProject,
  buildCallGraph,
  traceCallChain,
  type CallGraph,
  type ChainNode,
  type FileContent,
} from "./analyzer/static.js";
import { parseDumpsys, computeDelta, type DumpsysResult } from "./parser/dumpsys.js";
import {
  calculateGrade,
  loadHistory,
  saveScan,
  type GradeResult,
  type ScanRecord,
} from "./grader/grade.js";
import { loadSettings, saveSettings, type AppSettings } from "./settings.js";

import reportTemplate from "./ui/report.html?raw";

import { esc, qs, qsButton, qsInput, qsa } from "./ui/dom.js";
import { installKeymap, type Shortcut } from "./ui/focus.js";
import { initRunLog, log } from "./ui/runLog.js";
import { initNavigator, revealFile } from "./ui/navigator.js";
import { allFixes, initFindingsTable, resetFilters } from "./ui/findingsTable.js";
import {
  currentFixText,
  initInspector,
  registerBobChain,
  registerBobFix,
  registerLocalChain,
  step,
} from "./ui/inspector.js";
import {
  closePalette,
  fileCommands,
  initPalette,
  isOpen,
  openPalette,
  setCommands,
  type Command as PaletteCommand,
} from "./ui/palette.js";
import { initSplitters, resetPanes } from "./ui/splitters.js";
import { applyTheme, initTheme, nextTheme, THEME_LABELS } from "./ui/theme.js";
import { initModals, openHistory, openSettings, closeSettings } from "./ui/modals.js";
import {
  initStatusBar,
  setBusy,
  setProgressValue,
  setStatusText,
} from "./ui/statusbar.js";
import { notify, flash } from "./ui/toasts.js";
import { CATALOG, DETECTOR_COUNT } from "./ui/catalog.js";
import { relPath, plural } from "./ui/format.js";
import {
  emit,
  selectedFinding,
  state,
  subscribe,
  type DeviceState,
  type LogLevel,
} from "./ui/store.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOB_API_BASE = "https://api.bob.ibm.com/v2";

/** A finding identity used to key Bob's enhancements onto local results. */
const findingKey = (f: { patternId: string; file: string; line: number }): string =>
  `${f.patternId}|${f.file}|${f.line}`;

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

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

let adbBefore: DumpsysResult | null = null;
let history: ScanRecord[] = [];

/** Bob-authored fixes, surfaced through the inspector module. */
const bobFixes = new Map<string, string>();

/** Local call-graph chains, cached so tab switching does not re-trace. */
const localChains = new Map<string, ChainNode[]>();

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot(): Promise<void> {
  initTheme();
  initSplitters();
  initStatusBar();
  initRunLog();
  initNavigator();
  initFindingsTable();
  initInspector();
  initPalette();
  initModals();

  wireHeader();
  wireWorkSurfaceSwitch();
  wireToolbar();
  wireDeviceProfile();
  wireSettings();
  wireGlobalEvents();
  registerCommands();
  installKeys();
  renderOnboardingCatalog();

  state.settings = await loadSettings();
  history = await loadHistory();
  emit("settings", "device", "files");
  syncConnectionIndicator();

  log("system", "EcoTrace ready. Open an Android project to begin.");
  if (!state.settings.apiKey) {
    log(
      "system",
      "No IBM Bob 2.0 key configured — local detectors, chains, grading and export remain available."
    );
  } else {
    log("success", `IBM Bob 2.0 configured (${state.settings.bobModel}).`);
  }

  syncConnectionIndicator();
}

void boot();

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function wireHeader(): void {
  qs("btn-open-project").addEventListener("click", () => void openProject());
  qs("btn-landing-open").addEventListener("click", () => void openProject());
  qs("btn-landing-settings").addEventListener("click", openSettings);
  qs("btn-settings").addEventListener("click", openSettings);
  qs("btn-export").addEventListener("click", () => void exportReport());
  qs("btn-analyze").addEventListener("click", () => void runAnalysis());
  qs("btn-history").addEventListener("click", () => openHistory(history));
  qs("bob-status").addEventListener("click", openSettings);
}

// ---------------------------------------------------------------------------
// Work surface switching
// ---------------------------------------------------------------------------

function wireWorkSurfaceSwitch(): void {
  const tabs = qsa<HTMLButtonElement>("#surface-switch .cx-segmented__option");
  const views: Record<string, HTMLElement> = {
    findings: qs("view-findings"),
    log: qs("view-log"),
  };

  const select = (name: string): void => {
    for (const tab of tabs) {
      const active = tab.dataset.surface === name;
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
    }
    for (const [key, view] of Object.entries(views)) {
      view.hidden = key !== name;
    }
  };

  qs("surface-switch").addEventListener("click", (event) => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>(
      ".cx-segmented__option"
    );
    if (tab?.dataset.surface) select(tab.dataset.surface);
  });

  qs("surface-switch").addEventListener("keydown", (event) => {
    const index = tabs.findIndex((t) => t === document.activeElement);
    if (index === -1) return;
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    if (next === -1) return;
    event.preventDefault();
    tabs[next].focus();
    select(tabs[next].dataset.surface ?? "findings");
  });
}

// ---------------------------------------------------------------------------
// Findings toolbar
// ---------------------------------------------------------------------------

function wireToolbar(): void {
  qs("btn-copy-fixes").addEventListener("click", async () => {
    const text = allFixes(state.findings, (finding) => bobFixes.get(finding.patternId));
    if (!text) {
      notify("info", "Nothing to copy", "Run an analysis first.");
      return;
    }
    await navigator.clipboard.writeText(text);
    flash(`Copied ${plural(state.findings.length, "fix")}`);
  });

  document.addEventListener("ecotrace:analyze", () => void runAnalysis());
  document.addEventListener("ecotrace:copied", (event) =>
    flash((event as CustomEvent<string>).detail)
  );
  document.addEventListener("ecotrace:copy-failed", () =>
    notify("error", "Clipboard unavailable", "The fix could not be written to the clipboard.")
  );

  // Selecting a file in the navigator scopes the table; selecting a finding
  // anywhere re-points the navigator. Selection is bidirectional by design.
  document.addEventListener("ecotrace:select-file", (event) => {
    const path = (event as CustomEvent<string>).detail;
    state.selectedFile = state.selectedFile === path ? null : path;
    const scopeSelect = qs<HTMLSelectElement>("input-scope");
    scopeSelect.value = state.selectedFile ? "selected" : "all";
    qs("btn-inspector-prev").toggleAttribute("disabled", state.findings.length === 0);
    emit("findings", "selection");

    if (state.selectedFile) {
      const first = state.findings.findIndex((f) => f.file === state.selectedFile);
      if (first >= 0) {
        state.selectedIndex = first;
        emit("selection");
      }
    }
  });

  document.addEventListener("ecotrace:selection-changed", () => {
    const finding = selectedFinding();
    if (finding) state.selectedFile = finding.file;
    emit("selection");
  });
}

// ---------------------------------------------------------------------------
// Project loading
// ---------------------------------------------------------------------------

async function openProject(): Promise<void> {
  let selected: unknown;
  try {
    selected = await openDialog({
      directory: true,
      multiple: false,
      title: "Open Android project",
    });
  } catch (err) {
    notify("error", "Could not open the folder picker", String(err));
    return;
  }

  if (typeof selected !== "string" || selected.length === 0) return;
  await loadProject(selected);
}

async function loadProject(root: string): Promise<void> {
  state.projectPath = root;
  log("info", `Indexing ${root}`);

  let paths: string[];
  try {
    paths = await invoke<string[]>("walk_dir", { root });
  } catch (err) {
    log("system", `Could not read the project folder: ${String(err)}`);
    notify("error", "Could not read the project folder", String(err));
    return;
  }

  if (paths.length === 0) {
    log("system", "No .java or .kt files found. Is this an Android project?");
    notify(
      "warning",
      "No Java or Kotlin sources",
      "EcoTrace indexes .java and .kt files. Check that the folder is an Android project root."
    );
    state.files = [];
    emit("files");
    return;
  }

  setBusy(`Reading ${plural(paths.length, "source file")}`);

  const settled = await Promise.allSettled(
    paths.map(async (path) => {
      const content = await invoke<string>("read_file", { path });
      return {
        path,
        content,
        language: path.endsWith(".kt") ? ("kotlin" as const) : ("java" as const),
      } satisfies FileContent;
    })
  );

  const files: FileContent[] = [];
  let unreadable = 0;
  for (const result of settled) {
    if (result.status === "fulfilled") files.push(result.value);
    else unreadable++;
  }

  state.files = files;
  state.findings = [];
  state.grade = null;
  state.selectedIndex = -1;
  state.selectedFile = null;
  localChains.clear();
  bobFixes.clear();
  setProgressValue(0);

  const kotlin = files.filter((f) => f.language === "kotlin").length;
  const projectName = root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? root;

  qs("project-chip").hidden = false;
  qs("project-name").textContent = projectName;
  qs("project-meta").textContent = `${files.length} files · ${kotlin} kt`;
  qs("landing").dataset.open = "false";
  qsButton("btn-analyze").disabled = false;
  qsInput("input-file-search").disabled = false;
  qsInput("input-findings-search").disabled = false;
  qsButton("btn-start-profile").disabled = false;

  emit("files", "findings", "grade", "selection");
  setStatusText(`${files.length} files indexed`);

  log(
    "success",
    `Indexed ${files.length} files (${kotlin} Kotlin, ${files.length - kotlin} Java).` +
      (unreadable ? ` ${unreadable} could not be read and were skipped.` : "")
  );
  notify(
    "info",
    `Indexed ${plural(files.length, "file")}`,
    "Run the analysis to evaluate all 23 energy detectors."
  );
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

async function runAnalysis(): Promise<void> {
  if (state.files.length === 0 || state.analyzing) return;

  state.analyzing = true;
  state.findings = [];
  state.grade = null;
  state.selectedIndex = -1;
  localChains.clear();
  bobFixes.clear();
  resetFilters();
  emit("findings", "grade", "selection");
  setBusy("Running local detectors");
  qsButton("btn-analyze").disabled = true;

  try {
    // ── Phase 1: local static analysis ───────────────────────────────────
    // Always runs, needs no key, and is the only phase guaranteed to finish.
    log("info", "Phase 1 — evaluating 23 local energy detectors.");
    const started = performance.now();
    const graph: CallGraph = buildCallGraph(state.files);
    state.callGraph = graph;

    const local = analyzeProject(state.files);
    state.findings = [...local];
    setProgressValue(0.35);
    log(
      "success",
      `Phase 1 complete — ${plural(local.length, "finding")} in ${Math.round(
        performance.now() - started
      )} ms.`
    );

    // Cache a chain for every finding that has one, so switching inspector
    // tabs is instant rather than re-walking the call graph each time.
    for (const finding of local) {
      const chain = traceCallChain(finding, graph);
      if (chain.length > 0) {
        localChains.set(findingKey(finding), chain);
        registerLocalChain(finding, chain);
      }
    }

    emit("findings");
    renderFindingsRollup();

    // ── Phase 2: cross-file causal reasoning ─────────────────────────────
    if (state.settings.apiKey) {
      await runBobPass();
    } else {
      log(
        "system",
        "Phase 2 skipped — no IBM Bob 2.0 key. Local chains and templates are in use."
      );
    }

    // ── Grade ────────────────────────────────────────────────────────────
    const grade = calculateGrade(state.findings, 0);
    state.grade = grade;
    setProgressValue(1);
    setStatusText(`Grade ${grade.letter}`, { muted: false });
    emit("grade");

    if (state.findings.length === 0) {
      log("success", `No energy anti-patterns detected. Grade ${grade.letter}.`);
      notify(
        "success",
        "No energy anti-patterns found",
        "The project passed all 23 local detectors."
      );
    } else {
      log(
        "success",
        `Analysis complete — ${plural(state.findings.length, "finding")}. Grade ${grade.letter} (${grade.numericScore}/100).`
      );
      // Open the worst finding so the inspector is never a dead panel at the
      // end of a scan.
      selectWorstFinding();
    }
  } catch (err) {
    log("system", `Analysis failed: ${String(err)}`);
    notify("error", "Analysis failed", String(err));
    setStatusText("Analysis failed", { muted: false });
  } finally {
    state.analyzing = false;
    qsButton("btn-analyze").disabled = state.files.length === 0;
    emit("busy", "findings", "grade");
  }
}

function selectWorstFinding(): void {
  const order: Record<string, number> = { Critical: 0, High: 1, Medium: 2 };
  let worst = -1;
  let rank = Number.POSITIVE_INFINITY;
  state.findings.forEach((finding, index) => {
    const value = order[finding.severity] ?? 9;
    if (value < rank) {
      rank = value;
      worst = index;
    }
  });
  if (worst >= 0) {
    state.selectedIndex = worst;
    emit("selection");
  }
}

function renderFindingsRollup(): void {
  for (const level of ["critical", "high", "medium"] as const) {
    const count = state.findings.filter(
      (f) => f.severity.toLowerCase() === level
    ).length;
    const tag = document.getElementById(`tally-${level}`);
    if (tag) {
      tag.innerHTML = `<svg class="i i--xs"><use href="#i-warning" /></svg><span class="t-numeric">${count}</span> ${level}`;
    }
  }
  qs("findings-tally").hidden = state.findings.length === 0;

  const byCategory = new Map<string, number>();
  for (const finding of state.findings) {
    byCategory.set(finding.category, (byCategory.get(finding.category) ?? 0) + 1);
  }
  const parts = [...byCategory.entries()].map(([name, count]) => `${count} ${name}`);
  qs("findings-desc").textContent = parts.length
    ? `Grouped as ${parts.join(", ")}. Expand a row for the offending source and its trace hint.`
    : "Every detected battery anti-pattern, ordered by severity.";
}

async function runBobPass(): Promise<void> {
  setBusy("Tracing causal chains with IBM Bob 2.0");
  log("info", "Phase 2 — sending the relevant sources to IBM Bob 2.0.");

  try {
    const findings = await requestBobAnalysis();
    if (!findings) {
      log("system", "IBM Bob returned nothing; keeping local results.");
      return;
    }

    applyBobFindings(findings);
    log(
      "success",
      `Phase 2 complete — ${plural(findings.length, "finding")} enriched with cross-file context.`
    );
  } catch (err) {
    log("system", `IBM Bob request failed: ${String(err)}`);
    log("system", "Local findings, chains and remediations are unaffected.");
    notify(
      "warning",
      "Bob analysis unavailable",
      "The static pass already completed. Check the key and model in Settings."
    );
  }
}

/**
 * Prompts Bob for causal chains and fixes.
 *
 * The prompt is deliberately conservative about payload size: only files that
 * actually contain findings are sent, capped per file, because the value of
 * the second pass is cross-file reasoning, not bulk transcription.
 */
async function requestBobAnalysis(): Promise<BobFinding[] | null> {
  const key = state.settings.apiKey;
  if (!key) return null;

  const flagged = new Set(state.findings.map((f) => f.file));
  const relevant = state.files.filter((f) => flagged.has(f.path)).slice(0, 20);

  const sources = relevant
    .map((f) => `=== ${relPath(f.path, state.projectPath)} ===\n${f.content.slice(0, 3000)}`)
    .join("\n\n");

  const localSummary = state.findings
    .map(
      (f) =>
        `[${f.patternId}] ${f.severity} — ${f.patternName} at ${relPath(
          f.file,
          state.projectPath
        )}:${f.line}`
    )
    .join("\n");

  const prompt = [
    "You are analysing an Android project for battery-drain defects.",
    "",
    "Local static analysis reported these energy anti-patterns:",
    localSummary,
    "",
    "Relevant source files:",
    sources,
    "",
    "For each finding:",
    "1. Trace the causal chain from an architectural entry point to the defect.",
    "2. Confirm or adjust the severity in light of the surrounding code.",
    "3. Write a precise Kotlin or Java fix.",
    "",
    'Respond with a JSON array only, shaped exactly like this:',
    JSON.stringify([
      {
        patternId: "W01",
        patternName: "Unclosed WakeLock",
        severity: "Critical",
        file: "relative/path/File.kt",
        line: 42,
        description: "…",
        causalChain: [
          "Entry: MainActivity.onCreate() schedules a sync",
          "SyncService.onStartCommand() acquires a WakeLock with no ceiling",
        ],
        fix: "// replacement code",
      },
    ]),
  ].join("\n");

  const messages: BobMessage[] = [
    {
      role: "system",
      content:
        "You are IBM Bob 2.0, reasoning across a whole repository. You specialise in Android battery optimisation and can follow multi-file causal chains. Reply with valid JSON only — no prose, no code fences.",
    },
    { role: "user", content: prompt },
  ];

  const response = await fetch(`${BOB_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: state.settings.bobModel,
      messages,
      temperature: 0.1,
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`HTTP ${response.status}: ${detail.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  const cleaned = content
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim();

  try {
    const parsed = JSON.parse(cleaned) as unknown;
    return Array.isArray(parsed) ? (parsed as BobFinding[]) : null;
  } catch {
    throw new Error("Bob returned malformed JSON.");
  }
}

/**
 * Merges Bob's output onto the local findings.
 *
 * Bob may only adjust a finding that already exists locally — it cannot invent
 * one. That constraint keeps the second pass additive: it enriches severity,
 * description and remediation, but it cannot hallucinate a defect the static
 * detectors did not find, which would make the report untrustworthy.
 */
function applyBobFindings(bob: BobFinding[]): void {
  const byIdentity = new Map<string, BobFinding>();
  for (const item of bob) {
    const abs = resolveBobPath(item.file);
    byIdentity.set(`${item.patternId}|${abs}|${item.line}`, item);
  }

  const matched = new Set<string>();

  state.findings = state.findings.map((finding) => {
    const hit = byIdentity.get(findingKey(finding));
    if (!hit) return finding;
    matched.add(findingKey(finding));
    return {
      ...finding,
      severity: hit.severity ?? finding.severity,
      description: hit.description || finding.description,
      causalChainHint: hit.causalChain?.join(" → ") || finding.causalChainHint,
    };
  });

  for (const item of bob) {
    if (item.fix) {
      bobFixes.set(item.patternId, item.fix);
      registerBobFix(item.patternId, item.fix);
    }
    if (item.causalChain?.length) {
      registerBobChain(item.patternId, item.causalChain);
    }
  }

  const enriched = [...matched].length;
  const orphaned = bob.length - enriched;
  log(
    "system",
    `Bob enriched ${enriched} finding${enriched === 1 ? "" : "s"}` +
      (orphaned > 0 ? `; ${orphaned} suggestion(s) had no local match and were ignored.` : ".")
  );
}

/** Bob returns project-relative paths; the workbench is keyed on absolute. */
function resolveBobPath(reported: string): string {
  if (!state.projectPath) return reported;
  const normalised = reported.replace(/^\.\//, "");
  const root = state.projectPath.replace(/[\\/]+$/, "");
  const direct = `${root}/${normalised}`;
  const match = state.files.find(
    (f) =>
      f.path === direct ||
      relPath(f.path, state.projectPath) === normalised
  );
  return match?.path ?? direct;
}

// ---------------------------------------------------------------------------
// Device profiling
// ---------------------------------------------------------------------------

const DEVICE_LABEL: Record<DeviceState, string> = {
  idle: "Idle",
  arming: "Capturing baseline",
  profiling: "Measuring",
  error: "ADB unavailable",
};

function wireDeviceProfile(): void {
  const tag = qs("device-state");
  const note = qs("device-note");

  subscribe(["device"], () => {
    tag.textContent = DEVICE_LABEL[state.device];
    tag.className = `cx-tag cx-tag--sm ${
      state.device === "error"
        ? "cx-tag--critical"
        : state.device === "profiling"
          ? "cx-tag--ok"
          : "cx-tag--neutral"
    }`;
    note.textContent =
      state.device === "profiling"
        ? "Baseline captured. Exercise the app, then press Stop to compute the drain rate."
        : state.device === "error"
          ? "Set a valid ADB path in Settings. Static analysis is unaffected."
          : "Captures a dumpsys batterystats baseline, then measures the drain rate between two snapshots.";
  });

  qs("btn-start-profile").addEventListener("click", () => void startProfile());
  qs("btn-stop-profile").addEventListener("click", () => void stopProfile());
}

async function startProfile(): Promise<void> {
  state.device = "arming";
  emit("device");
  log("info", "Requesting an ADB baseline snapshot…");

  const before = await runDumpsys();
  if (!before) {
    state.device = "error";
    emit("device");
    log("system", "ADB is not reachable. Check the ADB path in Settings.");
    notify(
      "error",
      "ADB is not reachable",
      "Check that a device is attached and that the ADB path in Settings is correct."
    );
    return;
  }

  adbBefore = before;
  state.device = "profiling";
  emit("device");
  qsButton("btn-start-profile").disabled = true;
  qsButton("btn-stop-profile").disabled = false;
  setStatusText("Profiling device", { muted: false });
  log("success", "Baseline captured. Exercise the app, then press Stop.");
}

async function stopProfile(): Promise<void> {
  if (!adbBefore) return;
  setBusy("Reading final snapshot");

  const after = await runDumpsys();
  if (!after) {
    resetDevice();
    notify("error", "Final ADB snapshot failed", "The device may have disconnected mid-profile.");
    return;
  }

  const delta = computeDelta(adbBefore, after);
  adbBefore = null;
  resetDevice();

  const grade: GradeResult = calculateGrade(state.findings, delta.drainRateMahPerMin);
  state.grade = grade;
  emit("grade");
  setStatusText(`Grade ${grade.letter} · ${grade.drainRateMahPerMin.toFixed(2)} mAh/min`, {
    muted: false,
  });

  log(
    "success",
    `Drain rate ${delta.drainRateMahPerMin.toFixed(2)} mAh/min over ${delta.elapsedMinutes.toFixed(1)} min. Grade ${grade.letter}.`
  );
  notify(
    grade.letter === "F" || grade.letter === "D" ? "warning" : "success",
    `Measured ${delta.drainRateMahPerMin.toFixed(2)} mAh/min`,
    `Composite grade moved to ${grade.letter} (${grade.numericScore}/100).`
  );

  if (state.projectPath) {
    const record: ScanRecord = {
      id: Date.now().toString(),
      timestamp: Date.now(),
      projectPath: state.projectPath,
      grade,
      totalFindings: state.findings.length,
      criticalFindings: grade.criticalCount,
      highFindings: grade.highCount,
      mediumFindings: grade.mediumCount,
      drainRateMahPerMin: delta.drainRateMahPerMin,
    };
    await saveScan(record);
    history = [record, ...history];
    log("system", "Scan appended to the local history.");
  }
}

function resetDevice(): void {
  state.device = "idle";
  emit("device");
  qsButton("btn-start-profile").disabled = state.files.length === 0;
  qsButton("btn-stop-profile").disabled = true;
}

async function runDumpsys(): Promise<DumpsysResult | null> {
  try {
    const command = Command.create(state.settings.adbPath, [
      "shell",
      "dumpsys",
      "batterystats",
    ]);
    const output = await command.execute();
    if (output.code !== 0) return null;
    return parseDumpsys(output.stdout);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function syncConnectionIndicator(): void {
  const indicator = qs("bob-status");
  const label = qs("bob-status-label");
  const status = qs("api-connection-status");
  const hasKey = Boolean(state.settings.apiKey);

  indicator.className = `cx-conn ${hasKey ? "cx-conn--on" : ""}`;
  label.textContent = hasKey
    ? `Bob 2.0 · ${state.settings.bobModel === "bob-2-mini" ? "Mini" : "Full"}`
    : "Bob 2.0 offline";
  indicator.title = hasKey
    ? `Connected as ${state.settings.bobModel}`
    : "No API key configured — open Settings";

  status.innerHTML = hasKey
    ? `<span class="cx-conn__dot"></span><span>Configured</span>`
    : `<span class="cx-conn__dot"></span><span>Not connected</span>`;
  status.classList.toggle("cx-conn--on", hasKey);
}

function wireSettings(): void {
  const apiKey = qs<HTMLInputElement>("input-api-key");
  const adbPath = qs<HTMLInputElement>("input-adb-path");
  const model = qs<HTMLSelectElement>("input-bob-model");
  const note = qs("settings-note");

  const hydrate = (): void => {
    apiKey.value = state.settings.apiKey;
    adbPath.value = state.settings.adbPath;
    model.value = state.settings.bobModel;
  };

  hydrate();
  subscribe(["settings"], hydrate);

  qs("btn-toggle-api-key").addEventListener("click", () => {
    const hidden = apiKey.type === "password";
    apiKey.type = hidden ? "text" : "password";
    qs("btn-toggle-api-key").textContent = hidden ? "Hide" : "Show";
  });

  qs("btn-test-api").addEventListener("click", async () => {
    const key = apiKey.value.trim();
    const status = qs("api-connection-status");
    const button = qs<HTMLButtonElement>("btn-test-api");

    if (!key) {
      status.innerHTML = `<span class="cx-conn__dot"></span><span>Enter a key first</span>`;
      status.classList.remove("cx-conn--on");
      return;
    }

    button.disabled = true;
    status.innerHTML = `<span class="cx-conn__dot"></span><span>Testing…</span>`;

    try {
      const response = await fetch(`${BOB_API_BASE}/models`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (response.ok) {
        status.innerHTML = `<span class="cx-conn__dot"></span><span>Key accepted</span>`;
        status.classList.add("cx-conn--on");
        notify("success", "Key accepted", "IBM Bob 2.0 responded to the request.");
      } else {
        status.innerHTML = `<span class="cx-conn__dot"></span><span>Rejected (HTTP ${response.status})</span>`;
        status.classList.remove("cx-conn--on");
        notify("error", "Key rejected", `The endpoint answered HTTP ${response.status}.`);
      }
    } catch {
      status.innerHTML = `<span class="cx-conn__dot"></span><span>Network error</span>`;
      status.classList.remove("cx-conn--on");
      notify("error", "Network error", "The Bob endpoint could not be reached.");
    } finally {
      button.disabled = false;
    }
  });

  qs("btn-settings-save").addEventListener("click", async () => {
    const next: AppSettings = {
      adbPath: adbPath.value.trim() || "adb",
      apiKey: apiKey.value.trim(),
      bobModel: (model.value as AppSettings["bobModel"]) || "bob-2",
    };
    state.settings = next;
    await saveSettings(next);
    syncConnectionIndicator();
    closeSettings();
    emit("settings");
    note.textContent = "Settings saved locally.";
    log("system", `Settings saved. Model ${next.bobModel}, ADB ${next.adbPath}.`);
    notify("success", "Settings saved", "Stored in %APPDATA%\\ecotrace\\settings.json");
  });
}

// ---------------------------------------------------------------------------
// Report export
// ---------------------------------------------------------------------------

/**
 * Writes a self-contained HTML report.
 *
 * The template is imported as a raw string at build time rather than fetched
 * at runtime. Fetching `/src/ui/report.html` worked in the dev server and
 * silently 404'd in the packaged application, which meant the export feature
 * was broken in every shipped build — the kind of defect that only surfaces
 * after release.
 */
async function exportReport(): Promise<void> {
  if (state.findings.length === 0) {
    notify("info", "Nothing to export", "Run an analysis first.");
    return;
  }

  try {
    const graph = state.callGraph ?? buildCallGraph(state.files);
    const worst = [...state.findings].sort(
      (a, b) => severityRank(a.severity) - severityRank(b.severity)
    )[0];
    const chain = worst && state.files.length ? traceCallChain(worst, graph) : [];

    const payload = {
      projectPath: state.projectPath ?? "Unknown",
      timestamp: Date.now(),
      grade: state.grade ?? calculateGrade(state.findings, 0),
      findings: state.findings.slice(0, 100).map((finding) => ({
        ...finding,
        file: relPath(finding.file, state.projectPath),
        fix: bobFixes.get(finding.patternId) ?? undefined,
      })),
      chain: chain.map((node) => ({
        ...node,
        file: relPath(node.file, state.projectPath),
      })),
      history: history.slice(0, 12).map((record) => ({
        timestamp: record.timestamp,
        grade: { letter: record.grade.letter, numericScore: record.grade.numericScore },
      })),
    };

    const injected = reportTemplate.replace(
      '<script id="scan-data" type="application/json"></script>',
      `<script id="scan-data" type="application/json">${JSON.stringify(
        payload
      ).replace(/</g, "\\u003c")}</script>`
    );

    const target = await saveDialog({
      title: "Save EcoTrace report",
      defaultPath: `ecotrace-report-${new Date().toISOString().slice(0, 10)}.html`,
      filters: [{ name: "HTML report", extensions: ["html"] }],
    });
    if (!target) return;

    await writeTextFile(target, injected);
    log("success", `Report exported to ${target}`);
    notify("success", "Report exported", "Open it in any browser; it needs no network access.");
  } catch (err) {
    log("system", `Export failed: ${String(err)}`);
    notify("error", "Export failed", String(err));
  }
}

function severityRank(severity: string): number {
  return severity === "Critical" ? 0 : severity === "High" ? 1 : 2;
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

function renderOnboardingCatalog(): void {
  const host = qs("detector-catalog");
  host.innerHTML = CATALOG.map(
    (group) => `
      <section class="cx-catalog__group">
        <h3 class="cx-catalog__head">
          <svg class="i i--sm"><use href="#i-${group.icon}" /></svg>
          ${esc(group.title)}
          <span class="cx-catalog__count">${group.detectors.length}</span>
        </h3>
        ${group.detectors
          .map(
            (detector) => `
              <div class="cx-catalog__row">
                <span class="cx-catalog__id">${esc(detector.id)}</span>
                <span class="t-truncate">${esc(detector.name)}</span>
              </div>`
          )
          .join("")}
      </section>`
  ).join("");

  log(
    "system",
    `${DETECTOR_COUNT} detectors loaded across ${CATALOG.length} categories.`
  );
}

// ---------------------------------------------------------------------------
// Commands and keyboard
// ---------------------------------------------------------------------------

function registerCommands(): void {
  const commands: PaletteCommand[] = [
    {
      id: "open",
      label: "Open Android project",
      group: "Project",
      icon: "folder",
      hint: "Ctrl+O",
      keywords: "load folder import repository",
      run: () => void openProject(),
    },
    {
      id: "analyze",
      label: "Run analysis",
      group: "Project",
      icon: "play",
      hint: "F5",
      keywords: "scan detect audit",
      disabled: () => state.files.length === 0,
      run: () => void runAnalysis(),
    },
    {
      id: "export",
      label: "Export HTML report",
      group: "Project",
      icon: "download",
      hint: "Ctrl+E",
      keywords: "share pdf document",
      disabled: () => state.findings.length === 0,
      run: () => void exportReport(),
    },
    {
      id: "history",
      label: "Show scan history",
      group: "Project",
      icon: "history",
      hint: "Ctrl+H",
      keywords: "timeline trend previous",
      run: () => openHistory(history),
    },
    {
      id: "settings",
      label: "Open settings",
      group: "Configuration",
      icon: "settings",
      hint: "Ctrl+,",
      keywords: "key adb model preferences",
      run: openSettings,
    },
    {
      id: "theme",
      label: "Cycle Carbon theme",
      group: "Configuration",
      icon: "contrast",
      hint: "Ctrl+Shift+L",
      keywords: "dark light appearance gray",
      run: () => {
        applyTheme(nextTheme());
        notify("info", "Theme changed", THEME_LABELS[nextTheme()]);
      },
    },
    {
      id: "panes",
      label: "Reset pane widths",
      group: "View",
      icon: "expand",
      keywords: "layout size width",
      run: () => {
        resetPanes();
        notify("info", "Layout reset", "Pane widths restored to their defaults.");
      },
    },
    {
      id: "filters",
      label: "Reset all filters",
      group: "View",
      icon: "filter",
      keywords: "clear search scope",
      run: () => {
        resetFilters();
        notify("info", "Filters cleared");
      },
    },
    {
      id: "surface",
      label: "Switch to the run log",
      group: "View",
      icon: "terminal",
      hint: "Ctrl+L",
      keywords: "console output stream",
      run: () => switchSurface("log"),
    },
    {
      id: "copy-fix",
      label: "Copy the current fix",
      group: "Findings",
      icon: "copy",
      hint: "Ctrl+Shift+C",
      keywords: "clipboard remediation",
      disabled: () => !selectedFinding(),
      run: async () => {
        const text = currentFixText();
        if (text) {
          await navigator.clipboard.writeText(text);
          flash("Fix copied");
        }
      },
    },
    {
      id: "next",
      label: "Next finding",
      group: "Findings",
      icon: "chevron-down",
      hint: "Alt+↓",
      disabled: () => state.findings.length === 0,
      run: () => step(1),
    },
    {
      id: "prev",
      label: "Previous finding",
      group: "Findings",
      icon: "chevron-up",
      hint: "Alt+↑",
      disabled: () => state.findings.length === 0,
      run: () => step(-1),
    },
    {
      id: "profile",
      label: "Start device profile",
      group: "Device",
      icon: "play",
      keywords: "adb dumpsys battery measure",
      disabled: () => state.files.length === 0 || state.device === "profiling",
      run: () => void startProfile(),
    },
    {
      id: "stop-profile",
      label: "Stop device profile",
      group: "Device",
      icon: "stop",
      keywords: "adb dumpsys battery measure",
      disabled: () => state.device !== "profiling",
      run: () => void stopProfile(),
    },
  ];

  setCommands([...commands, ...fileCommands(pickFile)]);
}

function switchSurface(name: string): void {
  const tab = document.querySelector<HTMLElement>(
    `#surface-switch .cx-segmented__option[data-surface="${name}"]`
  );
  tab?.click();
}

function pickFile(absPath: string): void {
  state.selectedFile = absPath;
  emit("findings", "selection");
  revealFile(absPath);
  switchSurface("findings");
}

function installKeys(): void {
  const shortcuts: Shortcut[] = [
    { key: "k", ctrlOrMeta: true, label: "Ctrl+K", run: openPalette },
    { key: "o", ctrlOrMeta: true, label: "Ctrl+O", run: () => void openProject() },
    {
      key: "e",
      ctrlOrMeta: true,
      label: "Ctrl+E",
      run: () => void exportReport(),
    },
    { key: "h", ctrlOrMeta: true, label: "Ctrl+H", run: () => openHistory(history) },
    { key: ",", ctrlOrMeta: true, label: "Ctrl+,", run: openSettings },
    { key: "l", ctrlOrMeta: true, label: "Ctrl+L", run: () => switchSurface("log") },
    {
      key: "l",
      ctrlOrMeta: true,
      shift: true,
      label: "Ctrl+Shift+L",
      run: () => applyTheme(nextTheme()),
    },
    {
      key: "c",
      ctrlOrMeta: true,
      shift: true,
      label: "Ctrl+Shift+C",
      allowInInput: true,
      run: async () => {
        const text = currentFixText();
        if (text) {
          await navigator.clipboard.writeText(text);
          flash("Fix copied");
        }
      },
    },
    { key: "f", ctrlOrMeta: true, label: "Ctrl+F", run: focusSearch },
    { key: "/", label: "/", run: focusSearch },
    { key: "F5", label: "F5", run: () => void runAnalysis() },
    { key: "ArrowDown", alt: true, label: "Alt+↓", run: () => step(1) },
    { key: "ArrowUp", alt: true, label: "Alt+↑", run: () => step(-1) },
    {
      key: "?",
      shift: true,
      label: "?",
      run: () => {
        switchSurface("log");
        log("system", "Shortcuts: Ctrl+K commands · Ctrl+O open · F5 analyze · Ctrl+E export · Alt+↑/↓ step findings");
      },
    },
    {
      key: "Escape",
      label: "Esc",
      run: () => {
        if (isOpen()) closePalette();
        else closeSettings();
      },
    },
  ];

  installKeymap(shortcuts);
}

function focusSearch(): void {
  switchSurface("findings");
  const input = qs<HTMLInputElement>("input-findings-search");
  input.disabled = false;
  input.focus();
  input.select();
}

// ---------------------------------------------------------------------------
// Cross-module events
// ---------------------------------------------------------------------------

function wireGlobalEvents(): void {
  // The navigator publishes file selections; the store is the single owner of
  // scope so the table and the tree can never disagree.
  document.addEventListener("ecotrace:reveal-file", (event) => {
    const abs = (event as CustomEvent<string>).detail;
    if (state.files.some((f) => f.path === abs)) revealFile(abs, false);
  });

  // A Tauri window can be resized from the frame; the panes must not fight it.
  window.addEventListener("beforeunload", () => {
    log("system", "Session closed.");
  });
}

export type { LogLevel };
