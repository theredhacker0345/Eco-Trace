/**
 * Modal surfaces: the landing overlay, settings and scan history.
 *
 * Settings and scan history are both Carbon composed modals — header,
 * scrollable body, right-aligned footer actions — with focus trapped while
 * open and returned to the trigger on close. The landing overlay is the same
 * trap driven from the markup's own `data-open` flag. Focus trapping is the
 * single most-missed detail in a desktop app with dialogs, and it is the
 * reason a user tabbing through Settings does not silently land in the inert
 * workbench behind it.
 */

import type { ScanRecord } from "../grader/grade.js";
import { esc, icon, qs } from "./dom.js";
import { trapFocus, type FocusTrap } from "./focus.js";
import { dateTime, relPath } from "./format.js";

const traps = new WeakMap<HTMLElement, FocusTrap>();
const escapeHandlers = new WeakMap<HTMLElement, (event: KeyboardEvent) => void>();

// ---------------------------------------------------------------------------
// Landing overlay
// ---------------------------------------------------------------------------

/*
 * The start-up overlay is not a composed modal — it is static markup that is
 * open at load and dismissed by writing `data-open="false"` from two places
 * (the project loader and the demo mount) — so it cannot go through
 * `openModal`, which owns its own open/close transition. Instead the attribute
 * is watched, which means every dismissal path releases the trap and no caller
 * has to remember to.
 *
 * It is also the one surface that can have a modal opened *on top* of it
 * (Settings from the landing's own button), and two live focus traps fight
 * over Tab. `suspendLanding()` parks the overlay's trap while another modal
 * owns the surface and `resumeLanding()` takes it back afterwards.
 */
let landingRoot: HTMLElement | null = null;
let landingTrap: FocusTrap | null = null;
let landingSuspended = false;

function syncLanding(): void {
  const visible = landingRoot?.dataset.open === "true";
  const wanted = Boolean(visible) && !landingSuspended;

  if (wanted && !landingTrap && landingRoot) {
    const root = landingRoot;
    root.addEventListener("keydown", onLandingKeydown);
    landingTrap = trapFocus(root);
    // Focus the primary action: the reason the overlay is on screen is the one
    // button that gets the person past it. `trapFocus` would otherwise take
    // whichever control happens to come first in the markup.
    const primary = document.getElementById("btn-landing-open");
    if (primary instanceof HTMLButtonElement) primary.focus();
    return;
  }

  if (!wanted && landingTrap && landingRoot) {
    landingRoot.removeEventListener("keydown", onLandingKeydown);
    landingTrap.release();
    landingTrap = null;
  }
}

/** Escape dismisses the overlay exactly as the close control does. */
function onLandingKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.stopPropagation();
  dismissLanding();
}

/** Dismisses the overlay; the attribute watcher releases the trap. */
function dismissLanding(): void {
  if (landingRoot) landingRoot.dataset.open = "false";
}

/**
 * Hands the keyboard to another surface drawn over the landing overlay, and
 * takes it back afterwards. Exported for the command palette, which is bound
 * to a global key and can therefore open while the overlay is still up.
 */
export function suspendLanding(): void {
  if (!landingRoot || landingSuspended) return;
  landingSuspended = true;
  syncLanding();
}

/** Undoes `suspendLanding`, re-trapping the overlay if it is still visible. */
export function resumeLanding(): void {
  if (!landingSuspended) return;
  landingSuspended = false;
  syncLanding();
}

/** Wires the landing overlay: trap, Escape, and its close control. */
function initLanding(): void {
  landingRoot = qs("landing");
  landingSuspended = false;

  // Guarded: the close control belongs to the markup, and its absence must not
  // take the overlay down with it.
  document
    .getElementById("btn-landing-close")
    ?.addEventListener("click", dismissLanding);

  new MutationObserver(syncLanding).observe(landingRoot, {
    attributes: true,
    attributeFilter: ["data-open"],
  });
  syncLanding();
}

function openModal(root: HTMLElement, onEscape: () => void): void {
  if (root.dataset.open === "true") return;
  root.dataset.open = "true";
  // Park the landing trap before installing this one, so a single trap is
  // listening for Tab and the overlay cannot pull focus back out of a modal
  // opened on top of it.
  suspendLanding();
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

  // If this modal was opened over the landing overlay, the overlay is still
  // there and still has to hold focus.
  resumeLanding();
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
  initLanding();

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
