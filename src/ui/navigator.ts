/**
 * Project navigator.
 *
 * A file tree at the density of Carbon's UI shell left panel, with the parts
 * that make it a tool rather than a list: grouping by directory with
 * disclosure state, per-file severity and count, a name filter, and a severity
 * filter shared with the findings table.
 *
 * Keyboard model follows the WAI-ARIA tree pattern — Up/Down move between
 * visible items, Right/Left expand and collapse, Home/End jump to the ends,
 * Enter activates. A file list is a tree, and the tree pattern is what a
 * keyboard user already knows.
 */

import type { Finding } from "../analyzer/static.js";
import { esc, icon, qs, qsa } from "./dom.js";
import { fileExt, fileName, relPath } from "./format.js";
import { countBySeverity, emit, state, subscribe } from "./store.js";

/** Severities the user has switched on. Shared with the findings table. */
export const activeSeverities = new Set(["critical", "high", "medium"]);

interface TreeFile {
  path: string;
  name: string;
  rel: string;
  ext: string;
  severity: "critical" | "high" | "medium" | null;
  count: number;
}

interface TreeGroup {
  dir: string;
  files: TreeFile[];
  collapsed: boolean;
}

let query = "";
let groups: TreeGroup[] = [];
let flatRows: HTMLElement[] = [];
let listEl: HTMLElement | null = null;

function severityRank(sev: "critical" | "high" | "medium" | null): number {
  return sev === "critical" ? 0 : sev === "high" ? 1 : sev === "medium" ? 2 : 3;
}

/** Rebuilds the tree from state, preserving collapsed directories. */
function build(): void {
  const findingsByFile = new Map<string, Finding[]>();
  for (const finding of state.findings) {
    const list = findingsByFile.get(finding.file) ?? [];
    list.push(finding);
    findingsByFile.set(finding.file, list);
  }

  const collapsedPreviously = new Set(
    groups.filter((g) => g.collapsed).map((g) => g.dir)
  );

  const byDir = new Map<string, TreeFile[]>();
  const q = query.trim().toLowerCase();

  for (const file of state.files) {
    const rel = relPath(file.path, state.projectPath);
    if (q && !rel.toLowerCase().includes(q)) continue;

    const findings = (findingsByFile.get(file.path) ?? []).filter((f) =>
      activeSeverities.has(f.severity.toLowerCase())
    );
    const worst = findings.length
      ? [...findings].sort(
          (a, b) => severityRank(a.severity.toLowerCase() as never) - severityRank(b.severity.toLowerCase() as never)
        )[0]
      : null;

    const entry: TreeFile = {
      path: file.path,
      name: fileName(file.path),
      rel,
      ext: fileExt(file.path),
      severity: worst ? (worst.severity.toLowerCase() as TreeFile["severity"]) : null,
      count: findings.length,
    };

    // Flagged files float to the top of their directory: during triage the
    // question is always "what is broken", not "what is alphabetically first".
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
    const bucket = byDir.get(dir) ?? [];
    bucket.push(entry);
    byDir.set(dir, bucket);
  }

  groups = [...byDir.entries()]
    .map(([dir, files]) => ({
      dir,
      files: files.sort(
        (a, b) =>
          severityRank(b.severity) - severityRank(a.severity) ||
          b.count - a.count ||
          a.name.localeCompare(b.name)
      ),
      collapsed: collapsedPreviously.has(dir),
    }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

function dirLabel(dir: string): string {
  if (!dir) return "project root";
  const parts = dir.split("/");
  return parts[parts.length - 1] === "java" ? parts.slice(-3).join("/") : parts.slice(-2).join("/");
}

function fileMarkup(file: TreeFile): string {
  const selected = state.selectedFile === file.path || state.selectedIndex >= 0
    ? file.path === (state.findings[state.selectedIndex]?.file ?? "")
    : false;
  const count = file.count
    ? `<span class="cx-tree__n">${file.count}</span>`
    : "";
  return `
    <button class="cx-tree__file" role="treeitem" data-path="${esc(file.path)}"
            data-severity="${file.severity ?? "none"}"
            data-selected="${selected}" aria-level="2" tabindex="-1">
      <span class="cx-tree__sev"></span>
      <span class="cx-tree__name">${esc(file.name)}</span>
      <span class="cx-tree__ext">${esc(file.ext)}</span>
      ${count}
    </button>`;
}

function groupMarkup(group: TreeGroup): string {
  const flagged = group.files.reduce((total, f) => total + f.count, 0);
  return `
    <div class="cx-tree__group" data-collapsed="${group.collapsed}">
      <button class="cx-tree__dir" role="treeitem" aria-expanded="${!group.collapsed}"
              aria-level="1" data-dir="${esc(group.dir)}" tabindex="-1">
        <svg class="cx-tree__chevron" aria-hidden="true"><use href="#i-chevron-down" /></svg>
        <span class="cx-tree__dirname">${esc(dirLabel(group.dir))}</span>
        ${flagged ? `<span class="cx-count cx-count--quiet">${flagged}</span>` : ""}
      </button>
      <div class="cx-tree__files" role="group">${group.files.map(fileMarkup).join("")}</div>
    </div>`;
}

function render(): void {
  if (!listEl) return;
  build();

  if (state.files.length === 0) {
    listEl.hidden = true;
    qs("file-tree-empty").hidden = false;
    flatRows = [];
    return;
  }

  listEl.hidden = false;
  qs("file-tree-empty").hidden = true;

  if (groups.length === 0) {
    listEl.innerHTML = `
      <div class="cx-empty">
        <svg class="cx-empty__art">${use("search")}</svg>
        <span class="cx-empty__title">No files match</span>
        <p class="cx-empty__body">
          ${query ? `Nothing matches “${esc(query)}”.` : "No files remain under the active filters."}
        </p>
      </div>`;
    flatRows = [];
    return;
  }

  listEl.innerHTML = groups.map(groupMarkup).join("");
  flatRows = visibleRows();
  syncSelection();
}

/** `<use>` needs to be resolved inside a template literal without a wrapper. */
function use(name: string): string {
  return `<use href="#i-${name}" />`;
}

function visibleRows(): HTMLElement[] {
  if (!listEl) return [];
  return qsa<HTMLElement>(".cx-tree__dir, .cx-tree__file", listEl).filter((row) => {
    const group = row.closest<HTMLElement>(".cx-tree__group");
    return group?.dataset.collapsed !== "true";
  });
}

function syncSelection(): void {
  if (!listEl) return;
  const activeFile = state.findings[state.selectedIndex]?.file ?? null;
  for (const row of qsa<HTMLElement>(".cx-tree__file", listEl)) {
    const isActive = row.dataset.path === activeFile;
    const isScoped = row.dataset.path === state.selectedFile;
    row.dataset.selected = String(isActive || isScoped);
    row.setAttribute("aria-current", String(isScoped));
  }
}

/** Reveals a file in the tree: expands its directory and focuses the row. */
export function revealFile(absPath: string, focus = true): void {
  if (!listEl) return;
  const rel = relPath(absPath, state.projectPath);
  const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  const group = groups.find((g) => g.dir === dir);
  if (group) group.collapsed = false;
  render();

  const row = listEl.querySelector<HTMLElement>(
    `.cx-tree__file[data-path="${cssEscape(absPath)}"]`
  );
  if (row) {
    if (focus) row.focus();
    row.scrollIntoView({ block: "nearest" });
  }
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/"/g, '\\"');
}

function focusRow(row: HTMLElement | undefined): void {
  if (!row) return;
  for (const other of flatRows) other.tabIndex = -1;
  row.tabIndex = 0;
  row.focus();
}

function onKeydown(event: KeyboardEvent): void {
  const current = (event.target as HTMLElement).closest<HTMLElement>(
    ".cx-tree__dir, .cx-tree__file"
  );
  if (!current) return;
  const rows = visibleRows();
  const index = rows.indexOf(current);
  if (index === -1) return;

  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      focusRow(rows[Math.min(index + 1, rows.length - 1)]);
      break;
    case "ArrowUp":
      event.preventDefault();
      focusRow(rows[Math.max(index - 1, 0)]);
      break;
    case "Home":
      event.preventDefault();
      focusRow(rows[0]);
      break;
    case "End":
      event.preventDefault();
      focusRow(rows[rows.length - 1]);
      break;
    case "ArrowRight":
      if (current.classList.contains("cx-tree__dir") && current.getAttribute("aria-expanded") === "false") {
        event.preventDefault();
        current.click();
      } else {
        event.preventDefault();
        focusRow(rows[Math.min(index + 1, rows.length - 1)]);
      }
      break;
    case "ArrowLeft":
      if (current.classList.contains("cx-tree__dir") && current.getAttribute("aria-expanded") === "true") {
        event.preventDefault();
        current.click();
      } else {
        event.preventDefault();
        focusRow(rows[Math.max(index - 1, 0)]);
      }
      break;
    default:
      break;
  }
}

export function initNavigator(): void {
  listEl = qs("file-tree-list");

  const searchInput = qs<HTMLInputElement>("input-file-search");
  const searchClear = qs("btn-file-search-clear");
  const expandBtn = qs<HTMLButtonElement>("btn-tree-expand");
  const collapseBtn = qs<HTMLButtonElement>("btn-tree-collapse");

  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    searchClear.hidden = query.length === 0;
    render();
  });

  searchClear.addEventListener("click", () => {
    query = "";
    searchInput.value = "";
    searchClear.hidden = true;
    render();
    searchInput.focus();
  });

  expandBtn.addEventListener("click", () => {
    for (const group of groups) group.collapsed = false;
    render();
  });

  collapseBtn.addEventListener("click", () => {
    for (const group of groups) group.collapsed = true;
    render();
  });

  // Severity filter is shared with the findings table: one control, one state.
  qs("severity-filters").addEventListener("click", (event) => {
    const chip = (event.target as HTMLElement).closest<HTMLElement>(".cx-filter");
    if (!chip || chip.hasAttribute("disabled")) return;
    const severity = chip.dataset.severity;
    if (!severity) return;

    const on = chip.getAttribute("aria-pressed") !== "true";
    chip.setAttribute("aria-pressed", String(on));
    if (on) activeSeverities.add(severity);
    else activeSeverities.delete(severity);

    emit("findings");
    render();
  });

  listEl.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const dir = target.closest<HTMLElement>(".cx-tree__dir");
    if (dir) {
      const expanded = dir.getAttribute("aria-expanded") === "true";
      dir.setAttribute("aria-expanded", String(!expanded));
      const group = dir.closest<HTMLElement>(".cx-tree__group");
      if (group) group.dataset.collapsed = String(expanded);
      flatRows = visibleRows();
      return;
    }

    const file = target.closest<HTMLElement>(".cx-tree__file");
    if (file?.dataset.path) {
      state.selectedFile = file.dataset.path;
      document.dispatchEvent(
        new CustomEvent("ecotrace:select-file", { detail: file.dataset.path })
      );
      syncSelection();
    }
  });

  listEl.addEventListener("keydown", onKeydown);

  document.addEventListener("ecotrace:reveal-file", (event) => {
    const rel = (event as CustomEvent<string>).detail;
    const match = state.files.find(
      (f) => relPath(f.path, state.projectPath) === rel
    );
    if (match) revealFile(match.path);
  });

  // Enable the pane's controls only once there is something to act on.
  const setEnabled = (enabled: boolean): void => {
    searchInput.disabled = !enabled;
    expandBtn.disabled = !enabled;
    collapseBtn.disabled = !enabled;
    for (const chip of qsa<HTMLElement>("#severity-filters .cx-filter")) {
      if (enabled) chip.removeAttribute("disabled");
      else chip.setAttribute("disabled", "");
    }
  };

  subscribe(["files", "findings", "selection"], () => {
    setEnabled(state.files.length > 0);

    const tally = countBySeverity(state.findings);
    for (const chip of qsa<HTMLElement>("#severity-filters .cx-filter")) {
      const key = chip.dataset.severity as "critical" | "high" | "medium";
      const target = document.getElementById(`count-${key}`);
      if (target) target.textContent = String(tally[key]);
      const total = state.findings
        .filter((f) => f.severity.toLowerCase() === key)
        .length;
      if (total === 0) chip.setAttribute("disabled", "");
      else if (state.files.length > 0) chip.removeAttribute("disabled");
    }

    render();
  });

  render();
}

export { icon };
