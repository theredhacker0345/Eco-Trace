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
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Command } from "@tauri-apps/plugin-shell";
import { tempDir } from "@tauri-apps/api/path";
import { join } from "@tauri-apps/api/path";

// The stylesheet is compiled from Sass and imported here rather than linked
// from the document, so the build can resolve the Carbon Sass modules and
// rewrite the bundled font URLs.
import "./styles/index.scss";

import { runAnalysisInWorker } from "./analyzer/runner.js";
import type { ChainNode, FileContent } from "./analyzer/static.js";
import { parseDumpsys, computeDelta, type DumpsysResult, type DumpsysDelta } from "./parser/dumpsys.js";
import {
  calculateGrade,
  loadHistory,
  saveScan,
  type GradeResult,
  type ScanRecord,
} from "./grader/grade.js";
import { loadSettings, saveSettings, type AppSettings } from "./settings.js";

import { buildReportPayload } from "./report/payload.js";
import { printToPdf, renderReport, revealReport, writeReport } from "./report/export.js";

import { esc, qs, qsButton, qsInput, qsa } from "./ui/dom.js";
import { installKeymap, type Shortcut } from "./ui/focus.js";
import { initRunLog, log } from "./ui/runLog.js";
import { initNavigator, revealFile } from "./ui/navigator.js";
import { allFixes, initFindingsTable, resetFilters, setScope } from "./ui/findingsTable.js";
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
import { initPanes } from "./ui/panes.js";
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
  sortFindings,
  state,
  subscribe,
  type DeviceState,
  type LogLevel,
} from "./ui/store.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BOB_API_BASE = "https://api.bob.ibm.com/v2";

/**
 * Version stamped into the exported report.
 *
 * Injected by Vite from package.json so the document and the application can
 * never disagree about which build produced it — a report whose engine is
 * unidentified is a report nobody can reproduce.
 */
const APP_VERSION: string =
  typeof __ECOTRACE_VERSION__ === "string" ? __ECOTRACE_VERSION__ : "0.0.0-dev";

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
  initPanes();
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

/**
 * Development convenience: when the app is served by Vite rather than launched
 * by Tauri, there is no folder picker and no IPC, so the workbench would have
 * nothing to show. In that case — and only in that case — index the bundled
 * Java fixtures so the interface can be reviewed with real findings in it.
 * The dynamic import keeps both the harness and the fixtures out of a release
 * build.
 */
async function mountBrowserPreviewIfNeeded(): Promise<void> {
  if (!import.meta.env.DEV) return;
  const { isBrowserPreview, mountPreview } = await import("./ui/preview.js");
  if (!isBrowserPreview()) return;
  try {
    await mountPreview();
  } catch (err) {
    log("system", `Browser preview unavailable: ${String(err)}`);
  }
}

void mountBrowserPreviewIfNeeded();

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
  qs("btn-export-pdf").addEventListener("click", () => void exportPdf());
  qs("btn-export-open").addEventListener("click", () => void openReportInBrowser());
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
    const text = allFixes(state.findings, (finding) => bobFixes.get(findingKey(finding)));
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
  //
  // Both the selected file and the table's scope mode are owned here, not in
  // the views. The views publish intent through events and read the result back
  // out of the store, which is the only way the tree, the table and the
  // inspector can be guaranteed to agree about what "selected" means.
  document.addEventListener("ecotrace:select-file", (event) => {
    const path = (event as CustomEvent<string>).detail;

    // Clicking the file that is already scoped clears the scope, so the same
    // gesture both enters and leaves the filtered view.
    const alreadyScoped = state.selectedFile === path;
    state.selectedFile = alreadyScoped ? null : path;
    setScope(alreadyScoped ? "all" : "selected");

    if (state.selectedFile) {
      const first = state.findings.findIndex((f) => f.file === state.selectedFile);
      if (first >= 0) {
        state.selectedIndex = first;
      }
    }
    emit("findings", "selection");
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
    state.findings = [];
    state.grade = null;
    state.selectedIndex = -1;
    state.selectedFile = null;
    state.manifestPackageNames = [];
    localChains.clear();
    bobFixes.clear();
    emit("files", "findings", "grade", "selection");
    return;
  }

  setBusy(`Reading ${plural(paths.length, "source file")}`);

  const settled = await Promise.allSettled(
    paths.map(async (path) => {
      const content = await invoke<string>("read_file", { root, path });
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
  state.manifestPackageNames = [];
  localChains.clear();
  bobFixes.clear();
  setProgressValue(0);

  // The manifest tells us which package on the device is the one under test,
  // which is what makes a measured drain rate attributable to this app rather
  // than to the handset. It is a bounded read and cannot fail the load.
  try {
    state.manifestPackageNames = await invoke<string[]>("read_manifest", { root });
  } catch {
    state.manifestPackageNames = [];
  }

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

  // The palette lists project files, so its command set is rebuilt whenever
  // the file list changes rather than only at start-up.
  registerCommands();

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
    // It executes on a worker thread: 23 detector passes plus a call-graph
    // build over the whole project is enough CPU to freeze the window, and a
    // frozen window cannot report its own progress.
    log("info", "Phase 1 — evaluating 23 local energy detectors.");

    const result = await runAnalysisInWorker(state.files);
    state.findings = [...result.findings];
    // The canonical order is severity-first, and it is maintained in the store
    // so a row's index is its position everywhere it is shown.
    sortFindings("severity", true);
    setProgressValue(0.35);
    log(
      "success",
      `Phase 1 complete — ${plural(state.findings.length, "finding")} in ${result.elapsedMs} ms.`
    );

    // Publish the chains the worker already traced, so tab switching does not
    // re-walk the call graph.
    for (const finding of state.findings) {
      const chain = result.chains[findingKey(finding)];
      if (chain) {
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
    const key = findingKey(finding);
    const hit = byIdentity.get(key);
    if (!hit) return finding;
    matched.add(key);

    // The fix and the chain are attached *per finding*, keyed on rule + file +
    // line. Keying them on the rule id alone applied the first occurrence's
    // chain-specific fix to every other occurrence of the same rule in the
    // repository — the inspector then labelled it "generated for this call
    // chain" when it had been generated for a different file entirely.
    if (hit.fix) {
      bobFixes.set(key, hit.fix);
      registerBobFix(finding, hit.fix);
    }
    if (hit.causalChain?.length) {
      registerBobChain(finding, hit.causalChain);
    }

    return {
      ...finding,
      severity: hit.severity ?? finding.severity,
      description: hit.description || finding.description,
      causalChainHint: hit.causalChain?.join(" → ") || finding.causalChainHint,
    };
  });

  const enriched = matched.size;
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
  // Kept for the report: the exported document shows the measured drain with
  // its provenance, which is only possible if the delta outlives this function.
  lastMeasurement = delta;
  resetDevice();

  const grade: GradeResult = calculateGrade(state.findings, delta.drainRateMahPerMin);
  state.grade = grade;
  emit("grade");

  const measured = delta.drainRateMahPerMin.toFixed(2);
  setStatusText(`Grade ${grade.letter} · ${measured} mAh/min`, { muted: false });

  const provenance =
    delta.source === "app-estimator"
      ? "from batterystats per-app mAh"
      : delta.source === "charge-level"
        ? `from charge level (±${delta.resolutionMah.toFixed(0)} mAh resolution — profile longer for a tighter figure)`
        : "no usable measurement in this window";

  log(
    "success",
    `Drain rate ${measured} mAh/min over ${delta.elapsedMinutes.toFixed(1)} min, ${provenance}. Grade ${grade.letter}.`
  );
  notify(
    grade.letter === "F" || grade.letter === "D" ? "warning" : "success",
    `Measured ${measured} mAh/min`,
    `Composite grade moved to ${grade.letter} (${grade.numericScore}/100) — ${provenance}.`
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
    return parseDumpsys(output.stdout, adbWatchlist());
  } catch {
    return null;
  }
}

/**
 * The packages the drain measurement should be attributed to.
 *
 * batterystats only prints a package name in its per-uid mAh rows when the
 * package happens to be resolvable, and the app under test is the one worth
 * watching. Rather than ask the developer to type a package name, the
 * watchlist is derived: the most likely application id of the opened project
 * (read from its manifest if there is one) plus whatever ids the dumpsys
 * output itself already resolved. An empty watchlist is fine — computeDelta
 * falls back to the charge-level estimator and says so.
 */
function adbWatchlist(): string[] {
  const found = new Set<string>();

  for (const entry of state.manifestPackageNames) found.add(entry);

  // Application ids that already appeared in a previous snapshot.
  if (adbBefore) for (const pkg of adbBefore.appPackages) found.add(pkg);
  for (const entry of adbBefore?.perUid ?? []) {
    if (entry.packageName && entry.packageName.includes(".")) {
      found.add(entry.packageName);
    }
  }

  return [...found].slice(0, 12);
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

/** The most recent device measurement, carried into the report if there is one. */
let lastMeasurement: DumpsysDelta | null = null;

function reportBasename(): string {
  const project = (state.projectPath ?? "project")
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)[0]
    .replace(/[^\w.-]+/g, "-")
    .toLowerCase();
  return `ecotrace-${project}-${new Date().toISOString().slice(0, 10)}`;
}

/**
 * Builds the document.
 *
 * The template is imported as a raw string at build time rather than fetched
 * at runtime. Fetching `/src/ui/report.html` worked in the dev server and
 * silently 404'd in the packaged application, which meant the export feature
 * was broken in every shipped build — the kind of defect that only surfaces
 * after release.
 */
function buildReportHtml(): string {
  const payload = buildReportPayload({
    state,
    grade: state.grade ?? calculateGrade(state.findings, 0),
    history,
    chains: localChains,
    bobFixes,
    measurement: lastMeasurement,
    version: APP_VERSION,
  });
  return renderReport(payload);
}

/** Writes the report as a standalone HTML file and opens it. */
async function exportReport(): Promise<void> {
  if (!reportReady()) return;

  try {
    setBusy("Building report");
    const html = buildReportHtml();

    const target = await writeReport({
      html,
      format: "html",
      suggestedName: reportBasename(),
    });
    if (!target) {
      setStatusText("Export cancelled");
      return;
    }

    log("success", `Report exported to ${target}`);
    notify(
      "success",
      "Report exported",
      "A self-contained HTML file. It needs no network access and prints to PDF from the browser."
    );
    await revealReport(target).catch(() => {
      // Not being able to launch the default handler is not an export failure.
    });
  } catch (err) {
    log("system", `Export failed: ${String(err)}`);
    notify("error", "Export failed", String(err));
  }
}

/**
 * Prints the report through the host print pipeline.
 *
 * This is the PDF path. WebView2 is Chromium, so the print dialog offers
 * "Microsoft Print to PDF" and "Save as PDF" natively, and the document
 * arrives already typeset for A4 with a running footer and page numbers. That
 * produces real vector text — selectable and searchable — which is the one
 * thing a canvas-based rasteriser cannot.
 */
async function exportPdf(): Promise<void> {
  if (!reportReady()) return;

  try {
    setBusy("Preparing PDF");
    setStatusText("Choose “Save as PDF” in the print dialog", { muted: false });
    const html = buildReportHtml();
    await printToPdf(html);
    log("success", "PDF written from the print dialog.");
    notify(
      "success",
      "PDF exported",
      "Select “Microsoft Print to PDF” or “Save as PDF” as the printer."
    );
  } catch (err) {
    log("system", `PDF export failed: ${String(err)}`);
    notify("error", "PDF export failed", String(err));
  }
}

/**
 * Writes the report to a temporary file and hands it to the default browser.
 *
 * Worth having as its own action: the browser's print dialog exposes margin
 * and header controls that the webview's does not, and it is the route a
 * reader takes when they want to be in charge of the page setup.
 */
async function openReportInBrowser(): Promise<void> {
  if (!reportReady()) return;

  try {
    setBusy("Building report");
    const html = buildReportHtml();
    const target = await writeReport({
      html,
      format: "html",
      suggestedName: reportBasename(),
      target: await scratchPath(`${reportBasename()}.html`),
    });
    if (!target) return;
    log("success", `Report written to ${target}`);
    await revealReport(target);
  } catch (err) {
    log("system", `Could not open the report: ${String(err)}`);
    notify("error", "Could not open the report", String(err));
  }
}

function reportReady(): boolean {
  if (state.findings.length > 0) return true;
  notify("info", "Nothing to export", "Run an analysis first.");
  return false;
}

/** A path in the OS temp directory, for a report the user is not choosing. */
async function scratchPath(name: string): Promise<string> {
  return join(await tempDir(), name);
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

/**
 * Publishes the command set.
 *
 * Called at start-up and again whenever the file list changes, because the
 * palette doubles as a jump-to-file index and that index has to reflect the
 * project currently open.
 */
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
      keywords: "share document archive",
      disabled: () => state.findings.length === 0,
      run: () => void exportReport(),
    },
    {
      id: "export-pdf",
      label: "Export PDF report",
      group: "Project",
      icon: "document",
      hint: "Ctrl+Shift+E",
      keywords: "print pdf document share",
      disabled: () => state.findings.length === 0,
      run: () => void exportPdf(),
    },
    {
      id: "export-open",
      label: "Open report in browser",
      group: "Project",
      icon: "launch",
      keywords: "browser preview print share",
      disabled: () => state.findings.length === 0,
      run: () => void openReportInBrowser(),
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
        // The next theme has to be resolved once. `applyTheme` persists the
        // choice, so calling `nextTheme()` a second time for the label reads
        // the theme that was *just* applied and reports the one after it —
        // the toast named a theme the user was not looking at.
        const next = nextTheme();
        applyTheme(next);
        notify("info", "Theme changed", THEME_LABELS[next]);
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
    {
      key: "e",
      ctrlOrMeta: true,
      shift: true,
      label: "Ctrl+Shift+E",
      run: () => void exportPdf(),
    },
    {
      key: "p",
      ctrlOrMeta: true,
      shift: true,
      label: "Ctrl+Shift+P",
      run: () => void openReportInBrowser(),
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
        log("system", "Shortcuts: Ctrl+K commands · Ctrl+O open · F5 analyze · Ctrl+E export HTML · Ctrl+Shift+E export PDF · Alt+↑/↓ step findings");
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

  document.addEventListener("ecotrace:files-changed", registerCommands);

  log("system", "Session initialised.");
}

export type { LogLevel };
