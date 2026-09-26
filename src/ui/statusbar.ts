/**
 * Status bar.
 *
 * The bottom strip answers, at all times and without a click: what grade the
 * project earned, what the measured drain rate is, how many findings of each
 * severity exist, whether anything is running, and what the keyboard can do.
 *
 * The three weighted sub-scores live in the table's summary bar rather than
 * here, because the status bar has to stay on one line at 32px. What belongs
 * on a single line is the verdict; what belongs beside the data is the
 * reasoning behind it.
 */

import { qs } from "./dom.js";
import { countBySeverity, state, subscribe } from "./store.js";

const BAND: Record<string, string> = {
  "A+": "aplus",
  A: "a",
  B: "b",
  C: "c",
  D: "d",
  F: "f",
};

const BAR_COLOUR: Record<string, string> = {
  success: "var(--cx-success)",
  medium: "var(--cx-medium)",
  high: "var(--cx-high)",
  critical: "var(--cx-critical)",
};

function bandColour(score: number): string {
  if (score >= 85) return "success";
  if (score >= 70) return "medium";
  if (score >= 50) return "high";
  return "critical";
}

function renderVitals(): void {
  const grade = state.grade;
  const badge = qs("grade-badge");

  if (grade) {
    badge.dataset.band = BAND[grade.letter] ?? "none";
    badge.textContent = grade.letter;
    const fill = qs<HTMLElement>("grade-fill");
    fill.style.width = `${grade.numericScore}%`;
    fill.style.background = BAR_COLOUR[bandColour(grade.numericScore)];
    qs("vitals-score").textContent = `${grade.numericScore}/100`;
  } else {
    badge.dataset.band = "none";
    badge.textContent = "—";
    const fill = qs<HTMLElement>("grade-fill");
    fill.style.width = "0%";
    fill.style.background = BAR_COLOUR.success;
    qs("vitals-score").textContent = "—";
  }

  qs("vitals-drain").textContent =
    grade && grade.drainRateMahPerMin > 0
      ? `${grade.drainRateMahPerMin.toFixed(2)} mAh/min`
      : "—";

  const tally = countBySeverity(state.findings);

  const critical = qs("vitals-critical");
  critical.textContent = String(tally.critical);
  critical.classList.toggle("cx-statusbar__value--critical", tally.critical > 0);

  const high = qs("vitals-high");
  high.textContent = String(tally.high);
  high.classList.toggle("cx-statusbar__value--high", tally.high > 0);

  qs("vitals-medium").textContent = String(tally.medium);
  qs("vitals-files").textContent = String(state.files.length);

  const exportBtn = qs<HTMLButtonElement>("btn-export");
  const noScan = state.findings.length === 0;
  exportBtn.disabled = noScan;
  exportBtn.title = noScan
    ? "Run an analysis first"
    : "Write a self-contained HTML report";

  // The PDF and browser actions are gated on exactly the same condition, so
  // they are enabled together. Leaving one of the three live while the others
  // are dead reads as a broken button rather than as a deliberate gate.
  const pdfBtn = qs<HTMLButtonElement>("btn-export-pdf");
  pdfBtn.disabled = noScan;
  pdfBtn.title = noScan ? "Run an analysis first" : "Print to a PDF (Ctrl+Shift+E)";

  const openBtn = qs<HTMLButtonElement>("btn-export-open");
  openBtn.disabled = noScan;
  openBtn.title = noScan
    ? "Run an analysis first"
    : "Open the report in your browser (Ctrl+Shift+P)";
}

function setStatus(text: string, muted = true): void {
  const el = qs("vitals-status");
  el.textContent = text;
  el.classList.toggle("cx-statusbar__value--muted", muted);
}

function setProgress(fraction: number, indeterminate = false): void {
  const bar = qs<HTMLElement>("scan-progress-bar");
  const wrap = qs("scan-progress-wrap");
  if (indeterminate) {
    wrap.classList.add("cx-progress--indeterminate");
    return;
  }
  wrap.classList.remove("cx-progress--indeterminate");
  bar.style.width = `${Math.max(0, Math.min(100, fraction * 100))}%`;
}

/** Reports a long-running phase in the status bar and the log. */
export function setBusy(message: string): void {
  setProgress(0.5, true);
  setStatus(message, false);
}

export function setProgressValue(fraction: number): void {
  setProgress(fraction);
}

export function setStatusText(text: string, options: { muted?: boolean } = {}): void {
  setStatus(text, options.muted ?? true);
}

export function initStatusBar(): void {
  subscribe(["findings", "grade", "files", "busy"], renderVitals);
  setStatusText(
    state.projectPath ? "Ready" : "No project open"
  );
  setProgress(0);
  renderVitals();
}
