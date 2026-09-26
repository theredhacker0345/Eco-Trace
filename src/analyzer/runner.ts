/**
 * Analysis runner.
 *
 * Wraps the worker so callers get a promise and never see the difference
 * between "running off-thread" and "running here". The inline path is not a
 * test convenience: it is what runs when worker construction is unavailable,
 * and it is why a failure in the worker degrades to a slow scan rather than to
 * no scan.
 */

import type { FileContent } from "./static.js";
import type { AnalysisResult } from "./worker.js";

export type { AnalysisResult };

let worker: Worker | null = null;
let workerBroken = false;

/** Files in flight, so a second scan can be recognised as redundant. */
let inFlight = 0;

function ensureWorker(): Worker | null {
  if (workerBroken) return null;
  if (worker) return worker;
  try {
    // The extension is the source one, not the emitted one: Vite resolves the
    // `new URL(..., import.meta.url)` form at build time and emits the worker as
    // a separate hashed chunk.
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("error", () => {
      // A worker that fails to load takes every subsequent scan with it, so
      // the failure is latched and the next call goes inline.
      workerBroken = true;
      worker = null;
    });
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

export function runAnalysisInWorker(files: FileContent[]): Promise<AnalysisResult> {
  inFlight++;
  const pooled = ensureWorker();

  if (!pooled) return fallback(files);

  return new Promise<AnalysisResult>((resolve, reject) => {
    const settle = (fn: () => void): void => {
      inFlight = Math.max(0, inFlight - 1);
      fn();
    };

    const onMessage = (event: MessageEvent): void => {
      const data = event.data as { ok: boolean; result?: AnalysisResult; error?: string };
      pooled.removeEventListener("message", onMessage);
      pooled.removeEventListener("error", onError);
      settle(() => {
        if (data.ok && data.result) resolve(data.result);
        else reject(new Error(data.error ?? "analysis failed"));
      });
    };

    const onError = (): void => {
      pooled.removeEventListener("message", onMessage);
      pooled.removeEventListener("error", onError);
      settle(() => reject(new Error("analysis worker crashed")));
    };

    pooled.addEventListener("message", onMessage);
    pooled.addEventListener("error", onError);
    pooled.postMessage({ type: "analyze", files });
  }).catch(() => fallback(files));
}

async function fallback(files: FileContent[]): Promise<AnalysisResult> {
  const { analyzeInProcess } = await import("./worker.js");
  // Yield once so the status bar can paint "scanning" before the thread blocks.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return analyzeInProcess(files);
}

/** True while a scan is running on another thread. */
export function analysisInFlight(): boolean {
  return inFlight > 0;
}
