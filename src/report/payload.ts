/**
 * Report payload assembly.
 *
 * The exported document is the artefact a developer attaches to a ticket, pastes
 * into a review, or leaves in an archive. That changes what belongs in it: not
 * "whatever the table happened to be showing", but the whole finding set, every
 * traced chain, the measured drain with its provenance, and the rule-by-rule
 * coverage that shows what was looked for and found nothing.
 *
 * This module owns that shape. The report template is a renderer over whatever
 * comes out of here, so the two can be reasoned about separately and a field
 * can be added without touching the renderer.
 */

import { CATALOG, type DetectorEntry } from "../ui/catalog.js";
import { fixFor } from "../ui/remediation.js";
import { relPath } from "../ui/format.js";
import type { ChainNode, Finding } from "../analyzer/static.js";
import type { GradeResult, ScanRecord } from "../grader/grade.js";
import type { DumpsysDelta } from "../parser/dumpsys.js";
import type { AppState } from "../ui/store.js";

/** Bumped when the field set changes, so an old template can detect a new file. */
export const REPORT_SCHEMA = 2;

export interface ReportChainNode {
  file: string;
  method: string;
  line: number;
  role: ChainNode["role"];
  description: string;
}

export interface ReportFinding {
  patternId: string;
  patternName: string;
  severity: Finding["severity"];
  category: Finding["category"];
  file: string;
  line: number;
  snippet: string;
  description: string;
  causalChainHint: string;
  /** Present when IBM Bob 2.0 wrote a fix for this exact finding. */
  fix?: string;
  fixOrigin: "bob" | "template";
  /** Traced for this finding specifically, not borrowed from the same rule. */
  chain: ReportChainNode[];
}

export interface ReportCategory {
  name: string;
  count: number;
  critical: number;
  high: number;
  medium: number;
}

export interface ReportCoverageRow extends DetectorEntry {
  count: number;
}

export interface ReportPayload {
  schema: number;
  generator: {
    name: string;
    version: string;
    /** Which analysis path produced the numbers, for provenance. */
    engine: "static" | "static+bob";
  };
  project: {
    path: string;
    name: string;
    packageNames: string[];
    filesIndexed: number;
    filesFlagged: number;
    java: number;
    kotlin: number;
  };
  generatedAt: number;
  grade: GradeResult;
  measurement: {
    drainRateMahPerMin: number;
    source: DumpsysDelta["source"];
    resolutionMah: number;
    topDrainers: Array<{ packageName: string; cpuTimeMs: number; wakelockDurationMs: number }>;
    newWakelocks: Array<{ name: string; acquireCount: number; holdDurationMs: number }>;
    dozeViolations: Array<{ packageName: string; type: string; details: string }>;
    cpuWakeups: Array<{ packageName: string; wakeupCount: number; periodHours: number }>;
  } | null;
  summary: {
    byCategory: ReportCategory[];
    bySeverity: { critical: number; high: number; medium: number };
    coverage: ReportCoverageRow[];
    detectorsRun: number;
  };
  findings: ReportFinding[];
  /** The longest chain in the scan — the headline exhibit. */
  featuredChain: { finding: ReportFinding; nodes: ReportChainNode[] } | null;
  /** True when findings were capped for size, so the document can say so. */
  truncated: boolean;
  history: Array<{
    timestamp: number;
    letter: string;
    numericScore: number;
    totalFindings: number;
    drainRateMahPerMin: number;
  }>;
  fixes: string;
}

export interface BuildReportInput {
  state: AppState;
  grade: GradeResult;
  history: ScanRecord[];
  /** Chains keyed by `rule|file|line`, as published by the analysis worker. */
  chains: ReadonlyMap<string, ChainNode[]>;
  /** Bob-authored fixes, keyed by the same identity. */
  bobFixes: Map<string, string>;
  measurement: DumpsysDelta | null;
  version: string;
  /** Upper bound on findings carried into the document. */
  limit?: number;
}

function identity(finding: Finding): string {
  return `${finding.patternId}|${finding.file}|${finding.line}`;
}

function projectName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() ?? path;
}

export function buildReportPayload(input: BuildReportInput): ReportPayload {
  const { state, grade, history, chains, bobFixes, measurement, version } = input;
  const limit = input.limit ?? 400;
  const root = state.projectPath;

  const ordered = [...state.findings].sort((a, b) => {
    const rank = { Critical: 0, High: 1, Medium: 2 } as const;
    const d = rank[a.severity] - rank[b.severity];
    if (d !== 0) return d;
    const byFile = relPath(a.file, root).localeCompare(relPath(b.file, root));
    if (byFile !== 0) return byFile;
    return a.line - b.line;
  });

  const carried = ordered.slice(0, limit);
  const truncated = ordered.length > carried.length;

  const findings: ReportFinding[] = carried.map((finding) => {
    const key = identity(finding);
    const bobFix = bobFixes.get(key);
    const chain = (chains.get(key) ?? []).map((node) => ({
      ...node,
      file: relPath(node.file, root),
    }));
    return {
      patternId: finding.patternId,
      patternName: finding.patternName,
      severity: finding.severity,
      category: finding.category,
      file: relPath(finding.file, root),
      line: finding.line,
      snippet: finding.snippet,
      description: finding.description,
      causalChainHint: finding.causalChainHint,
      fix: bobFix && bobFix.trim() ? bobFix : fixFor(finding),
      fixOrigin: bobFix && bobFix.trim() ? "bob" : "template",
      chain,
    };
  });

  // Category rollup, worst-severity first within each category.
  const categoryOrder = [
    "Wakefulness",
    "Network",
    "Location/Sensors",
    "Lifecycle/Architecture",
  ];
  const byCategoryMap = new Map<string, ReportCategory>();
  for (const finding of ordered) {
    const entry =
      byCategoryMap.get(finding.category) ??
      { name: finding.category, count: 0, critical: 0, high: 0, medium: 0 };
    entry.count++;
    if (finding.severity === "Critical") entry.critical++;
    else if (finding.severity === "High") entry.high++;
    else entry.medium++;
    byCategoryMap.set(finding.category, entry);
  }
  const byCategory = [...byCategoryMap.values()].sort((a, b) => {
    const ia = categoryOrder.indexOf(a.name);
    const ib = categoryOrder.indexOf(b.name);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  // Rule-by-rule coverage. A detector that found nothing is reported as a zero,
  // not omitted: "checked and clean" is a result, and hiding it makes the
  // document indistinguishable from one that never ran the rule.
  const counts = new Map<string, number>();
  for (const finding of ordered) {
    counts.set(finding.patternId, (counts.get(finding.patternId) ?? 0) + 1);
  }
  const coverage: ReportCoverageRow[] = CATALOG.flatMap((group) =>
    group.detectors.map((detector) => ({
      ...detector,
      count: counts.get(detector.id) ?? 0,
    }))
  );

  // The headline exhibit is the longest traced chain, because a long chain is
  // the thing no single-file tool could have produced.
  let featured: ReportPayload["featuredChain"] = null;
  for (const finding of findings) {
    if (!featured || finding.chain.length > featured.nodes.length) {
      featured = { finding, nodes: finding.chain };
    }
  }
  if (featured && featured.nodes.length < 2) featured = null;

  const java = state.files.filter((f) => f.language === "java").length;

  return {
    schema: REPORT_SCHEMA,
    generator: {
      name: "EcoTrace",
      version,
      engine: bobFixes.size > 0 ? "static+bob" : "static",
    },
    project: {
      path: state.projectPath ?? "Unknown",
      name: projectName(state.projectPath ?? "Unknown"),
      packageNames: state.manifestPackageNames,
      filesIndexed: state.files.length,
      filesFlagged: new Set(ordered.map((f) => f.file)).size,
      java,
      kotlin: state.files.length - java,
    },
    generatedAt: Date.now(),
    grade,
    measurement: measurement
      ? {
          drainRateMahPerMin: measurement.drainRateMahPerMin,
          source: measurement.source,
          resolutionMah: measurement.resolutionMah,
          topDrainers: measurement.topDrainers.slice(0, 5).map((d) => ({
            packageName: d.packageName,
            cpuTimeMs: Math.round(d.cpuTimeMs),
            wakelockDurationMs: Math.round(d.wakelockDurationMs),
          })),
          newWakelocks: measurement.newWakelocks.slice(0, 8).map((w) => ({
            name: w.name,
            acquireCount: w.acquireCount,
            holdDurationMs: Math.round(w.holdDurationMs),
          })),
          dozeViolations: measurement.dozeViolations.slice(0, 8).map((d) => ({
            packageName: d.packageName,
            type: d.type,
            details: d.details,
          })),
          cpuWakeups: measurement.cpuWakeups.slice(0, 8).map((c) => ({
            packageName: c.packageName,
            wakeupCount: c.wakeupCount,
            periodHours: c.periodHours,
          })),
        }
      : null,
    summary: {
      byCategory,
      bySeverity: {
        critical: grade.criticalCount,
        high: grade.highCount,
        medium: grade.mediumCount,
      },
      coverage,
      detectorsRun: coverage.length,
    },
    findings,
    featuredChain: featured,
    truncated,
    history: history.slice(0, 24).map((record) => ({
      timestamp: record.timestamp,
      letter: record.grade.letter,
      numericScore: record.grade.numericScore,
      totalFindings: record.totalFindings,
      drainRateMahPerMin: record.drainRateMahPerMin,
    })),
    fixes: findings
      .map(
        (f) =>
          `// ${f.patternId} · ${f.patternName} (${f.severity})\n// ${f.file}:${f.line}\n${f.fix ?? ""}`
      )
      .join("\n\n"),
  };
}
