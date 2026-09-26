/**
 * AI Fix — inspector wiring.
 *
 * The flow is deliberately staged, and the stages are visible in the UI:
 *
 *   idle → proposing → reviewed → applying → applied | failed
 *
 * A patch is never applied straight from a model response. It is proposed,
 * shown with its cost and its verification result, and only then offered as a
 * button. The irreversible step is always a separate, deliberate click.
 */

import { invoke } from "@tauri-apps/api/core";
import { BobClient, BobError, formatCost } from "../bob/client.js";
import { proposeAiFix, type AiFixPatch } from "../bob/aifix.js";
import { log } from "../ui/runLog.js";
import { notify } from "../ui/toasts.js";
import { qs, qsButton } from "./dom.js";
import { relPath } from "../ui/format.js";
import { selectedFinding, state } from "../ui/store.js";
import type { Finding } from "../analyzer/static.js";

export interface ApplyOutcome {
  summary: string;
  branch: string;
  files: string[];
  verify_output: string;
  pushed: boolean;
  warning: string | null;
}

type Stage = "idle" | "proposing" | "reviewed" | "applying" | "applied" | "failed";

let stage: Stage = "idle";
let current: AiFixPatch | null = null;
let inFlight: AbortController | null = null;

/**
 * Whether a committed patch is also pushed to `origin`.
 *
 * Off by default, and note the asymmetry with the Rust side: that command
 * refuses a `main` *branch* outright, so this flag is not "push to main". It
 * controls whether the generated branch is pushed at all. The reasoning is the
 * same in both places -- generated code that lands unattended is a supply-chain
 * risk, and the verification guarding it is exactly the kind of check a model
 * will write to satisfy itself -- so the app does not push on its own, and a
 * person opens the pull request.
 */
const PUSH_BRANCH_BY_DEFAULT = false;

const BRANCH_PREFIX = "ecotrace/ai-fix";

export function initAiFix(): void {
  qsButton("btn-aifix-run").addEventListener("click", () => void runPropose());
  qsButton("btn-aifix-apply").addEventListener("click", () => void runApply());
  qsButton("btn-aifix-copy").addEventListener("click", async () => {
    if (!current?.diff) return;
    await navigator.clipboard.writeText(current.diff);
    notify("success", "Patch copied", "Paste it into a review.");
  });
  render();
}

/** Called when the selection changes, so a stale patch never shows for a new finding. */
export function resetAiFix(): void {
  inFlight?.abort();
  inFlight = null;
  current = null;
  stage = "idle";
  render();
}

export function aiFixBusy(): boolean {
  return stage === "proposing" || stage === "applying";
}

function branchName(finding: Finding): string {
  const rule = finding.patternId.toLowerCase();
  const slug = relPath(finding.file, state.projectPath)
    .replace(/\.[a-z]+$/i, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 48);
  return `${BRANCH_PREFIX}/${rule}-${slug || "finding"}`;
}

async function runPropose(): Promise<void> {
  if (aiFixBusy()) return;

  const finding = selectedFinding();
  if (!finding) {
    notify("info", "No finding selected", "Pick a row first.");
    return;
  }

  const key = state.settings.apiKey;
  if (!key.trim()) {
    notify(
      "info",
      "No IBM Bob key",
      "AI Fix needs a key. The Fix tab still has authored remediations without one."
    );
    return;
  }

  const source = state.files.find((f) => f.path === finding.file)?.content;
  if (!source) {
    notify("error", "Source unavailable", "Re-open the project so the file is loaded.");
    return;
  }

  stage = "proposing";
  render();

  inFlight?.abort();
  inFlight = new AbortController();
  const started = Date.now();

  try {
    const patch = await proposeAiFix(
      new BobClient(),
      key,
      {
        finding,
        source,
        relativePath: relPath(finding.file, state.projectPath),
        projectPath: state.projectPath,
        model: state.settings.bobModel,
      },
      inFlight.signal
    );

    current = patch;
    stage = "reviewed";

    const cost = formatCost(patch.costUsd);
    log(
      patch.verified ? "success" : "high",
      `AI fix proposed for ${patch.file} — ${patch.verified ? "verified by the detectors" : "not verified"} · ` +
        `${patch.usage.totalTokens.toLocaleString()} tokens · ${cost} · ${Date.now() - started} ms`
    );
    if (patch.retried) {
      log("system", "The request needed a retry. A transient failure was recovered.");
    }
    if (patch.rejected) {
      log("system", `Patch rejected: ${patch.rejected}`);
    }
  } catch (err) {
    current = null;
    stage = "failed";
    const message = err instanceof Error ? err.message : String(err);
    const hint = err instanceof BobError ? err.hint : "";
    log("critical", `AI fix failed: ${message}${hint ? ` — ${hint}` : ""}`);
    notify("error", "AI fix failed", hint || message);
  } finally {
    inFlight = null;
    render();
  }
}

async function runApply(): Promise<void> {
  if (!current?.diff || stage === "applying") return;
  if (!current.verified) return; // never offer an unverified patch
  if (!state.projectPath) {
    notify("error", "No project open", "Open a git repository to apply a patch.");
    return;
  }

  stage = "applying";
  render();

  const finding = selectedFinding();
  const branch = branchName(
    finding ?? { patternId: "w00", file: "unknown" } as unknown as Finding
  );

  try {
    const outcome = await invoke<ApplyOutcome>("apply_patch", {
      root: state.projectPath,
      patch: current.diff,
      branch,
      message: [
        `EcoTrace AI fix: ${current.file}`,
        "",
        finding ? `Rule:    ${finding.patternId} — ${finding.patternName}` : "",
        finding ? `Finding: ${current.file}:${finding.line}` : "",
        "",
        `Verified: the ${finding?.patternId ?? "reported"} detector no longer fires in this file.`,
        `Bob ${current.model}: ${current.usage.totalTokens.toLocaleString()} tokens, ${formatCost(current.costUsd)}.`,
        "",
        "Generated by EcoTrace and committed to a branch for human review.",
      ]
        .filter(Boolean)
        .join("\n"),
      // The verifier is the project's own type check. It is the one command that
      // is cheap, always available, and catches a patch that does not compile.
      verifyCommand: "npx tsc --noEmit",
      push: PUSH_BRANCH_BY_DEFAULT,
    });

    stage = "applied";
    log("success", outcome.summary);
    notify(
      "success",
      `Committed to ${outcome.branch}`,
      outcome.warning ?? `${outcome.files.length} file(s) changed. Open a pull request to merge it.`
    );
    qs("aifix-apply-note").textContent = outcome.warning
      ? outcome.warning
      : `Committed to ${outcome.branch}. Nothing was pushed to main — review it, then open a pull request.`;
  } catch (err) {
    stage = "reviewed";
    const message = String(err);
    log("critical", `Could not apply the patch: ${message}`);
    notify("error", "Could not apply the patch", message);
    qs("aifix-apply-note").textContent = message;
  } finally {
    render();
  }
}

function render(): void {
  const finding = selectedFinding();
  const target = qs("aifix-target");
  if (target && finding) {
    target.textContent = `${finding.patternId} at ${relPath(finding.file, state.projectPath)}:${finding.line}`;
  }

  const runBtn = qsButton("btn-aifix-run");
  const hasKey = Boolean(state.settings.apiKey?.trim());
  runBtn.disabled = aiFixBusy() || !finding || !hasKey;
  runBtn.textContent = stage === "proposing" ? "Asking Bob…" : "Propose an AI fix";
  if (stage === "proposing") {
    runBtn.insertAdjacentHTML("afterbegin", '<svg class="i"><use href="#i-bulb" /></svg>');
  }

  const hint = qs("aifix-hint");
  if (!hasKey) {
    hint.textContent = "Needs an IBM Bob 2.0 key. The Fix tab has authored remediations without one.";
  } else if (!finding) {
    hint.textContent = "Select a finding first.";
  } else {
    hint.textContent = `Uses ${state.settings.bobModel}. The cost is shown before anything is written.`;
  }

  const result = qs("aifix-result");
  if (stage === "idle" || stage === "proposing" || !current) {
    result.hidden = true;
    return;
  }
  result.hidden = false;

  const patch = current;
  const verdict = qs("aifix-verdict");
  verdict.dataset.tone = patch.verified ? "ok" : "bad";
  verdict.innerHTML = patch.verified
    ? "<span>Verified. The detector no longer fires in this file after the patch.</span>"
    : `<span>${esc(patch.rejected ?? "Not verified — treat this as a starting point, not a fix.")}</span>`;

  const facts = qs("aifix-facts");
  facts.innerHTML = [
    ["File", patch.file],
    ["Model", patch.model],
    ["Tokens", patch.usage.totalTokens.toLocaleString()],
    ["Cost", `<span class="cx-aifix__cost">${formatCost(patch.costUsd)}</span>`],
    ["Attempts", patch.usage.calls + (patch.usage.calls > 1 ? " (retried)" : "")],
    ["Elapsed", `${(patch.usage.wallClockMs / 1000).toFixed(1)} s`],
    ["Detectors", `${patch.beforeRules.length} before → ${patch.afterRules.length} after`],
  ]
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join("");

  const notesSection = qs("aifix-notes-section");
  if (patch.notes) {
    notesSection.hidden = false;
    qs("aifix-notes").textContent = patch.notes;
  } else {
    notesSection.hidden = true;
  }

  const diffSection = qs("aifix-diff-section");
  if (patch.diff) {
    diffSection.hidden = false;
    qs("aifix-diff").textContent = patch.diff;
  } else {
    diffSection.hidden = true;
  }

  // The actions appear only for a patch that is both present and verified. A
  // rejected or unverified patch is read-only, and saying so is better than a
  // disabled button that invites a second click.
  const actions = qs("aifix-actions");
  const canApply =
    Boolean(patch.diff) && patch.verified && stage !== "applying" && stage !== "applied";
  actions.hidden = !canApply;
  if (canApply) {
    qsButton("btn-aifix-apply").textContent = `Apply to ${branchNameLabel(patch.file)}`;
  }
}

function branchNameLabel(file: string): string {
  const slug = file
    .replace(/\.[a-z]+$/i, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .toLowerCase()
    .slice(0, 24);
  return `a branch (${BRANCH_PREFIX}/…${slug ? `/${slug}` : ""})`;
}

function esc(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
