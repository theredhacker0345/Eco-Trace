/**
 * Finding inspector.
 *
 * The right-hand pane answers the three questions a reviewer asks in order:
 * what is wrong (Overview), why is it on this path (Causal chain), and what
 * should I write instead (Fix). Tabs keep each answer in its own scroll
 * region, which matters in a 420px column.
 *
 * Position in the queue is always visible, and next/previous step through
 * findings, so a review session is a queue rather than a series of lookups.
 */

import type { ChainNode, Finding } from "../analyzer/static.js";
import { esc, qs, qsa, renderCode } from "./dom.js";
import { locationLabel, relPath } from "./format.js";
import { initTablist } from './focus.js';
import { resetAiFix } from './aifixpanel.js';
import { fixFor, hasTemplate } from "./remediation.js";
import { selectedFinding, state, subscribe } from "./store.js";

/** Resolves Bob-authored fixes, keyed by finding identity (rule|file|line). */
const bobFixes = new Map<string, string>();

/**
 * Resolves Bob-authored chain hops.
 *
 * Keyed by finding identity, not by rule id. A chain is a statement about one
 * path through one file, so keying it on the rule meant that the first
 * occurrence of `W01` in the project lent its chain — root cause, file and
 * line — to every other `W01` in the repository, shown in the inspector as
 * though it had been traced.
 */
const bobChains = new Map<string, string[]>();

/** Local call-graph chains, keyed by finding identity. */
const localChains = new Map<string, ChainNode[]>();

/**
 * The single owner of traced chains.
 *
 * This used to be one of two maps. `main.ts` kept a parallel copy and passed
 * that one to the report exporter, while the inspector rendered from this one —
 * and the demo path only ever populated this one. The result was a report
 * exported from the hosted demo whose Causal Chain section, the product's
 * headline, was silently empty, with nothing in the UI to indicate it. Two maps
 * keyed identically is one map too many.
 */
export function localChainMap(): ReadonlyMap<string, ChainNode[]> {
  return localChains;
}

/** Drops every traced chain. Called when the project changes. */
export function clearLocalChains(): void {
  localChains.clear();
}

/** Rule + absolute path + line: the identity every per-finding map is keyed on. */
function identity(finding: Finding): string {
  return `${finding.patternId}|${finding.file}|${finding.line}`;
}

export function registerBobFix(finding: Finding, fix: string): void {
  bobFixes.set(identity(finding), fix);
}

export function registerBobChain(finding: Finding, chain: string[]): void {
  bobChains.set(identity(finding), chain);
}

export function registerLocalChain(finding: Finding, chain: ChainNode[]): void {
  localChains.set(identity(finding), chain);
}

function currentFix(finding: Finding): { text: string; origin: string } {
  const bob = bobFixes.get(identity(finding));
  if (bob && bob.trim()) {
    return { text: bob, origin: "IBM Bob 2.0 · written against this call chain" };
  }
  return {
    text: fixFor(finding),
    origin: hasTemplate(finding.patternId)
      ? "Authored template · applies to any occurrence of this rule"
      : "No template for this rule · showing the trace hint",
  };
}

const ROLE_LABEL: Record<ChainNode["role"] | string, string> = {
  root: "Root cause",
  intermediate: "Propagated through",
  symptom: "Symptom",
};

function chainMarkup(finding: Finding): string {
  const bob = bobChains.get(identity(finding));
  if (bob && bob.length) {
    return bob
      .map((hop, index) => {
        const role: ChainNode["role"] =
          index === 0 ? "root" : index === bob.length - 1 ? "symptom" : "intermediate";
        return `
          <li class="cx-chain__node" data-role="${role}">
            <span class="cx-chain__rail"><span class="cx-chain__dot">${index + 1}</span></span>
            <div class="cx-chain__body">
              <span class="cx-chain__role">${ROLE_LABEL[role]}</span>
              <span class="cx-chain__method">${esc(hop)}</span>
            </div>
          </li>`;
      })
      .join("");
  }

  const chain = localChains.get(identity(finding)) ?? [];

  return chain
    .map((node, index) => {
      const rel = relPath(node.file, state.projectPath);
      return `
        <li class="cx-chain__node" data-role="${node.role}">
          <span class="cx-chain__rail"><span class="cx-chain__dot">${index + 1}</span></span>
          <div class="cx-chain__body">
            <span class="cx-chain__role">${esc(ROLE_LABEL[node.role] ?? node.role)}</span>
            <span class="cx-chain__method">${esc(node.method)}()</span>
            <button class="cx-chain__loc" data-reveal-file="${esc(node.file)}"
                    title="Reveal ${esc(rel)} in the navigator">${esc(rel)}:${node.line}</button>
            ${node.description ? `<span class="cx-chain__desc">${esc(node.description)}</span>` : ""}
          </div>
        </li>`;
    })
    .join("");
}

let lastRenderedIdentity: string | null = null;

function render(): void {
  const finding = selectedFinding();
  const empty = qs("fix-empty");
  const detail = qs("finding-detail");

  // A proposed patch belongs to the finding it was proposed for. Without this,
  // stepping to the next finding leaves a verified patch and its cost sitting
  // under a completely different rule, and the Apply button would write it.
  if (finding?.patternId !== lastRenderedIdentity) {
    lastRenderedIdentity = finding ? `${finding.patternId}|${finding.file}|${finding.line}` : null;
    resetAiFix();
  }

  if (!finding) {
    empty.hidden = false;
    detail.hidden = true;
    qs("btn-inspector-prev").toggleAttribute("disabled", true);
    qs("btn-inspector-next").toggleAttribute("disabled", true);
    return;
  }

  empty.hidden = true;
  detail.hidden = false;

  const position = state.selectedIndex + 1;
  const total = state.findings.length;

  const badge = qs("detail-severity-badge");
  const severity = finding.severity.toLowerCase();
  badge.className = `cx-tag cx-tag--md cx-tag--${severity}`;
  badge.innerHTML = `<svg class="i i--xs"><use href="#i-warning" /></svg>${esc(finding.severity)}`;

  qs("detail-pattern-name").textContent = finding.patternName;
  qs("detail-pattern-id").textContent = finding.patternId;
  qs("detail-file").textContent = locationLabel(
    finding.file,
    finding.line,
    state.projectPath
  );
  qs("detail-position").textContent = `${position} / ${total}`;

  qs("detail-description").textContent = finding.description;
  renderCode(qs("detail-snippet"), finding.snippet || "// (no source captured)");

  qs("detail-rule-id").textContent = `${finding.patternId} · ${finding.patternName}`;
  qs("detail-category").textContent = finding.category;
  qs("detail-severity").textContent = finding.severity;
  qs("detail-location").textContent = locationLabel(
    finding.file,
    finding.line,
    state.projectPath
  );
  qs("detail-hint").textContent = finding.causalChainHint;

  const chain = chainMarkup(finding);
  const hasChain = chain.trim().length > 0;
  qs("chain-tree").innerHTML = chain;
  qs("chain-empty").hidden = hasChain;
  qs("chain-count").textContent = hasChain
    ? ` ${qsa(".cx-chain__node", qs("chain-tree")).length}`
    : "";

  const fix = currentFix(finding);
  renderCode(qs("fix-code"), fix.text);
  qs("fix-origin-text").textContent = fix.origin;

  const prev = qs<HTMLButtonElement>("btn-inspector-prev");
  const next = qs<HTMLButtonElement>("btn-inspector-next");
  prev.disabled = position <= 1;
  next.disabled = position >= total;
}

/** Selects a finding by queue offset, wrapping at both ends. */
export function step(delta: number): void {
  const total = state.findings.length;
  if (total === 0) return;
  const next = (state.selectedIndex + delta + total) % total;
  state.selectedIndex = next;
  document.dispatchEvent(new CustomEvent("ecotrace:selection-changed"));
  document.dispatchEvent(
    new CustomEvent("ecotrace:focus-finding", { detail: next })
  );
}

export function currentFixText(): string | null {
  const finding = selectedFinding();
  return finding ? currentFix(finding).text : null;
}

export function initInspector(): void {
  const tabs = document.querySelector<HTMLElement>(".cx-inspector__tabs");
  if (tabs) {
    initTablist(tabs, (id) => {
      // The panels are `tabpanel-<id>`, and the tabs point at them through
      // `aria-controls`. Reading the mapping off that attribute rather than
      // reconstructing the id is what keeps the two in step: this callback used
      // to build `panel-${id}` and quietly stopped matching the moment the
      // panels were renamed, which left every tab showing nothing.
      const target = tabs
        .querySelector<HTMLElement>('[data-tab="' + id + '"]')
        ?.getAttribute("aria-controls");
      for (const panel of qsa<HTMLElement>(".cx-inspector__panel")) {
        panel.hidden = target ? panel.id !== target : true;
      }
    });
  }

  qs("btn-inspector-prev").addEventListener("click", () => step(-1));
  qs("btn-inspector-next").addEventListener("click", () => step(1));

  qs("btn-copy-fix").addEventListener("click", async () => {
    const text = currentFixText();
    if (text) await copy(text, "Fix copied to the clipboard");
  });

  qs("btn-copy-fix-full").addEventListener("click", async () => {
    const text = currentFixText();
    if (text) await copy(text, "Fix copied to the clipboard");
  });

  qs("btn-apply-fix-note").addEventListener("click", async () => {
    const finding = selectedFinding();
    const text = currentFixText();
    if (!finding || !text) return;
    const rel = relPath(finding.file, state.projectPath);
    const note = [
      `// ${finding.patternId} · ${finding.patternName} (${finding.severity})`,
      `// ${rel}:${finding.line}`,
      text,
    ].join("\n");
    await copy(note, "Patch note copied");
  });

  // A chain hop is a navigation target, not decoration.
  qs("chain-tree").addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-reveal-file]");
    if (target?.dataset.revealFile) {
      document.dispatchEvent(
        new CustomEvent("ecotrace:reveal-file", { detail: target.dataset.revealFile })
      );
    }
  });

  subscribe(["selection", "findings", "files"], render);
  render();
}

async function copy(text: string, message: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    document.dispatchEvent(new CustomEvent("ecotrace:copied", { detail: message }));
  } catch {
    document.dispatchEvent(
      new CustomEvent("ecotrace:copy-failed", { detail: message })
    );
  }
}
