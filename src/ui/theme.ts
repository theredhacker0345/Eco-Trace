/**
 * Carbon theme selection.
 *
 * EcoTrace is built on the IBM Carbon Design System, which ships four themes
 * over one shared token set. Because every surface, border and text colour in
 * the stylesheet resolves to a `--cds-*` custom property, switching theme is
 * a single attribute on the document root — no component rule changes, no
 * re-render, no flash.
 *
 * The choice persists, and it is a real product setting rather than a novelty:
 * Carbon's dark themes are tuned for long sessions in low light, and its light
 * theme exists for printed and shared material.
 */

import { qs } from "./dom.js";

export type CarbonTheme = "g100" | "g90" | "white";

const STORAGE_KEY = "ecotrace.theme";
const THEMES: CarbonTheme[] = ["g100", "g90", "white"];

export const THEME_LABELS: Record<CarbonTheme, string> = {
  g100: "Gray 100 — highest contrast dark",
  g90: "Gray 90 — softer dark",
  white: "White — light",
};

function isTheme(value: string | null): value is CarbonTheme {
  return value !== null && (THEMES as string[]).includes(value);
}

export function currentTheme(): CarbonTheme {
  const stored = localStorage.getItem(STORAGE_KEY);
  return isTheme(stored) ? stored : "g100";
}

export function applyTheme(theme: CarbonTheme): void {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Non-fatal: the theme still applies for this session.
  }
  const select = document.getElementById("input-theme");
  if (select instanceof HTMLSelectElement) select.value = theme;
}

export function initTheme(): void {
  const theme = currentTheme();
  applyTheme(theme);

  qs<HTMLSelectElement>("input-theme").addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    if (isTheme(value)) applyTheme(value);
  });
}

export function nextTheme(): CarbonTheme {
  const index = THEMES.indexOf(currentTheme());
  return THEMES[(index + 1) % THEMES.length];
}
