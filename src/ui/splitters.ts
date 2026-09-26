/**
 * Pane splitters.
 *
 * A separator is only finished when it works without a mouse. Each splitter
 * here is a WAI-ARIA separator widget: pointer drag, arrow-key nudge, Home and
 * End to jump to the limits, and aria-valuenow kept in sync so the current
 * width is announced rather than merely visible.
 *
 * Widths persist per user. A tool that forgets your layout every launch is a
 * tool you reconfigure every launch.
 */

import { qsa } from "./dom.js";

const STORAGE_KEY = "ecotrace.panes.v1";

interface PaneWidths {
  nav: number;
  inspector: number;
}

const LIMITS: Record<string, { min: number; max: number; varName: string }> = {
  nav: { min: 240, max: 560, varName: "--pane-nav" },
  inspector: { min: 320, max: 720, varName: "--pane-inspector" },
};

const DEFAULT_WIDTHS: PaneWidths = { nav: 300, inspector: 420 };

let widths: PaneWidths = { ...DEFAULT_WIDTHS };

function clamp(value: number, pane: string): number {
  const limit = LIMITS[pane];
  return Math.max(limit.min, Math.min(limit.max, Math.round(value)));
}

function load(): PaneWidths {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_WIDTHS };
    const parsed = JSON.parse(raw) as Partial<PaneWidths>;
    return {
      nav: clamp(Number(parsed.nav) || DEFAULT_WIDTHS.nav, "nav"),
      inspector: clamp(
        Number(parsed.inspector) || DEFAULT_WIDTHS.inspector,
        "inspector"
      ),
    };
  } catch {
    return { ...DEFAULT_WIDTHS };
  }
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // A read-only profile directory must not break resizing.
  }
}

function apply(): void {
  const root = document.documentElement;
  for (const [pane, width] of Object.entries(widths)) {
    root.style.setProperty(LIMITS[pane].varName, `${width}px`);
  }
  for (const splitter of qsa<HTMLElement>(".cx-splitter")) {
    const pane = splitter.dataset.pane;
    if (!pane) continue;
    splitter.setAttribute("aria-valuenow", String(widths[pane as keyof PaneWidths]));
  }
}

export function paneWidth(pane: keyof PaneWidths): number {
  return widths[pane];
}

export function initSplitters(): void {
  widths = load();
  apply();

  for (const splitter of qsa<HTMLElement>(".cx-splitter")) {
    const pane = splitter.dataset.pane as keyof PaneWidths | undefined;
    if (!pane || !(pane in LIMITS)) continue;

    splitter.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      splitter.setPointerCapture(event.pointerId);
      splitter.dataset.dragging = "true";
      document.body.dataset.resizing = "true";

      // The inspector grows leftwards, so its sign is inverted relative to the
      // navigator. Capturing the sign once avoids a per-move branch.
      const sign = pane === "inspector" ? -1 : 1;
      const originX = event.clientX;
      const originWidth = widths[pane];

      const onMove = (move: PointerEvent): void => {
        widths[pane] = clamp(originWidth + (move.clientX - originX) * sign, pane);
        apply();
      };

      const onUp = (): void => {
        splitter.releasePointerCapture(event.pointerId);
        delete splitter.dataset.dragging;
        delete document.body.dataset.resizing;
        splitter.removeEventListener("pointermove", onMove);
        splitter.removeEventListener("pointerup", onUp);
        splitter.removeEventListener("pointercancel", onUp);
        save();
      };

      splitter.addEventListener("pointermove", onMove);
      splitter.addEventListener("pointerup", onUp);
      splitter.addEventListener("pointercancel", onUp);
    });

    splitter.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 32 : 8;
      let next = widths[pane];

      switch (event.key) {
        case "ArrowLeft":
          next = widths[pane] - (pane === "inspector" ? -step : step);
          break;
        case "ArrowRight":
          next = widths[pane] + (pane === "inspector" ? -step : step);
          break;
        case "Home":
          next = LIMITS[pane].min;
          break;
        case "End":
          next = LIMITS[pane].max;
          break;
        case "Enter":
          next = DEFAULT_WIDTHS[pane];
          break;
        default:
          return;
      }

      event.preventDefault();
      widths[pane] = clamp(next, pane);
      apply();
      save();
    });

    // Double-click restores the default width: a conventional, discoverable
    // reset that does not need a menu entry.
    splitter.addEventListener("dblclick", () => {
      widths[pane] = DEFAULT_WIDTHS[pane];
      apply();
      save();
    });
  }

  // Layout is remembered across launches, but a window resize must still be
  // able to invalidate it.
  window.addEventListener("resize", apply);
}

export function resetPanes(): void {
  widths = { ...DEFAULT_WIDTHS };
  apply();
  save();
}
