// EcoTrace — Scoring engine + timeline storage (Sub-Task 5)
// Calculates letter grades from static-analysis findings and battery drain data,
// and persists per-scan history to %APPDATA%\ecotrace\history.json.

import { readTextFile, writeTextFile, mkdir, exists } from "@tauri-apps/plugin-fs";
import { appDataDir, join } from "@tauri-apps/api/path";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Minimal Finding shape needed by the grader — matches what static.ts will export. */
export interface FindingRef {
  severity: "Critical" | "High" | "Medium";
}

export interface GradeResult {
  letter: "A+" | "A" | "B" | "C" | "D" | "F";
  numericScore: number;       // 0-100
  drainScore: number;         // 0-100 sub-score
  criticalScore: number;      // 0-100 sub-score
  highScore: number;          // 0-100 sub-score
  drainRateMahPerMin: number; // actual drain rate passed in (or 0)
  criticalCount: number;
  highCount: number;
  mediumCount: number;
}

export interface ScanRecord {
  id: string;              // crypto.randomUUID() or timestamp string
  timestamp: number;       // Date.now()
  projectPath: string;
  grade: GradeResult;
  totalFindings: number;
  criticalFindings: number;
  highFindings: number;
  mediumFindings: number;
  drainRateMahPerMin: number;
}

export interface ProgressPoint {
  timestamp: number;
  date: string;        // ISO date string
  numericScore: number;
  letter: string;
  delta: number;       // score change from previous scan (0 for first)
}

// ---------------------------------------------------------------------------
// Sub-score helpers
// ---------------------------------------------------------------------------

/** Linear interpolation between two breakpoints. */
function lerp(x: number, x0: number, x1: number, y0: number, y1: number): number {
  return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

/**
 * Maps a drain rate (mAh/min) to a 0-100 score.
 *
 * Breakpoints:
 *   0.0  → 100
 *   0.5  → 90
 *   0.8  → 75
 *   1.2  → 60
 *   2.0  → 40
 *   3.0  → 0
 *   >3.0 → 0
 */
export function scoreDrainRate(drainRateMahPerMin: number): number {
  if (drainRateMahPerMin <= 0) return 100;
  if (drainRateMahPerMin >= 3.0) return 0;

  const breakpoints: [number, number][] = [
    [0.0, 100],
    [0.5, 90],
    [0.8, 75],
    [1.2, 60],
    [2.0, 40],
    [3.0, 0],
  ];

  for (let i = 0; i < breakpoints.length - 1; i++) {
    const [x0, y0] = breakpoints[i];
    const [x1, y1] = breakpoints[i + 1];
    if (drainRateMahPerMin <= x1) {
      return Math.round(lerp(drainRateMahPerMin, x0, x1, y0, y1));
    }
  }

  return 0;
}

/**
 * Maps a critical-finding count to a 0-100 score.
 *
 * 0→100  1→70  2→50  3→30  4→15  ≥5→0
 */
export function scoreCriticalCount(count: number): number {
  const table: Record<number, number> = { 0: 100, 1: 70, 2: 50, 3: 30, 4: 15 };
  if (count >= 5) return 0;
  return table[count] ?? 0;
}

/**
 * Maps a high-finding count to a 0-100 score.
 *
 * 0→100  1-2→80  3-4→60  5-7→40  ≥8→20
 */
export function scoreHighCount(count: number): number {
  if (count === 0) return 100;
  if (count <= 2) return 80;
  if (count <= 4) return 60;
  if (count <= 7) return 40;
  return 20;
}

// ---------------------------------------------------------------------------
// Grade calculation
// ---------------------------------------------------------------------------

function toLetterGrade(score: number): GradeResult["letter"] {
  if (score >= 95) return "A+";
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 50) return "C";
  if (score >= 30) return "D";
  return "F";
}

/**
 * Calculates a GradeResult from a list of findings and the observed drain rate.
 */
export function calculateGrade(
  findings: FindingRef[],
  drainRateMahPerMin: number
): GradeResult {
  const criticalCount = findings.filter((f) => f.severity === "Critical").length;
  const highCount = findings.filter((f) => f.severity === "High").length;
  const mediumCount = findings.filter((f) => f.severity === "Medium").length;

  const drainScore = scoreDrainRate(drainRateMahPerMin);
  const criticalScore = scoreCriticalCount(criticalCount);
  const highScore = scoreHighCount(highCount);

  // Hard-fail thresholds
  if (drainRateMahPerMin >= 3.0 || criticalCount >= 5) {
    return {
      letter: "F",
      numericScore: 0,
      drainScore,
      criticalScore,
      highScore,
      drainRateMahPerMin,
      criticalCount,
      highCount,
      mediumCount,
    };
  }

  const numericScore = Math.round(
    drainScore * 0.4 + criticalScore * 0.35 + highScore * 0.25
  );

  return {
    letter: toLetterGrade(numericScore),
    numericScore,
    drainScore,
    criticalScore,
    highScore,
    drainRateMahPerMin,
    criticalCount,
    highCount,
    mediumCount,
  };
}

// ---------------------------------------------------------------------------
// History persistence helpers
// ---------------------------------------------------------------------------

async function historyFilePath(): Promise<string> {
  const base = await appDataDir();
  return join(base, "ecotrace", "history.json");
}

async function historyDirPath(): Promise<string> {
  const base = await appDataDir();
  return join(base, "ecotrace");
}

// ---------------------------------------------------------------------------
// Public async API
// ---------------------------------------------------------------------------

/**
 * Persists a new ScanRecord, prepending it to the history file (newest-first).
 * Creates the directory if it does not exist.
 */
export async function saveScan(record: ScanRecord): Promise<void> {
  try {
    const existing = await loadHistory();
    const updated = [record, ...existing];

    const dir = await historyDirPath();
    const dirExists = await exists(dir);
    if (!dirExists) {
      await mkdir(dir, { recursive: true });
    }

    const filePath = await historyFilePath();
    await writeTextFile(filePath, JSON.stringify(updated, null, 2));
  } catch {
    // Silently swallow write errors to avoid crashing the scan pipeline
  }
}

/**
 * Loads the full scan history, sorted newest-first.
 * Returns [] if the file is missing or cannot be parsed.
 */
export async function loadHistory(): Promise<ScanRecord[]> {
  try {
    const filePath = await historyFilePath();
    const fileExists = await exists(filePath);
    if (!fileExists) return [];
    const raw = await readTextFile(filePath);
    const parsed = JSON.parse(raw) as ScanRecord[];
    return parsed.sort((a, b) => b.timestamp - a.timestamp);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Progress timeline
// ---------------------------------------------------------------------------

/**
 * Converts a history array into an array of ProgressPoints suitable for
 * timeline rendering, sorted oldest-first.
 *
 * Each point carries the delta (score change) relative to the previous scan.
 */
export function computeScoreProgress(history: ScanRecord[]): ProgressPoint[] {
  // Work oldest-first internally so deltas are forward-looking
  const sorted = [...history].sort((a, b) => a.timestamp - b.timestamp);

  return sorted.map((record, index) => {
    const prevScore = index === 0 ? record.grade.numericScore : sorted[index - 1].grade.numericScore;
    const delta = index === 0 ? 0 : record.grade.numericScore - prevScore;

    return {
      timestamp: record.timestamp,
      date: new Date(record.timestamp).toISOString(),
      numericScore: record.grade.numericScore,
      letter: record.grade.letter,
      delta,
    };
  });
}
