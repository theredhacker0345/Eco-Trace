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
  /**
   * Echoed back with the result. The worker is pooled and can have more than
   * one scan in flight, so the response id is what lets the runner's promise
   * pick out its own answer instead of settling on the first one to arrive.
   */
  id: number;
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

/**
 * Registered only inside a real worker scope.
 *
 * runner.ts dynamically imports this module on the *main* thread to reach
 * `analyzeInProcess` for the inline fallback. At module scope that used to
 * attach the listener to `window`, where any `window.postMessage({type:
 * "analyze"})` — a dev-tool nudge, an extension, an unrelated page script —
 * would kick off a full analysis on the UI thread. The export stays available
 * to the fallback; only the listener is worker-only.
 *
 * The canonical test is `typeof WorkerGlobalScope !== "undefined" && self
 * instanceof WorkerGlobalScope`, but this project's tsconfig lib is DOM-only
 * and `WorkerGlobalScope` is declared in lib.webworker, so it is not a name
 * TypeScript knows here. The equivalent, typed test: a worker global has
 * `self` and no `document`, a window has both.
 */
const inWorkerScope =
  typeof self !== "undefined" && typeof self.document === "undefined";

if (inWorkerScope) {
  self.addEventListener("message", (event: MessageEvent<AnalysisRequest>) => {
    const request = event.data;
    if (!request || request.type !== "analyze") return;
    try {
      const result = analyzeInProcess(request.files);
      (self as unknown as Worker).postMessage({ ok: true, id: request.id, result });
    } catch (err) {
      (self as unknown as Worker).postMessage({
        ok: false,
        id: request.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
