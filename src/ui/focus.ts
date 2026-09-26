/**
 * Focus management and keyboard-scoped widgets.
 *
 * Three utilities, each solving a problem that shows up immediately once a
 * desktop app has modal surfaces:
 *
 *  - trapFocus: Tab must not walk out of an open dialog into the inert app
 *    behind it, and focus must return to whatever opened it.
 *  - rovingFocus: composite widgets (tabs, listboxes) are a single tab stop
 *    with arrow-key movement inside, per WAI-ARIA.
 *  - shortcutKey: renders a shortcut as a human string and matches events
 *    against a declarative spec, so the keymap lives in one readable table
 *    instead of being scattered across listeners.
 */

import { qsa } from "./dom.js";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusable(root: ParentNode): HTMLElement[] {
  return qsa<HTMLElement>(FOCUSABLE, root).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );
}

export interface FocusTrap {
  release(): void;
}

/** Confines Tab to `root` and restores focus to the previously active element. */
export function trapFocus(root: HTMLElement): FocusTrap {
  const previous = document.activeElement as HTMLElement | null;

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== "Tab") return;
    const items = focusable(root);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || !root.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  document.addEventListener("keydown", onKeydown, true);

  // Move focus into the surface: the first control, or the surface itself if
  // it has no focusable children.
  const initial = focusable(root)[0] ?? root;
  if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
  initial.focus();

  return {
    release(): void {
      document.removeEventListener("keydown", onKeydown, true);
      if (previous && document.contains(previous)) previous.focus();
    },
  };
}

/**
 * Wires a WAI-ARIA tablist: roving tabindex, Left/Right/Home/End movement,
 * and activation on focus for the automatic variant.
 */
export function initTablist(container: HTMLElement, onChange?: (id: string) => void): void {
  const tabs = () =>
    qsa<HTMLButtonElement>('[role="tab"]', container).filter(
      (tab) => tab.offsetParent !== null || tab.getAttribute("aria-selected") === "true"
    );

  container.addEventListener("keydown", (event) => {
    const list = tabs();
    if (list.length === 0) return;
    const current = list.indexOf(document.activeElement as HTMLButtonElement);
    if (current === -1) return;

    let next = -1;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = (current + 1) % list.length;
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = (current - 1 + list.length) % list.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = list.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    list[next].focus();
    list[next].click();
    onChange?.(list[next].dataset.tab ?? "");
  });

  container.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
    if (!target) return;
    for (const tab of tabs()) {
      const selected = tab === target;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    onChange?.(target.dataset.tab ?? "");
  });
}

export interface Shortcut {
  /** Key as reported by KeyboardEvent.key, lower-cased for letters. */
  key: string;
  ctrlOrMeta?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** Human-readable form shown in the UI. */
  label: string;
  run(): void;
  /** Suppress while a text field owns the keyboard. */
  allowInInput?: boolean;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function keyChord(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("mod");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  parts.push(event.key.length === 1 ? event.key.toLowerCase() : event.key);
  return parts.join("+");
}

/**
 * Installs a global keymap. Shortcuts are declarative so the command palette
 * can list exactly the same set, which is what keeps the discoverable set and
 * the working set from diverging.
 */
export function installKeymap(shortcuts: Shortcut[]): void {
  // The same normalisation keyChord applies to real events — lowercase single
  // characters, named keys preserved — so a spec written as { key: "k" }
  // matches a physical Ctrl+K and renders as "Ctrl+K" in the UI.
  const byChord = new Map<string, Shortcut>();
  for (const shortcut of shortcuts) {
    byChord.set(chordOf(shortcut), shortcut);
  }

  document.addEventListener("keydown", (event) => {
    const chord = keyChord(event);
    const shortcut = byChord.get(chord);
    if (!shortcut) return;
    if (!shortcut.allowInInput && isTypingTarget(event.target)) return;
    // Never hijack a chord the host owns *and* that we have not bound. A bare
    // F5 is a reload in every host, so the analyzer is bound to it explicitly
    // and the guard below lets a registered F5 through — the previous version
    // returned on F5 unconditionally, which silently made the documented
    // "F5 analyze" shortcut unreachable. F12 stays unbound and is still the
    // host's.
    if (event.key === "F12") return;
    event.preventDefault();
    event.stopPropagation();
    shortcut.run();
  });
}

function chordOf(shortcut: Shortcut): string {
  const parts: string[] = [];
  if (shortcut.ctrlOrMeta) parts.push("mod");
  if (shortcut.alt) parts.push("alt");
  if (shortcut.shift) parts.push("shift");
  parts.push(shortcut.key.length === 1 ? shortcut.key.toLowerCase() : shortcut.key);
  return parts.join("+");
}

export { focusable, isTypingTarget };

/** Renders a shortcut as a kbd chip group. */
export function kbdHtml(label: string): string {
  return label
    .split("+")
    .map((part) => `<kbd>${part}</kbd>`)
    .join("");
}

/** Focuses the first focusable element inside a container, if there is one. */
export function focusFirst(root: ParentNode): void {
  focusable(root)[0]?.focus();
}
