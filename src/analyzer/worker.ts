/**
 * Analysis worker.
 *
 * The detector set is 23 regex passes over every source file, plus a full call
 * graph build and a chain trace per finding. On a project the size of a real
 * app that is a second or more of solid CPU. Run on the UI thread it does not
 * merely delay the result — it freezes the window, so the progress bar that is
 * supposed to report the scan is the one thing that cannot update during it,
 * and the app looks hung rather than busy.
 *
 * So it runs here instead, and the workbench stays live: the run log scrolls,
 * the splitters drag, the table still sorts what has already been published.
 */

import { analyzeProject, buildCallGraph, traceCallChain } from "./static.js";
import type { ChainNode, FileContent, Finding } from "./static.js";

export interface AnalysisResult {
  findings: Finding[];
  /** Causal chain per finding, keyed by `rule|file|line`. */
  chains: Record<string, ChainNode[]>;
  elapsedMs: number;
}

export interface AnalysisRequest {
  type: "analyze";
  files: FileContent[];
}

/** Stable identity for a finding, shared with the store and the inspector. */
function identity(finding: Finding): string {
  return `${finding.patternId}|${finding.file}|${finding.line}`;
}

export function analyzeInProcess(files: FileContent[]): AnalysisResult {
  const started = performance.now();

  const graph = buildCallGraph(files);
  const findings = analyzeProject(files);

  // Chain every finding that has one, up front, so switching inspector tabs is
  // instant rather than re-walking the graph on each selection.
  const chains: Record<string, ChainNode[]> = {};
  for (const finding of findings) {
    const chain = traceCallChain(finding, graph);
    if (chain.length > 0) chains[identity(finding)] = chain;
  }

  return { findings, chains, elapsedMs: Math.round(performance.now() - started) };
}

self.addEventListener("message", (event: MessageEvent<AnalysisRequest>) => {
  const request = event.data;
  if (!request || request.type !== "analyze") return;
  try {
    const result = analyzeInProcess(request.files);
    (self as unknown as Worker).postMessage({ ok: true, result });
  } catch (err) {
    (self as unknown as Worker).postMessage({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
