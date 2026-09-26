/**
 * Findings table.
 *
 * The primary work surface: a Carbon data table of every detected anti-pattern,
 * with a toolbar, sortable headers, expandable rows and a summary bar that
 * carries the weighted sub-scores behind the composite grade.
 *
 * Two decisions carry most of the weight here:
 *
 *  - The expandable row is the review surface. The description, the offending
 *    source line and the trace hint sit directly beneath the row, so triage
 *    never requires moving the eye to another panel. The inspector is for the
 *    long-form view (chain and fix), not for basic comprehension.
 *  - The table owns its own view state (query, sort, expansion) and derives
 *    from the shared scan result, so filtering never mutates the data and the
 *    navigator and table can never disagree about what a severity means.
 */

import type { Finding } from "../analyzer/static.js";
import { esc, icon, qs, qsa } from "./dom.js";
import { relPath } from "./format.js";
import { activeSeverities } from "./navigator.js";
import { allFixes as allFixText } from "./remediation.js";
import {
  emit,
  sortFindings,
  state,
  subscribe,
  type LogLevel,
  type SortKey,
} from "./store.js";

type Scope = "all" | "flagged" | "selected";

let sortKey: SortKey = "severity";
let sortAsc = true;
let scope: Scope = "all";
let query = "";
const expanded = new Set<string>();

let body: HTMLElement | null = null;
let tableEl: HTMLElement | null = null;

/** Stable identity for a finding: rule + file + line. */
function keyOf(finding: Finding): string {
  return `${finding.patternId}|${finding.file}|${finding.line}`;
}

/**
 * Applies the view filters. Sorting is not applied here: the canonical list in
 * the store is already sorted, so a row's index is its position, and filtering
 * can never renumber what the inspector reports.
 */
function visibleFindings(): Finding[] {
  const q = query.trim().toLowerCase();
  const flagged = new Set(state.findings.map((f) => f.file));

  return state.findings.filter((finding) => {
    if (!activeSeverities.has(finding.severity.toLowerCase())) return false;
    if (scope === "selected" && finding.file !== state.selectedFile) return false;
    if (scope === "flagged" && !flagged.has(finding.file)) return false;
    if (!q) return true;
    return (
      finding.patternName.toLowerCase().includes(q) ||
      finding.patternId.toLowerCase().includes(q) ||
      finding.description.toLowerCase().includes(q) ||
      finding.category.toLowerCase().includes(q) ||
      relPath(finding.file, state.projectPath).toLowerCase().includes(q)
    );
  });
}

/** Re-sorts the canonical list and republishes the sort indicator. */
function applySort(key: SortKey, ascending: boolean): void {
  sortKey = key;
  sortAsc = ascending;
  sortFindings(key, ascending);

  const select = qs<HTMLSelectElement>("input-sort");
  if (select.value !== key) select.value = key;

  for (const th of qsa<HTMLElement>("th[data-sort]")) {
    th.setAttribute(
      "aria-sort",
      th.dataset.sort === key ? (ascending ? "ascending" : "descending") : "none"
    );
  }
  emit("findings");
}

function severityTag(finding: Finding): string {
  const cls = finding.severity.toLowerCase();
  return `<span class="cx-tag cx-tag--sm cx-tag--${cls}">
            <svg class="i i--xs"><use href="#i-warning" /></svg>${esc(finding.severity)}
          </span>`;
}

function rowMarkup(finding: Finding, total: number): string {
  const key = keyOf(finding);
  const isOpen = expanded.has(key);
  const isCurrent = state.findings[state.selectedIndex] === finding;
  const rel = relPath(finding.file, state.projectPath);
  const overallIndex = state.findings.indexOf(finding);

  return `
    <tr class="cx-table__row" data-key="${esc(key)}" data-index="${overallIndex}"
        data-clickable="true" data-current="${isCurrent}" tabindex="-1">
      <td class="cx-table__col-expand">
        <button class="cx-expand" aria-expanded="${isOpen}"
                aria-label="${isOpen ? "Collapse" : "Expand"} ${esc(finding.patternName)}">
          <svg class="i"><use href="#i-chevron-right" /></svg>
        </button>
      </td>
      <td>${severityTag(finding)}</td>
      <td><span class="cx-cell-id">${esc(finding.patternId)}</span></td>
      <td>
        <div class="cx-cell-name">
          <span class="cx-cell-name__title">${esc(finding.patternName)}</span>
          <span class="cx-cell-name__meta">${esc(finding.causalChainHint)}</span>
        </div>
      </td>
      <td><span class="cx-cell-cat" title="${esc(finding.category)}">${esc(finding.category)}</span></td>
      <td>
        <span class="cx-cell-loc" title="${esc(rel)}">
          <span class="cx-cell-loc__file">${esc(rel)}</span>
          <span class="cx-cell-loc__line">:${finding.line}</span>
        </span>
      </td>
    </tr>
    ${
      isOpen
        ? `<tr class="cx-table__detail" data-detail-for="${esc(key)}">
             <td colspan="6">
               <div class="cx-detail">
                 <div class="cx-detail__col">
                   <span class="cx-detail__label">${icon("info", "i--xs")} What this means</span>
                   <p class="cx-detail__text">${esc(finding.description)}</p>
                   <span class="cx-detail__label">${icon("code", "i--xs")} Offending source</span>
                   <pre class="cx-code cx-code--snippet cx-code--gutter" tabindex="0"
                        aria-label="Offending source line">${highlight(finding.snippet)}</pre>
                 </div>
                 <div class="cx-detail__col">
                   <span class="cx-detail__label">${icon("flow", "i--xs")} Trace hint</span>
                   <p class="cx-detail__text">${esc(finding.causalChainHint)}</p>
                   <span class="cx-detail__label">${icon("key", "i--xs")} Attributes</span>
                   <dl class="cx-kv">
                     <dt class="cx-kv__k">Rule</dt><dd class="cx-kv__v">${esc(finding.patternId)}</dd>
                     <dt class="cx-kv__k">Category</dt><dd class="cx-kv__v">${esc(finding.category)}</dd>
                     <dt class="cx-kv__k">Line</dt><dd class="cx-kv__v">${finding.line}</dd>
                     <dt class="cx-kv__k">Position</dt><dd class="cx-kv__v">${overallIndex + 1} of ${total}</dd>
                   </dl>
                   <div class="cx-detail__actions">
                     <button class="cx-btn cx-btn--tertiary cx-btn--sm" data-open-inspector="${overallIndex}">
                       ${icon("bulb", "i--sm")} Open in inspector
                     </button>
                     <button class="cx-btn cx-btn--ghost cx-btn--sm" data-reveal-file="${esc(finding.file)}">
                       ${icon("folder", "i--sm")} Reveal file
                     </button>
                   </div>
                 </div>
               </div>
             </td>
           </tr>`
        : ""
    }`;
}

function highlight(snippet: string): string {
  return snippet
    .replace(/\t/g, "    ")
    .split(/\r?\n/)
    .map(
      (line) =>
        `<span class="cx-code__line">${esc(line) || "&nbsp;"}</span>`
    )
    .join("");
}

function renderEmpty(): void {
  if (!body || !tableEl) return;

  const hasScan = state.findings.length > 0;
  const empty = qs("findings-empty");

  if (state.files.length === 0) {
    tableEl.hidden = true;
    empty.hidden = false;
    empty.innerHTML = `
      <svg class="cx-empty__art"><use href="#i-folder" /></svg>
      <span class="cx-empty__title">No project loaded</span>
      <p class="cx-empty__body">
        Open an Android project to index its sources, then run the detector set.
      </p>`;
    return;
  }

  if (!hasScan) {
    tableEl.hidden = true;
    empty.hidden = false;
    empty.innerHTML = `
      <svg class="cx-empty__art"><use href="#i-activity" /></svg>
      <span class="cx-empty__title">Not analyzed yet</span>
      <p class="cx-empty__body">
        ${state.files.length} source file${state.files.length === 1 ? "" : "s"} indexed.
        Run the analysis to evaluate all 23 energy detectors.
      </p>
      <div class="cx-empty__actions">
        <button class="cx-btn cx-btn--primary cx-btn--sm" data-run-analysis>
          ${icon("play", "i--sm")} Analyze project
        </button>
      </div>`;
    return;
  }

  // A scan produced results but the current filters exclude all of them.
  tableEl.hidden = true;
  empty.hidden = false;
  empty.innerHTML = `
    <svg class="cx-empty__art"><use href="#i-filter" /></svg>
    <span class="cx-empty__title">No findings match the filters</span>
    <p class="cx-empty__body">
      ${state.findings.length} finding${state.findings.length === 1 ? "" : "s"} were detected,
      but none match the active search, severity and scope filters.
    </p>
    <div class="cx-empty__actions">
      <button class="cx-btn cx-btn--tertiary cx-btn--sm" data-reset-filters>Reset filters</button>
    </div>`;
}

function renderSummary(rows: Finding[]): void {
  const summary = qs("findings-summary");
  const hasScan = state.findings.length > 0;
  summary.hidden = !hasScan;

  const copyBtn = qs<HTMLButtonElement>("btn-copy-fixes");
  copyBtn.disabled = rows.length === 0;
  if (!hasScan) return;

  const tally = { critical: 0, high: 0, medium: 0 } as Record<LogLevel, number>;
  const files = new Set<string>();
  for (const finding of rows) {
    const key = finding.severity.toLowerCase() as LogLevel;
    tally[key] = (tally[key] ?? 0) + 1;
    files.add(finding.file);
  }

  qs("summary-total").textContent = String(rows.length);
  qs("summary-critical").textContent = String(tally.critical ?? 0);
  qs("summary-high").textContent = String(tally.high ?? 0);
  qs("summary-medium").textContent = String(tally.medium ?? 0);
  qs("summary-files").textContent = String(files.size);

  const subscores = qs("subscores");
  subscores.hidden = !state.grade;
  if (state.grade) renderSubscores();
}

function bandFor(value: number): "high" | "mid" | "low" {
  if (value >= 70) return "high";
  if (value >= 40) return "mid";
  return "low";
}

function renderSubscores(): void {
  if (!state.grade) return;
  const pairs: Array<[string, number]> = [
    ["drain", state.grade.drainScore],
    ["critical", state.grade.criticalScore],
    ["high", state.grade.highScore],
  ];
  for (const [name, value] of pairs) {
    const score = document.getElementById(`score-${name}`);
    const bar = document.getElementById(`bar-${name}`);
    if (score) score.textContent = String(value);
    if (bar) {
      bar.style.width = `${Math.max(0, Math.min(100, value))}%`;
      bar.dataset.band = bandFor(value);
    }
  }
}

function renderResult(rows: Finding[]): void {
  const result = qs("findings-result");
  const total = state.findings.length;
  if (total === 0) {
    result.textContent = "";
    return;
  }
  if (rows.length === total) {
    result.innerHTML = `<strong>${total}</strong> finding${total === 1 ? "" : "s"}`;
  } else {
    result.innerHTML = `<strong>${rows.length}</strong> of ${total} shown`;
  }
  qs("surface-count").textContent = total ? ` ${total}` : "";
}

function render(): void {
  if (!body || !tableEl) return;
  const rows = visibleFindings();

  if (rows.length === 0) {
    body.innerHTML = "";
    renderEmpty();
    renderSummary(rows);
    renderResult(rows);
    return;
  }

  tableEl.hidden = false;
  qs("findings-empty").hidden = true;
  body.innerHTML = rows.map((f) => rowMarkup(f, state.findings.length)).join("");
  renderSummary(rows);
  renderResult(rows);

  const expandBtn = qs<HTMLButtonElement>("btn-expand-all");
  const allOpen = rows.every((f) => expanded.has(keyOf(f)));
  expandBtn.textContent = allOpen ? "Collapse all" : "Expand all";
  expandBtn.disabled = false;
}

function focusRow(row: HTMLElement | null): void {
  if (!row) return;
  for (const other of visibleRows()) other.tabIndex = -1;
  row.tabIndex = 0;
  row.focus();
}

function visibleRows(): HTMLElement[] {
  if (!body) return [];
  return qsa<HTMLElement>(".cx-table__row", body);
}

function selectByIndex(index: number, reveal = true): void {
  if (index < 0 || index >= state.findings.length) return;
  state.selectedIndex = index;
  const finding = state.findings[index];
  if (reveal && finding) {
    document.dispatchEvent(
      new CustomEvent("ecotrace:reveal-file", { detail: finding.file })
    );
  }
  document.dispatchEvent(new CustomEvent("ecotrace:selection-changed"));
}

function toggleRow(row: HTMLElement, force?: boolean): void {
  const key = row.dataset.key;
  if (!key) return;
  const isOpen = expanded.has(key);
  const next = force ?? !isOpen;
  if (next) expanded.add(key);
  else expanded.delete(key);
  render();
  const again = body?.querySelector<HTMLElement>(
    `.cx-table__row[data-key="${CSS.escape(key)}"]`
  );
  focusRow(again ?? null);
}

function onKeydown(event: KeyboardEvent): void {
  const row = (event.target as HTMLElement).closest<HTMLElement>(".cx-table__row");
  if (!row) return;
  const rows = visibleRows();
  const index = rows.indexOf(row);

  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      focusRow(rows[Math.min(index + 1, rows.length - 1)]);
      break;
    case "ArrowUp":
      event.preventDefault();
      focusRow(rows[Math.max(index - 1, 0)]);
      break;
    case "ArrowRight":
      event.preventDefault();
      toggleRow(row, true);
      break;
    case "ArrowLeft":
      event.preventDefault();
      if (row.getAttribute("aria-expanded") === "true") toggleRow(row, false);
      else focusRow(rows[Math.max(index - 1, 0)]);
      break;
    case "Home":
      event.preventDefault();
      focusRow(rows[0]);
      break;
    case "End":
      event.preventDefault();
      focusRow(rows[rows.length - 1]);
      break;
    case "Enter":
      event.preventDefault();
      selectByIndex(Number(row.dataset.index));
      break;
    case " ":
      event.preventDefault();
      toggleRow(row);
      break;
    default:
      break;
  }
}

/** Toggling the active column reverses it; a new column starts ascending. */
function toggleSort(key: SortKey): void {
  const ascending = sortKey === key ? !sortAsc : key !== "file";
  applySort(key, ascending);
}

export function resetFilters(): void {
  query = "";
  scope = "all";
  for (const severity of activeSeverities) activeSeverities.add(severity);
  for (const chip of qsa<HTMLElement>("#severity-filters .cx-filter")) {
    chip.setAttribute("aria-pressed", "true");
  }
  const search = qs<HTMLInputElement>("input-findings-search");
  search.value = "";
  qs("btn-findings-search-clear").hidden = true;
  qs<HTMLSelectElement>("input-scope").value = "all";
  emit("findings");
}

/**
 * Concatenates the fix for every currently visible finding, with a header per
 * finding so the pasted block is still reviewable in a pull request.
 */
export function allFixes(
  findings: readonly Finding[],
  resolve: (finding: Finding) => string | undefined
): string {
  return allFixText(findings, resolve);
}

export function initFindingsTable(): void {
  body = qs("findings-body");
  tableEl = qs("findings-table");

  const searchInput = qs<HTMLInputElement>("input-findings-search");
  const searchClear = qs("btn-findings-search-clear");

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

  qs<HTMLSelectElement>("input-sort").addEventListener("change", (event) => {
    const key = (event.target as HTMLSelectElement).value as SortKey;
    applySort(key, key !== "file");
  });

  qs<HTMLSelectElement>("input-scope").addEventListener("change", (event) => {
    scope = (event.target as HTMLSelectElement).value as Scope;
    render();
  });

  qs("findings-table").addEventListener("click", (event) => {
    const target = event.target as HTMLElement;

    const header = target.closest<HTMLElement>("th[data-sort]");
    if (header?.dataset.sort) {
      toggleSort(header.dataset.sort as SortKey);
      return;
    }

    const expandBtn = target.closest<HTMLElement>(".cx-expand");
    const row = target.closest<HTMLElement>(".cx-table__row");
    if (!row) return;

    if (expandBtn) {
      toggleRow(row);
      return;
    }

    if (target.closest("[data-open-inspector]")) {
      selectByIndex(Number(row.dataset.index), false);
      return;
    }

    selectByIndex(Number(row.dataset.index));
  });

  tableEl.addEventListener("keydown", onKeydown);

  qs("btn-expand-all").addEventListener("click", () => {
    const rows = visibleFindings();
    const allOpen = rows.every((f) => expanded.has(keyOf(f)));
    expanded.clear();
    if (!allOpen) for (const finding of rows) expanded.add(keyOf(finding));
    render();
  });

  // Empty-state actions live in markup, so they are delegated.
  qs("findings-empty").addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-run-analysis]")) {
      document.dispatchEvent(new CustomEvent("ecotrace:analyze"));
    } else if (target.closest("[data-reset-filters]")) {
      resetFilters();
    }
  });

  subscribe(["findings", "files", "grade", "selection"], render);

  // Deep-link from the log or the inspector to a specific source line.
  document.addEventListener("ecotrace:focus-finding", (event) => {
    const index = (event as CustomEvent<number>).detail;
    const finding = state.findings[index];
    if (!finding) return;
    expanded.add(keyOf(finding));
    render();
    const row = body?.querySelector<HTMLElement>(
      `.cx-table__row[data-key="${CSS.escape(keyOf(finding))}"]`
    );
    row?.scrollIntoView({ block: "nearest" });
    focusRow(row ?? null);
  });

  render();
}
