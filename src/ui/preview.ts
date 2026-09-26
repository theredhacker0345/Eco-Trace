/**
 * Browser preview harness — development only.
 *
 * EcoTrace's real entry points (folder picker, `invoke("walk_dir")`, ADB) only
 * exist inside the Tauri shell, which means the workbench cannot be exercised
 * in a plain browser: there is no way to load files, so every panel renders
 * empty and the layout, density and interaction of the actual product are
 * invisible to review.
 *
 * This module closes that gap. When the app is served by Vite and no Tauri IPC
 * bridge is present, it indexes the repository's own Java test fixtures and
 * runs the real detector set over them. The result is a populated workbench
 * driven by genuine findings from genuine code — not mock data.
 *
 * The whole module is behind a dynamic import guarded by `import.meta.env.DEV`,
 * so neither this file nor the fixtures it reads is referenced by a production
 * bundle.
 */

import { analyzeProject, buildCallGraph, traceCallChain } from "../analyzer/static.js";
import type { FileContent } from "../analyzer/static.js";
import { calculateGrade } from "../grader/grade.js";
import { registerLocalChain } from "./inspector.js";
import { log } from "./runLog.js";
import { notify } from "./toasts.js";
import { qs, qsButton, qsInput } from "./dom.js";
import { setProgressValue, setStatusText } from "./statusbar.js";
import { emit, sortFindings, state } from "./store.js";

// Static imports, so Vite resolves and inlines the fixture text. Safe to be
// static: this module is only reachable through a dynamic import guarded by
// `import.meta.env.DEV`, so none of it is referenced by a release build.
import mainActivity from "../test-fixtures/SampleAndroidApp/MainActivity.java?raw";
import syncService from "../test-fixtures/SampleAndroidApp/SyncService.java?raw";
import locationTracker from "../test-fixtures/SampleAndroidApp/LocationTracker.java?raw";

const FIXTURES: ReadonlyArray<readonly [name: string, content: string]> = [
  ["MainActivity.java", mainActivity],
  ["SyncService.java", syncService],
  ["LocationTracker.java", locationTracker],
];

/** True when running outside the Tauri shell, where IPC is unavailable. */
export function isBrowserPreview(): boolean {
  return !("__TAURI_INTERNALS__" in window);
}

export async function mountPreview(): Promise<void> {
  const files: FileContent[] = FIXTURES.map(([name, content]) => ({
    path: `C:\\preview\\SampleAndroidApp\\${name}`,
    content,
    language: "java" as const,
  }));

  state.projectPath = "C:\\preview\\SampleAndroidApp";
  state.files = files;
  state.analyzing = true;

  const chip = qs("project-chip");
  chip.hidden = false;
  qs("project-name").textContent = "SampleAndroidApp";
  qs("project-meta").textContent = `${files.length} files · 0 kt`;
  qs("landing").dataset.open = "false";
  qsButton("btn-analyze").disabled = false;
  qsButton("btn-start-profile").disabled = false;
  qsInput("input-file-search").disabled = false;
  qsInput("input-findings-search").disabled = false;

  const graph = buildCallGraph(files);
  const findings = analyzeProject(files);
  state.callGraph = graph;
  state.findings = findings;
  sortFindings("severity", true);

  for (const finding of findings) {
    const chain = traceCallChain(finding, graph);
    if (chain.length) registerLocalChain(finding, chain);
  }

  state.grade = calculateGrade(findings, 0);
  state.analyzing = false;

  const worst = findings.findIndex((f) => f.severity === "Critical");
  if (worst >= 0) state.selectedIndex = worst;

  log("system", "Browser preview — indexed the repository's Java test fixtures.");
  log("info", `Preview analysis found ${findings.length} findings across ${files.length} files.`);
  notify(
    "info",
    "Browser preview",
    "Indexed the bundled Java fixtures so the workbench can be reviewed without the Tauri shell."
  );

  setProgressValue(1);
  setStatusText(`Grade ${state.grade?.letter ?? "—"} · preview`, { muted: false });

  // The palette indexes project files, so its command set is rebuilt whenever
  // the file list changes.
  document.dispatchEvent(new CustomEvent("ecotrace:files-changed"));

  // Re-render every view now that state has been seeded.
  emit("files", "findings", "grade", "selection", "device");
}
