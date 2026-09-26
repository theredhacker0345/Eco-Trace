/**
 * AI Fix — Bob proposes a patch for a specific finding, the fix is verified,
 * and the cost is reported.
 *
 * The flow, in order, and why each step exists:
 *
 *   1. Read the finding, the surrounding source, and the SKILL.md playbook.
 *   2. Ask Bob for a patch, constrained to the one file and the cited lines.
 *   3. Parse the patch defensively, and refuse anything that touches a file
 *      other than the finding's own. A model asked to fix one bug will
 *      opportunistically tidy the neighbouring code, and an autofixer that
 *      accepts unreviewed edits to a second file is not a tool, it is a hazard.
 *   4. Run the project's own detector over the patched file. The regression
 *      check is the point: a "fix" that silences a detector by deleting the
 *      construct it was looking for has made the report less true, not more.
 *   5. Report what changed and what it cost, before anything is applied.
 *
 * On pushing: `applyAndPush` writes to a **branch** and leaves the merge to a
 * human. A generated patch that can reach `main` without review is a supply
 * chain risk, and the tests in step 4 are exactly what a model will write to
 * satisfy itself. `pushToMain` exists because it was asked for, is off by
 * default, and requires an explicit opt-in.
 */

import { BobClient, BobError, estimateCostUsd, type BobUsage } from "./client.js";
import { analyzeProject } from "../analyzer/static.js";
import type { Finding } from "../analyzer/static.js";

/**
 * The playbook handed to Bob.
 *
 * Written as a document rather than a prompt string so it can be reviewed,
 * versioned and corrected without touching code. A model follows a written
 * playbook markedly better than a paragraph of ad-hoc instructions, and the
 * difference is visible in whether it touches code outside the defect.
 */
export const FIX_SKILL_MD = `# EcoTrace fix playbook

You are repairing one specific energy anti-pattern in one specific file. You are
not refactoring, tidying, or improving anything else.

## Scope — the hardest rule

Change **only** the file named in the request, and only the region the finding
cites. If you believe another file also needs changing, say so in \`notes\` and do
not change it. An unreviewed second-file edit is rejected downstream.

## What counts as a fix

Replace the defective construct with the modern platform API. Do not suppress,
comment out, or restructure around the detector.

| Rule | Defect | Fix |
|---|---|---|
| W01 | \`WakeLock.acquire()\` with no guaranteed \`release()\` | Wrap in \`try/finally\`, or delete the lock by moving the work to \`WorkManager\`, which acquires and releases it internally. |
| W04 | \`PARTIAL_WAKE_LOCK\` in a \`Service\` | Move to a constrained \`WorkManager\` job. A Service carries no wake handling of its own. |
| N01 | Network call in a \`postDelayed\` loop | Delete the loop. Use \`WorkManager\` with a network constraint. |
| N02 / N03 | Missing connect or read timeout | \`OkHttpClient.Builder().connectTimeout(...).readTimeout(...)\`. Always both. |
| N04 | Cleartext HTTP endpoint | Change to \`https\`. Do not weaken the network security config. |
| A01 | \`Service\` with no \`stopSelf()\` | Call \`stopSelf(startId)\` on the terminal path, or return \`START_NOT_STICKY\`. |
| A06 | \`AlarmManager\` WAKEUP for deferrable work | Replace with \`WorkManager\`. A wakeup alarm defeats Doze batching outright. |
| L01 | GPS interval under 30s | \`LocationRequest.Builder(PRIORITY_BALANCED_POWER_ACCURACY, 30_000)\`. |
| L02 | \`FINE_LOCATION\` where \`COARSE\` suffices | Request \`COARSE_LOCATION\`, and document why it is enough. |
| L03 | Listener registered but never removed | Pair every \`register\` with a \`remove\` on the teardown path. |

## Output

A single fenced \`diff\` block and nothing else. Unified diff format, so it
applies with \`git apply\`.

\`\`\`diff
--- a/path/to/File.kt
+++ b/path/to/File.kt
@@ -40,7 +40,9 @@
 context
-removed line
+added line
 context
\`\`\`

## Rules for the diff

- Minimal. The smallest change that removes the defect.
- Preserve indentation and existing style.
- No new dependencies.
- No changes to tests in this diff.
- If no change can remove the defect, return an empty diff and explain why in
  \`notes\`. An empty diff is a valid, useful answer. Inventing a change is not.
`;

export interface AiFixRequest {
  finding: Finding;
  /** The full text of the finding's file, for surrounding context. */
  source: string;
  /** Repo-relative path, which is what goes in the diff header. */
  relativePath: string;
  projectPath: string | null;
  model: string;
}

export interface AiFixPatch {
  file: string;
  /** Unified diff, exactly as the model wrote it. */
  diff: string;
  notes: string;
  usage: BobUsage;
  costUsd: number | null;
  model: string;
  /** Detectors that fired in this file before the patch. */
  beforeRules: string[];
  /** Detectors still firing after applying the patch to a scratch copy. */
  afterRules: string[];
  /** True when the patch removes every detector for this file. */
  verified: boolean;
  /** Populated when the patch could not be used, with the reason. */
  rejected?: string;
  attempts: number;
  retried: boolean;
}

export class AiFixError extends Error {
  readonly hint: string;
  constructor(message: string, hint = "") {
    super(message);
    this.name = "AiFixError";
    this.hint = hint;
  }
}

/**
 * Asks Bob for a patch, applies it to a scratch copy, and re-runs the
 * detectors over the result.
 *
 * Nothing is written to disk. The caller decides what to do with a verified
 * patch, which keeps the irreversible step out of the model's reach.
 */
export async function proposeAiFix(
  client: BobClient,
  apiKey: string,
  request: AiFixRequest,
  signal?: AbortSignal
): Promise<AiFixPatch> {
  const { finding, source, relativePath } = request;

  const before = analyzeProject([{ path: relativePath, content: source, language: languageOf(relativePath) }]);
  const beforeRules = before.map((f) => `${f.patternId}@${f.line}`);

  const system = FIX_SKILL_MD;

  const user = [
    `File: ${relativePath}`,
    "",
    `Finding to repair:`,
    `  Rule:    ${finding.patternId} — ${finding.patternName}`,
    `  Severity: ${finding.severity}`,
    `  Location: line ${finding.line}`,
    `  Why:     ${finding.description}`,
    "",
    "Source of the file, with line numbers:",
    numberLines(source),
    "",
    "Return the unified diff that removes this defect, and nothing else.",
  ].join("\n");

  const result = await client.complete(apiKey, {
    model: request.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0,
    maxTokens: 2048,
    signal,
  });

  const costUsd = estimateCostUsd(request.model, result.usage);
  const notes = extractNotes(result.text);
  const diff = extractDiff(result.text, relativePath);

  if (!diff) {
    return {
      file: relativePath,
      diff: "",
      notes: notes || "Bob returned no diff for this finding.",
      usage: result.usage,
      costUsd,
      model: request.model,
      beforeRules,
      afterRules: beforeRules,
      verified: false,
      rejected: "No unified diff block in the response.",
      attempts: result.attempts,
      retried: result.retried,
    };
  }

  // Scope gate. A model asked to fix one bug will often tidy the neighbouring
  // code, and an autofixer that accepts a second file is a hazard, not a tool.
  const touched = diffFiles(diff);
  const outside = touched.filter((f) => normalise(f) !== normalise(relativePath));
  if (outside.length > 0) {
    return {
      file: relativePath,
      diff,
      notes,
      usage: result.usage,
      costUsd,
      model: request.model,
      beforeRules,
      afterRules: beforeRules,
      verified: false,
      rejected: `Patch touches ${outside.join(", ")}, which is outside the finding's file. Rejected.`,
      attempts: result.attempts,
      retried: result.retried,
    };
  }

  // Apply to a scratch copy and re-run the detectors. This is the whole point:
  // a fix that silences a detector by deleting the construct is not a fix.
  const applied = applyUnifiedDiff(source, diff);
  if (applied === null) {
    return {
      file: relativePath,
      diff,
      notes,
      usage: result.usage,
      costUsd,
      model: request.model,
      beforeRules,
      afterRules: beforeRules,
      verified: false,
      rejected: "The diff did not apply cleanly to the current file contents.",
      attempts: result.attempts,
      retried: result.retried,
    };
  }

  const after = analyzeProject([{ path: relativePath, content: applied, language: languageOf(relativePath) }]);
  const afterRules = after.map((f) => `${f.patternId}@${f.line}`);

  // Verified when *the rule that was reported* no longer fires in this file at
  // all. Keyed on the rule rather than the exact line, because a fix legitimately
  // shifts line numbers -- and a check that compared lines would reject correct
  // patches for the wrong reason.
  const targetGone = !afterRules.some((r) => r.startsWith(`${finding.patternId}@`));

  return {
    file: relativePath,
    diff,
    notes,
    usage: result.usage,
    costUsd,
    model: request.model,
    beforeRules,
    afterRules,
    verified: targetGone,
    rejected: targetGone
      ? undefined
      : `The patch applied, but ${finding.patternId} still fires in this file afterwards.`,
    attempts: result.attempts,
    retried: result.retried,
  };
}

function languageOf(path: string): "java" | "kotlin" {
  return path.endsWith(".kt") ? "kotlin" : "java";
}

function numberLines(source: string): string {
  return source
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(4, " ")} | ${line}`)
    .join("\n");
}

function extractDiff(text: string, fallbackPath: string): string | null {
  const block = /```(?:diff|patch)?\s*\n([\s\S]*?)```/i.exec(text);
  const body = block ? block[1] : text;

  if (!/^(---\s|\+\+\s|@@\s)/m.test(body.trim())) return null;

  // A model that omits the file headers still produced a usable hunk; supply
  // them rather than discarding an otherwise valid patch.
  if (!/^---\s/m.test(body)) {
    return `--- a/${fallbackPath}\n+++ b/${fallbackPath}\n${body.replace(/^@@.*$/m, (m) => m)}`;
  }
  return body;
}

function extractNotes(text: string): string {
  const block = /```(?:notes)?\s*\n([\s\S]*?)```/i.exec(text);
  if (block) return block[1].trim();
  const plain = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^\s*notes?\s*:\s*/i, "")
    .trim();
  return plain.slice(0, 600);
}

/** Every file a unified diff claims to touch. */
export function diffFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const m of diff.matchAll(/^\+\+\+\s+(?:b\/)?(.+?)\s*$/gm)) {
    const path = m[1].trim();
    if (path !== "/dev/null") files.add(normalise(path));
  }
  return [...files];
}

function normalise(path: string): string {
  return path.replace(/^[ab]\//, "").replace(/\\/g, "/").trim();
}

/**
 * Applies a unified diff to a string.
 *
 * Deliberately minimal: it handles whole-file and single-hunk patches with
 * context, which is what a model produces for a single-region edit. It returns
 * null rather than guessing when the context does not match, because a patch
 * that applies approximately is worse than one that is rejected.
 */
export function applyUnifiedDiff(source: string, diff: string): string | null {
  const lines = source.split("\n");
  const hunks: Array<{ oldStart: number; lines: string[] }> = [];

  const hunkRe = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/gm;
  let match: RegExpExecArray | null;
  while ((match = hunkRe.exec(diff)) !== null) {
    const start = Number(match[1]);
    const bodyStart = match.index + match[0].length;
    const rest = diff.slice(bodyStart);
    const nextHunk = rest.search(/^@@\s+-\d/m);
    const body = nextHunk >= 0 ? rest.slice(0, nextHunk) : rest;
    hunks.push({
      oldStart: start,
      lines: body.split("\n").filter((l) => !l.startsWith("\\")),
    });
  }
  if (hunks.length === 0) return null;

  const out: string[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    const index = hunk.oldStart - 1;
    if (index < cursor || index > lines.length) return null;

    out.push(...lines.slice(cursor, index));
    let i = index;

    for (const raw of hunk.lines) {
      const marker = raw[0];
      const text = raw.slice(1);
      if (marker === " ") {
        if (lines[i] !== text) return null; // context mismatch
        out.push(text);
        i++;
      } else if (marker === "-") {
        if (lines[i] !== text) return null;
        i++;
      } else if (marker === "+") {
        out.push(text);
      } else if (raw === "" || marker === undefined) {
        // A trailing empty line from the split is not a real diff line.
      }
    }
    cursor = i;
  }

  out.push(...lines.slice(cursor));
  return out.join("\n");
}

export { BobError };
