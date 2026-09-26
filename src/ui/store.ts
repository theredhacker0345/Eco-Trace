/**
 * Shared application state and a minimal event bus.
 *
 * The UI is a set of independent views (navigator, findings table, inspector,
 * run log, status bar) that all read from the same scan result. Rather than
 * threading a dozen callbacks through every constructor, state lives here and
 * views re-render on events. That keeps each view module a pure function of
 * state plus its own local interaction state (query, sort, expansion), which
 * is what makes the panels independently testable and independently
 * re-skinnable.
 */

import type { FileContent, Finding } from "../analyzer/static.js";
import type { GradeResult } from "../grader/grade.js";
import { getDefaultSettings, type AppSettings } from "../settings.js";

export type LogLevel =
  | "critical"
  | "high"
  | "medium"
  | "info"
  | "success"
  | "system";

export type DeviceState = "idle" | "arming" | "profiling" | "error";

export type UiEvent =
  | "files"
  | "findings"
  | "selection"
  | "grade"
  | "log"
  | "busy"
  | "settings"
  | "device";

export interface AppState {
  projectPath: string | null;
  files: FileContent[];
  findings: Finding[];
  grade: GradeResult | null;
  /** Index into `findings`, or -1 when nothing is selected. */
  selectedIndex: number;
  /** Absolute path of the file the user scoped the table to, if any. */
  selectedFile: string | null;
  analyzing: boolean;
  settings: AppSettings;
  device: DeviceState;
  /**
   * Application ids declared by the project's AndroidManifest.xml, used to
   * attribute measured drain to the app under test rather than to the device
   * as a whole.
   */
  manifestPackageNames: string[];
}

export const state: AppState = {
  projectPath: null,
  files: [],
  findings: [],
  grade: null,
  selectedIndex: -1,
  selectedFile: null,
  analyzing: false,
  settings: getDefaultSettings(),
  device: "idle",
  manifestPackageNames: [],
};

type Handler = () => void;

const handlers = new Map<UiEvent, Set<Handler>>();

/** Subscribes to one or more state events. Returns an unsubscribe function. */
export function subscribe(events: UiEvent[], handler: Handler): () => void {
  for (const evt of events) {
    let set = handlers.get(evt);
    if (!set) {
      set = new Set();
      handlers.set(evt, set);
    }
    set.add(handler);
  }
  return () => {
    for (const evt of events) handlers.get(evt)?.delete(handler);
  };
}

/** Notifies subscribers. Multiple events are dispatched in order. */
export function emit(...events: UiEvent[]): void {
  const called = new Set<Handler>();
  for (const evt of events) {
    for (const handler of handlers.get(evt) ?? []) {
      if (called.has(handler)) continue;
      called.add(handler);
      handler();
    }
  }
}

export function selectedFinding(): Finding | null {
  const { findings, selectedIndex } = state;
  if (selectedIndex < 0 || selectedIndex >= findings.length) return null;
  return findings[selectedIndex];
}

/** Absolute path of the finding currently under inspection, if any. */
export function selectedFindingFile(): string | null {
  return selectedFinding()?.file ?? null;
}

export function countBySeverity(
  findings: readonly Finding[]
): Record<LogLevel, number> {
  const tally: Record<LogLevel, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    info: 0,
    success: 0,
    system: 0,
  };
  for (const f of findings) {
    const key = f.severity.toLowerCase() as LogLevel;
    tally[key] = (tally[key] ?? 0) + 1;
  }
  return tally;
}

export type SortKey = "severity" | "pattern" | "file" | "category";

const SEVERITY_RANK: Record<string, number> = { Critical: 0, High: 1, Medium: 2 };

/**
 * Sorts the canonical finding list in place.
 *
 * Sorting the array itself rather than a copy is deliberate: `selectedIndex`
 * is an index into this array, and the inspector shows it to the user as a
 * position. If the table sorted a derived copy instead, the row a user is
 * looking at and the "4 / 11" in the inspector would disagree whenever the
 * display order differed from the stored order — which is exactly the kind of
 * small lie that makes a tool feel untrustworthy.
 */
export function sortFindings(key: SortKey, ascending: boolean): void {
  const direction = ascending ? 1 : -1;
  const project = (finding: Finding): string => finding.file;

  state.findings.sort((a, b) => {
    let delta = 0;
    switch (key) {
      case "severity":
        delta =
          (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
        if (delta === 0) delta = a.patternId.localeCompare(b.patternId);
        break;
      case "pattern":
        delta = a.patternName.localeCompare(b.patternName);
        break;
      case "category":
        delta = a.category.localeCompare(b.category);
        if (delta === 0) delta = a.patternId.localeCompare(b.patternId);
        break;
      case "file":
        delta = project(a).localeCompare(project(b));
        if (delta === 0) delta = a.line - b.line;
        break;
    }
    return delta * direction;
  });
}
