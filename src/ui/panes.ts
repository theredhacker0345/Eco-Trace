/**
 * Responsive pane behaviour.
 *
 * The workbench is a three-pane layout, which is correct for the window size it
 * was designed for and wrong for every other size. Rather than degrade the
 * layout continuously, the panes cross a threshold: below 1280px the inspector
 * stops competing for width and becomes an overlay sheet, and below 960px the
 * navigator does the same.
 *
 * Promoting a pane to an overlay is only half the work — the other half is
 * making sure it stays reachable. That is what the two header disclosure
 * buttons are for, and why selecting a finding opens the inspector
 * automatically once it is a sheet: the user's next action after choosing a row
 * is always to read it.
 */

import { qs, qsButton } from "./dom.js";

const NAV_OVERLAY = "(max-width: 960px)";
const INSPECTOR_OVERLAY = "(max-width: 1280px)";

const nav = qs("panel-navigator");
const inspector = qs("panel-fix");

const inspectorIsSheet = (): boolean =>
  window.matchMedia(INSPECTOR_OVERLAY).matches;

function setSheet(pane: HTMLElement, open: boolean, button: HTMLElement): void {
  if (open) pane.setAttribute("data-overlay-open", "true");
  else pane.removeAttribute("data-overlay-open");
  button.setAttribute("aria-expanded", String(open));
  button.title = open ? "Hide panel" : "Show panel";
  syncScrim();
}

/** Dims the work surface whenever a sheet is open over it. */
function syncScrim(): void {
  const anyOpen =
    nav.getAttribute("data-overlay-open") === "true" ||
    inspector.getAttribute("data-overlay-open") === "true";
  if (anyOpen) document.body.dataset.sheet = "true";
  else delete document.body.dataset.sheet;
}

export function initPanes(): void {
  const navButton = qsButton("btn-toggle-nav");
  const inspectorButton = qsButton("btn-toggle-inspector");

  navButton.addEventListener("click", () => {
    setSheet(nav, nav.getAttribute("data-overlay-open") !== "true", navButton);
  });

  inspectorButton.addEventListener("click", () => {
    setSheet(
      inspector,
      inspector.getAttribute("data-overlay-open") !== "true",
      inspectorButton
    );
  });

  // Leaving the overlay range while a pane is open would otherwise strand the
  // attribute and leave the header button reporting a state that no longer
  // exists.
  for (const [query, pane, button] of [
    [NAV_OVERLAY, nav, navButton],
    [INSPECTOR_OVERLAY, inspector, inspectorButton],
  ] as Array<[string, HTMLElement, HTMLElement]>) {
    window.matchMedia(query).addEventListener("change", (event) => {
      if (!event.matches) setSheet(pane, false, button);
    });
  }

  // Reading a finding is the reason the inspector exists, so opening it is
  // part of selecting one — but only once it is a sheet, because an inline
  // pane is always visible already.
  document.addEventListener("ecotrace:selection-changed", () => {
    if (inspectorIsSheet() && document.getElementById("finding-detail")?.hidden === false) {
      setSheet(inspector, true, inspectorButton);
    }
  });

  // Escape closes whichever sheet is open, so the keyboard has a way out that
  // does not depend on knowing a header button exists.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (nav.getAttribute("data-overlay-open") === "true") {
      setSheet(nav, false, navButton);
      return;
    }
    if (inspector.getAttribute("data-overlay-open") === "true") {
      setSheet(inspector, false, inspectorButton);
    }
  });

  // Clicking the scrim is a dismissal, which is the conventional expectation
  // for a sheet and saves hunting for the disclosure button.
  document.body.addEventListener("click", (event) => {
    if (event.target !== document.body) return;
    if (nav.getAttribute("data-overlay-open") === "true") setSheet(nav, false, navButton);
    else if (inspector.getAttribute("data-overlay-open") === "true") {
      setSheet(inspector, false, inspectorButton);
    }
  });
}
