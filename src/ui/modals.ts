/**
 * Modal surfaces: settings and scan history.
 *
 * Both are Carbon composed modals — header, scrollable body, right-aligned
 * footer actions — with focus trapped while open and returned to the trigger
 * on close. Focus trapping is the single most-missed detail in a desktop app
 * with dialogs, and it is the reason a user tabbing through Settings does not
 * silently land in the inert workbench behind it.
 */

import type { ScanRecord } from "../grader/grade.js";
import { esc, icon, qs } from "./dom.js";
import { trapFocus, type FocusTrap } from "./focus.js";
import { dateTime, relPath } from "./format.js";

const traps = new WeakMap<HTMLElement, FocusTrap>();
const escapeHandlers = new WeakMap<HTMLElement, (event: KeyboardEvent) => void>();

function openModal(root: HTMLElement, onEscape: () => void): void {
  if (root.dataset.open === "true") return;
  root.dataset.open = "true";
  traps.set(root, trapFocus(root));

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onEscape();
    }
  };
  escapeHandlers.set(root, onKeydown);
  root.addEventListener("keydown", onKeydown);
}

function closeModal(root: HTMLElement): void {
  if (root.dataset.open !== "true") return;
  root.dataset.open = "false";

  const onKeydown = escapeHandlers.get(root);
  if (onKeydown) {
    root.removeEventListener("keydown", onKeydown);
    escapeHandlers.delete(root);
  }

  traps.get(root)?.release();
  traps.delete(root);
}

export function isModalOpen(root: HTMLElement): boolean {
  return root.dataset.open === "true";
}

export function closeSettings(): void {
  closeModal(qs("settings-overlay"));
}

export function openSettings(): void {
  openModal(qs("settings-overlay"), closeSettings);
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function bandFor(letter: string): string {
  switch (letter) {
    case "A+":
    case "A":
      return "aplus";
    case "B":
      return "b";
    case "C":
      return "c";
    case "D":
      return "d";
    case "F":
      return "f";
    default:
      return "none";
  }
}

export function renderHistory(records: readonly ScanRecord[]): void {
  const body = qs("history-body");
  const subtitle = qs("history-subtitle");

  if (records.length === 0) {
    subtitle.textContent = "No scans recorded yet.";
    body.innerHTML = `
      <div class="cx-empty">
        <svg class="cx-empty__art">${icon("history")}</svg>
        <span class="cx-empty__title">Nothing recorded yet</span>
        <p class="cx-empty__body">
          Every graded scan is written to this machine, so you can see whether a
          refactor actually moved the energy score.
        </p>
      </div>`;
    return;
  }

  subtitle.textContent = `${records.length} scan${records.length === 1 ? "" : "s"} recorded on this machine.`;

  // Oldest-first inside the list so the delta reads top to bottom as a trend,
  // while the newest stays the reference point for the first row's delta.
  const ordered = [...records].sort((a, b) => b.timestamp - a.timestamp);

  const rows = ordered
    .map((record, index) => {
      const previous = ordered[index + 1];
      const delta = previous ? record.grade.numericScore - previous.grade.numericScore : 0;
      const dir = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
      const glyph = delta > 0 ? `↑ +${delta}` : delta < 0 ? `↓ ${delta}` : "→ 0";
      const rel = relPath(record.projectPath, null);
      return `
        <div class="cx-history__row">
          <span class="cx-grade__letter" data-band="${bandFor(record.grade.letter)}">${esc(record.grade.letter)}</span>
          <span>
            <span class="cx-history__path" title="${esc(rel)}">${esc(rel)}</span><br>
            <span class="cx-history__date">${esc(dateTime(record.timestamp))} · ${record.totalFindings} findings · ${record.criticalFindings} critical</span>
          </span>
          <span class="cx-history__delta" data-dir="${dir}">${esc(glyph)}</span>
        </div>`;
    })
    .join("");

  body.innerHTML = `<div class="cx-history__list">${rows}</div>`;
}

export function openHistory(records: readonly ScanRecord[]): void {
  renderHistory(records);
  openModal(qs("history-overlay"), () => closeHistory());
}

export function closeHistory(): void {
  closeModal(qs("history-overlay"));
}

export function initModals(): void {
  const settings = qs("settings-overlay");
  const history = qs("history-overlay");

  for (const [root, closer] of [
    [settings, closeSettings],
    [history, closeHistory],
  ] as Array<[HTMLElement, () => void]>) {
    root.addEventListener("click", (event) => {
      if (event.target === root) closer();
    });
  }

  qs("btn-settings-close").addEventListener("click", closeSettings);
  qs("btn-settings-cancel").addEventListener("click", closeSettings);
  qs("btn-history-close").addEventListener("click", closeHistory);
}
