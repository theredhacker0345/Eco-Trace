/**
 * Command palette.
 *
 * One modal search surface over the whole application, bound to Ctrl/Cmd+K. It
 * exists for three reasons that a toolbar cannot serve: the action set has
 * outgrown a header, a keyboard-first tool needs a keyboard-first entry point,
 * and — most usefully — a palette is where a shortcut gets *discovered*, since
 * every row shows its own accelerator.
 *
 * The command list is assembled from the same declarative spec as the keymap,
 * so what the palette advertises and what the keyboard actually does cannot
 * drift apart.
 */

import { esc, icon, qs } from "./dom.js";
import { fuzzyMatch, relPath } from "./format.js";
import { trapFocus, type FocusTrap } from "./focus.js";
import { state } from "./store.js";

export interface Command {
  id: string;
  label: string;
  group: string;
  icon: string;
  /** Rendered in the right-hand gutter; usually an accelerator. */
  hint?: string;
  /** Extra search terms that should match but are not displayed. */
  keywords?: string;
  disabled?: () => boolean;
  run: () => void;
}

let commands: Command[] = [];
let filtered: Command[] = [];
let cursor = 0;
let trap: FocusTrap | null = null;
let lastFocus: HTMLElement | null = null;

const overlay = () => qs("palette-overlay");
const input = () => qs<HTMLInputElement>("palette-input");
const list = () => qs("palette-list");

export function setCommands(next: Command[]): void {
  commands = next;
}

export function isOpen(): boolean {
  return overlay().dataset.open === "true";
}

export function openPalette(): void {
  if (isOpen()) return;
  lastFocus = document.activeElement as HTMLElement | null;
  const root = overlay();
  root.dataset.open = "true";
  const field = input();
  field.value = "";
  refresh();
  trap = trapFocus(root);
}

export function closePalette(): void {
  if (!isOpen()) return;
  overlay().dataset.open = "false";
  trap?.release();
  trap = null;
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
}

function matches(command: Command, needle: string): boolean {
  return (
    fuzzyMatch(command.label, needle) ||
    fuzzyMatch(command.group, needle) ||
    fuzzyMatch(command.keywords ?? "", needle)
  );
}

function refresh(): void {
  const needle = input().value.trim();
  filtered = commands.filter(
    (c) => !c.disabled?.() && matches(c, needle)
  );
  cursor = 0;

  if (filtered.length === 0) {
    list().innerHTML = `<p class="cx-palette__empty">No command matches “${esc(needle)}”.</p>`;
    return;
  }

  let lastGroup = "";
  const rows: string[] = [];
  filtered.forEach((command, index) => {
    if (command.group !== lastGroup) {
      lastGroup = command.group;
      rows.push(`<div class="cx-palette__group">${esc(command.group)}</div>`);
    }
    rows.push(`
      <div class="cx-palette__item" role="option" id="palette-opt-${index}"
           aria-selected="${index === 0}" data-index="${index}">
        <svg class="cx-palette__item-icon" aria-hidden="true"><use href="#i-${command.icon}" /></svg>
        <span class="cx-palette__item-label">${esc(command.label)}</span>
        ${command.hint ? `<span class="cx-palette__item-hint">${esc(command.hint)}</span>` : ""}
      </div>`);
  });
  list().innerHTML = rows.join("");
}

function move(delta: number): void {
  if (filtered.length === 0) return;
  cursor = (cursor + delta + filtered.length) % filtered.length;
  const options = Array.from(
    list().querySelectorAll<HTMLElement>('[role="option"]')
  );
  for (const option of options) {
    const index = Number(option.dataset.index);
    const selected = index === cursor;
    option.setAttribute("aria-selected", String(selected));
    if (selected) {
      option.scrollIntoView({ block: "nearest" });
      input().setAttribute("aria-activedescendant", option.id);
    }
  }
}

function commit(): void {
  const command = filtered[cursor];
  closePalette();
  command?.run();
}

export function initPalette(): void {
  const field = input();

  field.addEventListener("input", refresh);

  field.addEventListener("keydown", (event) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "Home":
        event.preventDefault();
        cursor = 0;
        move(0);
        break;
      case "End":
        event.preventDefault();
        cursor = filtered.length - 1;
        move(0);
        break;
      case "Enter":
        event.preventDefault();
        commit();
        break;
      case "Escape":
        event.preventDefault();
        closePalette();
        break;
      default:
        break;
    }
  });

  list().addEventListener("click", (event) => {
    const option = (event.target as HTMLElement).closest<HTMLElement>('[role="option"]');
    if (!option) return;
    cursor = Number(option.dataset.index);
    commit();
  });

  list().addEventListener("mousemove", (event) => {
    const option = (event.target as HTMLElement).closest<HTMLElement>('[role="option"]');
    if (!option) return;
    const index = Number(option.dataset.index);
    if (index === cursor) return;
    cursor = index;
    move(0);
  });

  overlay().addEventListener("click", (event) => {
    if (event.target === overlay()) closePalette();
  });

  qs("btn-command-palette").addEventListener("click", openPalette);
}

/** Command entries derived from indexed project files, for jump-to-file. */
export function fileCommands(onPick: (absPath: string) => void): Command[] {
  return state.files.slice(0, 400).map((file) => {
    const rel = relPath(file.path, state.projectPath);
    return {
      id: `file:${file.path}`,
      label: rel,
      group: "Go to file",
      icon: "file",
      keywords: rel.split(/[\\/]/).join(" "),
      run: () => onPick(file.path),
    };
  });
}

export { icon };
