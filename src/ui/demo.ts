/**
 * Demo Mode — the hosted, judge-facing build of EcoTrace.
 *
 * The workbench is a Tauri desktop application, which means the two things it
 * normally does on start-up — pick a folder off the disk, and talk to a phone
 * over ADB — are unavailable in a browser. Left alone, a hosted build of
 * EcoTrace therefore opens onto an empty workbench: every panel renders, and
 * none of them have anything to say. A judge visiting the link would see a
 * well-designed shell with no evidence in it of what the tool does.
 *
 * This module closes that gap. In any build served over HTTP — that is, any
 * build running outside the Tauri shell — it mounts a bundled sample Android
 * project and runs the **real** detector set over it. Nothing here is mocked:
 * the same 23 regexes, the same comment-stripping, the same call-graph
 * builder, the same grader, the same report. The findings in the hosted demo
 * are findings the analyzer genuinely produced from the bundled sources, and
 * the chains are traced by the same tracer that runs in the desktop app.
 *
 * What the demo mode does *not* fake:
 *
 *   - ADB profiling. There is no phone, so no measured drain. The report says
 *     so in its Device profile section rather than inventing a number.
 *   - IBM Bob enrichment. That needs an API key. Rather than fake a model's
 *     output, the demo shows the enrichment path in the inspector with the
 *     authored template fix, labelled as a template — which is exactly what a
 *     user without a key sees in the desktop app.
 *
 * In the Tauri build this module is never reached, because
 * `isDesktopShell()` is false and the real folder picker takes over.
 */

import { buildCallGraph, traceCallChain, analyzeProject } from "../analyzer/static.js";
import type { FileContent } from "../analyzer/static.js";
import { calculateGrade } from "../grader/grade.js";
import { registerLocalChain } from "./inspector.js";
import { log } from "./runLog.js";
import { notify } from "./toasts.js";
import { qs, qsButton, qsInput } from "./dom.js";
import { setProgressValue, setStatusText } from "./statusbar.js";
import { emit, sortFindings, state } from "./store.js";

/**
 * Bundled fixture sources, inlined at build time by Vite's `?raw` import.
 *
 * Static imports are safe here: this module is only reachable through a dynamic
 * import guarded by a runtime shell check, so a release desktop build never
 * pulls the fixtures into its bundle.
 */
import mainActivity from "../demo-project/MainActivity.java?raw";
import syncScheduler from "../demo-project/SyncScheduler.java?raw";
import syncService from "../demo-project/SyncService.java?raw";
import syncEngine from "../demo-project/SyncEngine.java?raw";
import userRepository from "../demo-project/UserRepository.java?raw";
import networkManager from "../demo-project/NetworkManager.java?raw";
import locationTracker from "../demo-project/LocationTracker.java?raw";
import uploadService from "../demo-project/UploadService.java?raw";
import sensorBridge from "../demo-project/SensorBridge.kt?raw";
import uploadQueue from "../demo-project/UploadQueue.java?raw";
import appConfig from "../demo-project/AppConfig.java?raw";
import userProfile from "../demo-project/UserProfile.java?raw";
import sessionStore from "../demo-project/SessionStore.java?raw";
import batteryAware from "../demo-project/BatteryAware.java?raw";
import diagnostics from "../demo-project/Diagnostics.java?raw";
import sharingPreferences from "../demo-project/LocationSharingPreferences.java?raw";
import analytics from "../demo-project/Analytics.java?raw";

const DEMO_ROOT = "com.northwind.tracker\\AutoTrack";

const FIXTURES: ReadonlyArray<readonly [name: string, content: string]> = [
  // The four files that carry the headline causal chain, in call order.
  ["MainActivity.java", mainActivity],
  ["SyncScheduler.java", syncScheduler],
  ["SyncService.java", syncService],
  ["SyncEngine.java", syncEngine],
  ["UserRepository.java", userRepository],
  ["NetworkManager.java", networkManager],
  // Independent findings.
  ["LocationTracker.java", locationTracker],
  ["UploadService.java", uploadService],
  ["SensorBridge.kt", sensorBridge],
  // Ordinary, unremarkable code. Roughly half of any real codebase, and the
  // reason the coverage matrix is worth reading: "checked and clean" is a
  // result, and a sample where every file is broken demonstrates nothing.
  ["UploadQueue.java", uploadQueue],
  ["AppConfig.java", appConfig],
  ["UserProfile.java", userProfile],
  ["SessionStore.java", sessionStore],
  ["BatteryAware.java", batteryAware],
  ["Diagnostics.java", diagnostics],
  ["LocationSharingPreferences.java", sharingPreferences],
  ["Analytics.java", analytics],
];

/** The application id the drain measurement would target, from the manifest. */
const DEMO_PACKAGE = "com.northwind.tracker";

/** True inside the Tauri shell, where the real folder picker is available. */
export function isDesktopShell(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

/** True when this build is being served as a hosted demo. */
export function isDemoMode(): boolean {
  return !isDesktopShell();
}

function demoFiles(): FileContent[] {
  return FIXTURES.map(([name, content]) => ({
    path: `${DEMO_ROOT}\\${name}`,
    content,
    language: name.endsWith(".kt") ? ("kotlin" as const) : ("java" as const),
  }));
}

/**
 * Mounts the demo project and runs a real analysis over it.
 *
 * Runs the detectors on the calling thread rather than through the worker: the
 * demo set is ten files, and a worker round-trip would add latency to the one
 * path where the judge's first impression is the wait.
 */
export async function mountDemoMode(): Promise<void> {
  const files = demoFiles();

  state.projectPath = DEMO_ROOT;
  state.files = files;
  state.manifestPackageNames = [DEMO_PACKAGE];
  state.analyzing = true;

  const chip = qs("project-chip");
  chip.hidden = false;
  qs("project-name").textContent = "AutoTrack";
  qs("project-meta").textContent = `${files.length} files · 1 kt`;
  qs("landing").dataset.open = "false";
  qsButton("btn-analyze").disabled = false;
  qsInput("input-file-search").disabled = false;
  qsInput("input-findings-search").disabled = false;
  // Profiling needs a device. Left enabled it would fail on click, and a
  // control that visibly does nothing is worse than a control that is
  // honestly absent.
  qsButton("btn-start-profile").disabled = true;
  qsButton("btn-start-profile").title =
    "Device profiling needs the desktop app — it talks to a phone over ADB.";

  log("system", `Demo mode — indexed the bundled AutoTrack sample (${files.length} sources).`);
  setStatusText("Running the real detector set over the bundled sample…", { muted: true });

  const started = performance.now();
  const graph = buildCallGraph(files);
  const findings = analyzeProject(files);
  state.findings = findings;
  sortFindings("severity", true);

  // Trace every finding once, up front, and keep the chains by identity. The
  // alternative -- tracing lazily on selection -- means the first thing a
  // visitor clicks has to pay for a call-graph walk before it renders.
  const chains = new Map<string, ReturnType<typeof traceCallChain>>();
  for (const finding of findings) {
    const chain = traceCallChain(finding, graph);
    if (chain.length > 0) {
      chains.set(`${finding.patternId}|${finding.file}|${finding.line}`, chain);
      if (chain.length > 1) registerLocalChain(finding, chain);
    }
  }

  state.grade = calculateGrade(findings, 0);
  state.analyzing = false;

  // Open on the deepest chain, not on the first critical.
  //
  // The tracer can only build a chain for a finding whose containing method is
  // itself called, eventually, by a lifecycle entry point. Sorting by severity
  // alone tends to land on a finding in a leaf method, which shows the
  // inspector's empty state -- the one screen in the product that demonstrates
  // nothing. Landing on the longest chain instead means the first thing a
  // visitor sees is the reason the tool exists.
  let best = -1;
  let bestHops = 1;
  findings.forEach((finding, index) => {
    const hops = chains.get(`${finding.patternId}|${finding.file}|${finding.line}`)?.length ?? 0;
    if (hops > bestHops) {
      bestHops = hops;
      best = index;
    }
  });
  const longest = bestHops;

  if (best >= 0) state.selectedIndex = best;
  else {
    const firstCritical = findings.findIndex((f) => f.severity === "Critical");
    if (firstCritical >= 0) state.selectedIndex = firstCritical;
  }

  const elapsed = Math.round(performance.now() - started);
  log(
    "success",
    `Demo analysis complete — ${findings.length} findings, longest causal chain ${longest} hops, ${elapsed} ms.`
  );
  notify(
    "info",
    `Demo mode · grade ${state.grade?.letter ?? "—"}`,
    `${findings.length} findings from the real detectors. Longest causal chain: ${longest} hops. The desktop build opens a project folder of your own.`
  );

  setProgressValue(1);
  setStatusText(`Grade ${state.grade?.letter ?? "—"} · ${findings.length} findings · demo mode`, {
    muted: false,
  });

  markDemoBanner();

  // The palette indexes project files, so its command set is rebuilt whenever
  // the file list changes.
  document.dispatchEvent(new CustomEvent("ecotrace:files-changed"));

  emit("files", "findings", "grade", "selection", "device");

  // Land on the causal chain, not the overview.
  //
  // The chain is the reason this tool exists and the reason the demo was worth
  // building, and the overview tab is a severity tag and a rule id. Opening
  // there means the first thing a visitor reads is a list.
  //
  // Deferred a frame: the panels render off the emit above, and clicking the
  // tab before they exist selects a tab whose panel is still empty. The click
  // goes through the real control rather than by setting aria-selected, so the
  // tablist's own state stays consistent.
  if (longest > 1) {
    window.requestAnimationFrame(() => {
      const chainTab = document.getElementById("tab-chain");
      if (chainTab instanceof HTMLButtonElement) chainTab.click();
    });
  }
}

/**
 * Re-runs the analysis on demand.
 *
 * Wired to the Analyze button in demo mode, because a judge clicking the
 * primary action and seeing nothing happen reads as a broken build. The
 * detectors are deterministic, so the second run produces the same findings —
 * which is itself the point worth demonstrating.
 */
export function rewireDemoAnalyze(): void {
  qsButton("btn-analyze").addEventListener("click", () => void mountDemoMode());
}

/**
 * Marks the shell as a hosted demo.
 *
 * Judges and viewers need to know in one glance that they are looking at a
 * sample project rather than their own code, and a visitor who does not realise
 * that will read the findings as a claim about their repository. The banner
 * element itself is static markup in index.html so the shell's grid does not
 * change shape between the two builds; this only fills and reveals it.
 */
function markDemoBanner(): void {
  document.documentElement.setAttribute("data-demo", "true");

  const banner = document.getElementById("demo-banner");
  if (!banner) return;

  const text = banner.querySelector(".cx-demo-banner__text");
  if (text) {
    text.innerHTML =
      "Running the real 23-detector set over <code>AutoTrack</code>, EcoTrace's " +
      "own rule-test corpus &mdash; a sample with deliberately planted defects. " +
      "Same analyzers, call graph, grader and report as the desktop build.";
  }
  banner.hidden = false;
}
