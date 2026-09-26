/**
 * DOM primitives.
 *
 * The one non-negotiable rule in this file: element lookups fail loudly. A
 * missing id means the markup and the behaviour have drifted apart, and a
 * silent null would turn that into a mysterious runtime failure deep inside an
 * event handler. Failing at module load turns it into an immediate, named
 * error.
 */

export function qs<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(
      `EcoTrace UI contract violation: #${id} is missing from index.html`
    );
  }
  return el as T;
}

export function qsa<T extends HTMLElement = HTMLElement>(
  selector: string,
  root: ParentNode = document
): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

/** Typed lookups for the three control types whose properties are mutated. */
export function qsButton(id: string): HTMLButtonElement {
  return qs<HTMLButtonElement>(id);
}

export function qsInput(id: string): HTMLInputElement {
  return qs<HTMLInputElement>(id);
}

export function qsSelect(id: string): HTMLSelectElement {
  return qs<HTMLSelectElement>(id);
}

const ICON_SIZES = new Set(["", " i--sm", " i--xs", " i--lg", " i--xl"]);

/**
 * Returns markup for a glyph from the sprite declared in index.html.
 * Every icon in the application goes through here, which is what guarantees
 * the single grid alignment and single colour mechanism.
 */
export function icon(name: string, size: "" | "i--sm" | "i--xs" | "i--lg" | "i--xl" = ""): string {
  if (!ICON_SIZES.has(size === "" ? "" : ` ${size}`)) {
    throw new Error(`Unknown icon size: ${size}`);
  }
  return `<svg class="i${size}" aria-hidden="true"><use href="#i-${name}" /></svg>`;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for interpolation into an HTML template string. */
export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/** Types an element as a checkbox input without a cast at every call site. */
export function asCheckbox(el: HTMLElement): HTMLInputElement {
  return el as HTMLInputElement;
}

export function setHidden(el: HTMLElement, hidden: boolean): void {
  el.hidden = hidden;
}

export function toggleClass(
  el: Element,
  className: string,
  on: boolean
): void {
  el.classList.toggle(className, on);
}

/**
 * Splits text into one block element per line, for guttered code rendering.
 * Empty lines keep a block so the line counter stays aligned with the source.
 */
export function codeLines(text: string): string {
  return text
    .replace(/\t/g, "    ")
    .split(/\r?\n/)
    .map(
      (line) =>
        `<span class="cx-code__line${line.length === 0 ? " cx-code__line--empty" : ""}">${esc(line) || "&nbsp;"}</span>`
    )
    .join("");
}

/** Writes guttered code into a <pre>, replacing whatever was there. */
export function renderCode(el: HTMLElement, text: string): void {
  el.innerHTML = codeLines(text);
}
