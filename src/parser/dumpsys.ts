// Eco-Trace/src/parser/dumpsys.ts
// Parses raw `adb shell dumpsys batterystats` output into structured types.

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface PerUidEntry {
  uid: string;
  packageName: string;
  cpuTimeMs: number;
  wakelockDurationMs: number;
  wifiTimeMs: number;
  mobileTimeMs: number;
}

export interface WakelockEntry {
  name: string;
  packageName: string;
  holdDurationMs: number;
  acquireCount: number;
}

export interface NetworkEntry {
  uid: string;
  packageName: string;
  wifiRxBytes: number;
  wifiTxBytes: number;
  mobileRxBytes: number;
  mobileTxBytes: number;
}

export interface DozeViolation {
  packageName: string;
  type: 'whitelist' | 'idle-exit' | 'wakeup-alarm';
  details: string;
}

export interface CpuWakeup {
  packageName: string;
  wakeupCount: number;
  periodHours: number;
}

export interface DumpsysResult {
  timestamp: number;
  chargeLevel: number;
  totalDrainMah: number;
  screenOnTimeMs: number;
  screenOffTimeMs: number;
  components: Record<string, number>;
  perUid: PerUidEntry[];
  wakelocks: WakelockEntry[];
  network: NetworkEntry[];
  dozeViolations: DozeViolation[];
  cpuWakeups: CpuWakeup[];
  /**
   * mAh attributed to the packages EcoTrace was pointed at, from the
   * `Uid <n> (<package>): <x> mAh` rows of the Estimated power use section.
   *
   * This is the value a drain rate should be derived from. It has 0.1 mAh
   * resolution and, unlike the charge level, needs no battery-capacity
   * assumption: computeDelta gets the increment over the profiling window by
   * differencing two snapshots of it (`after.appDrainMah - before.appDrainMah`),
   * so what matters is the change between them, never the absolute figure. The
   * charge-level fallback in the same function only has 1% granularity, which
   * on a 3000 mAh cell is a 30 mAh step: a two-minute session could only ever
   * report 0 or 15 mAh/min. Present when at least one watched uid was resolved
   * to a package; absent means the caller is profiling an unknown target, in
   * which case the charge-level fallback in computeDelta is the best available.
   */
  appDrainMah: number | null;
  /** Package names the rows in `appDrainMah` were attributed to. */
  appPackages: string[];
}

export interface DumpsysDelta {
  drainRateMahPerMin: number;
  elapsedMinutes: number;
  /**
   * How the drain rate was obtained. The UI and the exported report both show
   * this, because a number whose provenance is unknown is a number nobody
   * should act on.
   */
  source: 'app-estimator' | 'charge-level' | 'unavailable';
  /** Resolution of the measurement, in mAh. 30 means the figure is coarse. */
  resolutionMah: number;
  before: DumpsysResult;
  after: DumpsysResult;
  topDrainers: PerUidEntry[];
  newWakelocks: WakelockEntry[];
  dozeViolations: DozeViolation[];
  cpuWakeups: CpuWakeup[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a human-readable size string (e.g. "1.23MB", "456KB", "789B") to bytes. */
function parseBytes(value: string, unit: string): number {
  const n = parseFloat(value);
  if (isNaN(n)) return 0;
  switch (unit.toUpperCase()) {
    case 'GB': return Math.round(n * 1024 * 1024 * 1024);
    case 'MB': return Math.round(n * 1024 * 1024);
    case 'KB': return Math.round(n * 1024);
    default:   return Math.round(n);
  }
}

function safeFloat(s: string): number {
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function safeInt(s: string): number {
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}

// ---------------------------------------------------------------------------
// Section splitter (internal)
// ---------------------------------------------------------------------------

interface Sections {
  estimatedPower: string;
  mobileNetwork: string;
  wifiNetwork: string;
  wakeLocks: string;
  discharge: string;
  history: string;
}

function splitSections(raw: string): Sections {
  const result: Sections = {
    estimatedPower: '',
    mobileNetwork: '',
    wifiNetwork: '',
    wakeLocks: '',
    discharge: '',
    history: '',
  };

  type SectionKey = keyof Sections;

  const headerMap: Array<{ header: string; key: SectionKey }> = [
    { header: 'Estimated power use (mAh):', key: 'estimatedPower' },
    { header: 'Per-app mobile network traffic:', key: 'mobileNetwork' },
    { header: 'Per-app wifi network traffic:', key: 'wifiNetwork' },
    { header: 'All partial wake locks:', key: 'wakeLocks' },
    { header: 'Discharge step durations:', key: 'discharge' },
    { header: 'Battery History (', key: 'history' },
  ];

  // Find positions of each section header in the raw string
  const positions: Array<{ start: number; key: SectionKey }> = [];
  for (const { header, key } of headerMap) {
    const idx = raw.indexOf(header);
    if (idx !== -1) {
      positions.push({ start: idx, key });
    }
  }

  // Sort by position
  positions.sort((a, b) => a.start - b.start);

  // Slice each section from its header start to the next header start
  for (let i = 0; i < positions.length; i++) {
    const { start, key } = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1].start : raw.length;
    result[key] = raw.slice(start, end);
  }

  return result;
}

// ---------------------------------------------------------------------------
// parseEstimatedPowerUse
// ---------------------------------------------------------------------------

export function parseEstimatedPowerUse(
  section: string
): { components: Record<string, number>; totalDrainMah: number } {
  const components: Record<string, number> = {};
  let totalDrainMah = 0;

  try {
    const lines = section.split('\n');
    for (const line of lines) {
      // Computed drain: 214  OR  actual drain: 209-212
      const drainMatch = line.match(/(?:Computed drain|actual drain):\s*([\d.]+)/i);
      if (drainMatch) {
        const v = safeFloat(drainMatch[1]);
        if (v > totalDrainMah) totalDrainMah = v;
        continue;
      }

      // Screen: 100.2 mAh  |  Wifi: 22.1 mAh  |  Cell standby: 18.9 mAh
      // Uid 1000 (android): 48.3 mAh
      const mAhMatch = line.match(/^\s+(.+?):\s*([\d.]+)\s*mAh/i);
      if (mAhMatch) {
        const key = mAhMatch[1].trim();
        components[key] = safeFloat(mAhMatch[2]);
      }
    }
  } catch {
    // defensive — return whatever was collected
  }

  return { components, totalDrainMah };
}

// ---------------------------------------------------------------------------
// parseAppDrain
// ---------------------------------------------------------------------------

/**
 * Extracts the per-uid mAh rows for a set of watched packages.
 *
 * Real `dumpsys batterystats --charged` output puts them in the Estimated
 * power use section as:
 *
 *   Uid u0a213 (com.example.app): 412.6 mAh
 *
 * The uid is a letter-prefixed `u0aNNN` on user builds and a bare integer on
 * some, and the package name is optional, so both forms are accepted and the
 * uid is also resolved through the `Uid <n>:` rows in the Discharge section.
 */
export function parseAppDrain(
  section: string,
  watched: ReadonlySet<string>,
  uidToPackage: ReadonlyMap<string, string>
): { mah: number; packages: string[] } {
  const rowRe = /^\s*Uid\s+([\w]+)\s*(?:\(([^)]+)\))?\s*:\s*([\d.]+)\s*mAh/i;
  const total: Record<string, number> = {};

  for (const line of section.split('\n')) {
    const m = rowRe.exec(line);
    if (!m) continue;

    const uid = m[1];
    const inline = m[2] ? m[2].trim() : undefined;
    const pkg = inline ?? uidToPackage.get(uid);
    if (!pkg || !watched.has(pkg)) continue;

    total[pkg] = (total[pkg] ?? 0) + safeFloat(m[3]);
  }

  const packages = Object.keys(total);
  const mah = packages.reduce((sum, pkg) => sum + total[pkg], 0);
  return { mah: round2(mah), packages };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// buildUidPackageMap
// ---------------------------------------------------------------------------

/**
 * Builds the uid → package map from the only places batterystats prints a
 * package name alongside a uid: the `Uid u0a213 (com.example.app):` rows of
 * the Estimated power use section (and the same rows in the Discharge
 * section), plus the `PACKAGE:` line under a per-uid block.
 *
 * Every other row — wakelocks, network traffic, whitelist entries — carries a
 * bare uid, so without this map those rows can only report the synthetic
 * `uid:<n>` / raw-uid placeholder they have always reported. With it they
 * report the real package whenever this dump ever named one, and keep the
 * placeholder when it did not: a uid with no known package is simply absent
 * from the map, never guessed at.
 *
 * Each uid is filed under both of its spellings — `u0a213` and the numeric
 * `10213` it expands to — because the Estimated-power-use rows use the letter
 * form while the network and wakelock sections use the numeric one.
 */
function buildUidPackageMap(section: string, perUid: PerUidEntry[]): Map<string, string> {
  const map = new Map<string, string>();

  const add = (uid: string | undefined, pkg: string | undefined): void => {
    if (!uid || !pkg || pkg === uid) return;
    for (const spelling of uidSpellings(uid)) {
      if (!map.has(spelling)) map.set(spelling, pkg);
    }
  };

  // Uid u0a213 (com.example.app): 412.6 mAh  —  parens are the signal that
  // this row actually names the package.
  const rowRe = /^\s*Uid\s+(\S+)\s*\(([^)]+)\)\s*:/i;
  for (const line of section.split('\n')) {
    const m = rowRe.exec(line);
    if (m) add(m[1], m[2].trim());
  }

  for (const entry of perUid) add(entry.uid, entry.packageName);

  return map;
}

/**
 * The spellings batterystats uses for one uid: `u0a213` ↔ `10213`, derived
 * from the Android uid layout (`userId * 100000 + appId`, where an `aN` app id
 * is `10000 + N`). A uid that converts to nothing — `1000` for android, say —
 * is filed under the spelling it arrived in.
 */
function uidSpellings(uid: string): string[] {
  const lettered = /^u(\d+)a(\d+)$/.exec(uid);
  if (lettered) {
    const numeric = Number(lettered[1]) * 100000 + 10000 + Number(lettered[2]);
    return [uid, String(numeric)];
  }
  if (/^\d+$/.test(uid)) {
    const numeric = Number(uid);
    const userId = Math.floor(numeric / 100000);
    const appId = numeric % 100000;
    if (appId >= 10000) return [uid, `u${userId}a${appId - 10000}`];
  }
  return [uid];
}

// ---------------------------------------------------------------------------
// parsePerUidData
// ---------------------------------------------------------------------------

export function parsePerUidData(section: string): PerUidEntry[] {
  const entries: PerUidEntry[] = [];

  try {
    const lines = section.split('\n');
    // uid line pattern:  Uid u0a85: 12.5ms cpu, 340ms wakelock, 0ms wifi
    const uidRe = /Uid\s+([\w\d]+):\s*([\d.]+)ms\s+cpu(?:,\s*([\d.]+)ms\s+wakelock)?(?:,\s*([\d.]+)ms\s+wifi)?(?:,\s*([\d.]+)ms\s+mobile)?/i;
    // PACKAGE line immediately after
    const pkgRe = /PACKAGE:\s*(\S+)/;

    for (let i = 0; i < lines.length; i++) {
      const m = uidRe.exec(lines[i]);
      if (!m) continue;

      const uid = m[1];
      const cpuTimeMs = safeFloat(m[2]);
      const wakelockDurationMs = m[3] !== undefined ? safeFloat(m[3]) : 0;
      const wifiTimeMs = m[4] !== undefined ? safeFloat(m[4]) : 0;
      const mobileTimeMs = m[5] !== undefined ? safeFloat(m[5]) : 0;

      // Look ahead for PACKAGE line (within the next 3 lines)
      let packageName = uid;
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const pm = pkgRe.exec(lines[j]);
        if (pm) {
          packageName = pm[1];
          break;
        }
      }

      entries.push({ uid, packageName, cpuTimeMs, wakelockDurationMs, wifiTimeMs, mobileTimeMs });
    }
  } catch {
    // defensive
  }

  return entries;
}

// ---------------------------------------------------------------------------
// parseWakelockHistory
// ---------------------------------------------------------------------------

export function parseWakelockHistory(
  section: string,
  uidToPackage?: ReadonlyMap<string, string>
): WakelockEntry[] {
  const entries: WakelockEntry[] = [];

  try {
    const lines = section.split('\n');
    // Wake lock *alarm* 1 times, 340ms total (uid 1000)
    const re = /Wake lock\s+(\S+)\s+(\d+)\s+times?,\s+([\d.]+)ms\s+total\s+\(uid\s+(\d+)\)/i;

    for (const line of lines) {
      const m = re.exec(line);
      if (!m) continue;
      entries.push({
        name: m[1],
        // The row only carries a uid; the real package name comes from the
        // uid → package map when this uid was ever seen with one, and the
        // synthetic `uid:<n>` remains for uids no section named.
        packageName: uidToPackage?.get(m[4]) ?? `uid:${m[4]}`,
        holdDurationMs: safeFloat(m[3]),
        acquireCount: safeInt(m[2]),
      });
    }
  } catch {
    // defensive
  }

  return entries;
}

// ---------------------------------------------------------------------------
// parseNetworkStats
// ---------------------------------------------------------------------------

export function parseNetworkStats(
  section: string,
  uidToPackage?: ReadonlyMap<string, string>
): NetworkEntry[] {
  // We receive either the wifi section or the mobile section.
  // Caller merges results; here we detect which type from content.
  const entries: PerUidNetRaw[] = [];

  try {
    const lines = section.split('\n');
    // Uid 10085: 1.23MB received, 456KB sent (wifi)
    const re = /Uid\s+(\d+):\s*([\d.]+)(\w+)\s+received,\s*([\d.]+)(\w+)\s+sent\s+\((wifi|mobile)\)/i;

    for (const line of lines) {
      const m = re.exec(line);
      if (!m) continue;
      entries.push({
        uid: m[1],
        rxBytes: parseBytes(m[2], m[3]),
        txBytes: parseBytes(m[4], m[5]),
        iface: m[6].toLowerCase() as 'wifi' | 'mobile',
      });
    }
  } catch {
    // defensive
  }

  return mergeNetworkEntries(entries, uidToPackage);
}

interface PerUidNetRaw {
  uid: string;
  rxBytes: number;
  txBytes: number;
  iface: 'wifi' | 'mobile';
}

function mergeNetworkEntries(
  raws: PerUidNetRaw[],
  uidToPackage?: ReadonlyMap<string, string>
): NetworkEntry[] {
  const map = new Map<string, NetworkEntry>();
  for (const r of raws) {
    if (!map.has(r.uid)) {
      map.set(r.uid, {
        uid: r.uid,
        // The traffic rows carry a bare uid, so a real package name is only
        // possible through the uid → package map; an unknown uid keeps the
        // raw uid it has always reported rather than inventing a package.
        packageName: uidToPackage?.get(r.uid) ?? r.uid,
        wifiRxBytes: 0,
        wifiTxBytes: 0,
        mobileRxBytes: 0,
        mobileTxBytes: 0,
      });
    }
    const e = map.get(r.uid)!;
    if (r.iface === 'wifi') {
      e.wifiRxBytes += r.rxBytes;
      e.wifiTxBytes += r.txBytes;
    } else {
      e.mobileRxBytes += r.rxBytes;
      e.mobileTxBytes += r.txBytes;
    }
  }
  return Array.from(map.values());
}

// ---------------------------------------------------------------------------
// parseDozeViolations
// ---------------------------------------------------------------------------

/**
 * DeviceIdleController state numbers, verbatim from AOSP
 * (`frameworks/base/.../DeviceIdleController.java`). Older revisions of this
 * parser assumed 2 = IDLE and 3 = MAINTENANCE, which never matched a real
 * dump: those numbers are IDLE_PENDING and SENSING, so genuine IDLE↔
 * MAINTENANCE transitions were invisible and the walking-towards-idle
 * transitions were reported as idle exits.
 */
const IDLE_STATE_NAMES: Record<number, string> = {
  0: 'ACTIVE',
  1: 'INACTIVE',
  2: 'IDLE_PENDING',
  3: 'SENSING',
  4: 'LOCATING',
  5: 'IDLE',
  6: 'IDLE_MAINTENANCE',
};

/** The only state from which an exit is reportable (5 = IDLE). */
const IDLE_STATE = 5;

/** Name for a state number, falling back to the raw number for unknowns. */
function idleStateName(state: number): string {
  return IDLE_STATE_NAMES[state] ?? String(state);
}

export function parseDozeViolations(
  section: string,
  uidToPackage?: ReadonlyMap<string, string>
): DozeViolation[] {
  const violations: DozeViolation[] = [];
  const seen = new Set<string>();

  const push = (v: DozeViolation): void => {
    const key = `${v.type}|${v.packageName}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push(v);
  };

  try {
    const lines = section.split('\n');

    // Tracked forwards rather than by walking backwards from each line: a
    // transition only makes sense with both ends, and the numbering above is
    // what tells IDLE (5) apart from IDLE_PENDING (2) or SENSING (3).
    let lastIdleState: number | null = null;
    let inIdle = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // ── Doze state machine ──────────────────────────────────────────────
      // batterystats prints the device's own transitions as
      //   mDeviceIdleState=5 (IDLE) → mDeviceIdleState=6 (IDLE_MAINTENANCE)
      // next to per-package lines such as
      //   App com.example.app deadline exceeded: [10] +5m0s
      // Entering IDLE (anything → 5) arms the machine; leaving it (5 → any
      // other state, 6 included) is the idle exit worth reporting — the
      // moment a package's work ran outside idle. Walking towards idle
      // (0 → 1 → 2 → 3 → 4) is the device scheduling doze, not leaving it,
      // and is deliberately not a finding.
      const idleLine = /mDeviceIdleState=(\d+)/.exec(line);
      if (idleLine) {
        const next = Number(idleLine[1]);
        const prev = lastIdleState;
        lastIdleState = next;

        if (next === IDLE_STATE && prev !== IDLE_STATE) {
          // Entering IDLE — from INACTIVE/SENSING/LOCATING on the way down,
          // or straight back from a maintenance window (6 → 5).
          inIdle = true;
        } else if (prev === IDLE_STATE && next !== IDLE_STATE && inIdle) {
          // 5 → 6 opens a maintenance window in which the package's work
          // runs; 5 → anything lower means the device was pulled out of doze
          // outright. Both are exits from IDLE, so both are reported.
          inIdle = false;
          push({
            packageName: packageFor(lines, i),
            type: 'idle-exit',
            details: `Doze idle state ${idleStateName(prev)} → ${idleStateName(next)} (line ${i + 1})`,
          });
        }
        continue;
      }

      // ── Wakeup alarms charged against idle ──────────────────────────────
      if (/setAlarmLocked/i.test(line) && /FLAG_WAKE_FROM_IDLE/i.test(line)) {
        const pkg = extractPackage(line) ?? extractPackage(lines[i + 1] ?? '') ?? 'unknown';
        push({
          packageName: pkg,
          type: 'wakeup-alarm',
          details: line.trim().slice(0, 300),
        });
        continue;
      }

      // ── Whitelist entries ───────────────────────────────────────────────
      // The real header is `Whitelisted app stats:`. The previous parser
      // looked for `Doze Whitelist`, a string that does not appear in
      // batterystats output at all, so the whitelist branch was unreachable
      // and the section silently contributed nothing. The revision after that
      // guarded the loop with `/^\s*\S/`, which matches any non-empty line:
      // a well-shaped entry was still read, because the accept test runs
      // first, but the very first separator or annotation line after it ended
      // the whole section. This one walks the section instead: entries are
      // consumed, separators are skipped, ordinary annotation lines are
      // ignored, and only a real boundary — a `Uid ...` app-power block, a
      // run of blank lines, or the next section header — stops the scan.
      if (/^\s*Whitelisted app stats\s*:?\s*$/i.test(line)) {
        let blanks = 0;
        for (let j = i + 1; j < lines.length; j++) {
          const entry = lines[j];
          const trimmed = entry.trim();

          // A run of blank lines ends the block; a single blank inside it is
          // just spacing between groups.
          if (trimmed === '') {
            blanks += 1;
            if (blanks >= 2) break;
            continue;
          }
          blanks = 0;

          // Rules of the dump, not data: `----`, `====`, and their cousins.
          if (/^[-=_*#+~·]+$/.test(trimmed)) continue;

          // Boundary — the `Uid ...` app-power block that follows the list.
          if (/^\s*Uid\s/i.test(entry)) break;

          // Boundary — the next section header: batterystats titles start at
          // column 0 and end in a colon.
          if (/^\S[^:]*:\s*$/.test(entry)) break;

          // An entry: `10012: 45mAh`. The leading token is a uid index in
          // practice (or a package name, should the dump print one), so it is
          // resolved through the uid → package map like every other bare uid.
          const entryMatch = /^\s*([\w.]+):\s*[\d.]+\s*mAh\b/i.exec(entry);
          if (entryMatch) {
            const key = entryMatch[1];
            const pkg =
              uidToPackage?.get(key) ??
              (key.includes('.') ? key : `uid:${key}`);
            push({
              packageName: pkg,
              type: 'whitelist',
              details: trimmed.slice(0, 200),
            });
            continue;
          }

          // Anything else inside the block is annotation — skip it and keep
          // reading; the boundary tests above decide when to stop.
        }
        continue;
      }
    }
  } catch {
    // defensive
  }

  return violations;
}

/** The nearest package name to a line, used to attribute a device transition. */
function packageFor(lines: string[], from: number): string {
  for (let i = from; i < lines.length && i < from + 6; i++) {
    const pkg = extractPackage(lines[i]);
    if (pkg) return pkg;
  }
  for (let i = from - 1; i >= 0 && i >= from - 6; i--) {
    const pkg = extractPackage(lines[i]);
    if (pkg) return pkg;
  }
  return 'system';
}

function extractPackage(line: string): string | undefined {
  const m = /\b([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)\b/i.exec(line);
  return m ? m[1] : undefined;
}

// ---------------------------------------------------------------------------
// parseCpuWakeups
// ---------------------------------------------------------------------------

export function parseCpuWakeups(section: string): CpuWakeup[] {
  const wakeups: CpuWakeup[] = [];

  try {
    const lines = section.split('\n');
    // Wakeup alarm com.example.app: 96 times in past 1hr
    const re = /Wakeup alarm\s+(\S+):\s*(\d+)\s+times?\s+in\s+past\s+([\d.]+)\s*hr/i;

    for (const line of lines) {
      const m = re.exec(line);
      if (!m) continue;
      wakeups.push({
        packageName: m[1],
        wakeupCount: safeInt(m[2]),
        periodHours: safeFloat(m[3]),
      });
    }
  } catch {
    // defensive
  }

  return wakeups;
}

// ---------------------------------------------------------------------------
// parseBatteryLevel
// ---------------------------------------------------------------------------

export function parseBatteryLevel(raw: string): number {
  try {
    // Scan for all occurrences of `level: <N>` and return the last one
    const re = /\blevel:\s*(\d+)/gi;
    let level = -1;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const v = safeInt(m[1]);
      if (v >= 0 && v <= 100) level = v;
    }
    return level;
  } catch {
    return -1;
  }
}

// ---------------------------------------------------------------------------
// parseScreenTimes (internal helper)
// ---------------------------------------------------------------------------

function parseScreenTimes(raw: string): { screenOnTimeMs: number; screenOffTimeMs: number } {
  let screenOnTimeMs = 0;
  let screenOffTimeMs = 0;

  try {
    // Screen on: 1h 23m 45s 600ms  or  Screen on: 1234ms
    const onMatch = raw.match(/Screen on:\s*((?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s\s*)?(?:\d+ms)?)/i);
    if (onMatch) screenOnTimeMs = parseDuration(onMatch[1]);

    const offMatch = raw.match(/Screen off:\s*((?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s\s*)?(?:\d+ms)?)/i);
    if (offMatch) screenOffTimeMs = parseDuration(offMatch[1]);
  } catch {
    // defensive
  }

  return { screenOnTimeMs, screenOffTimeMs };
}

function parseDuration(s: string): number {
  let total = 0;
  const h = s.match(/(\d+)h/);
  // Use negative lookahead to avoid matching "ms" as minutes
  const m = s.match(/(\d+)m(?!s)/);
  const sec = s.match(/(\d+)s(?!ec)/);
  const msec = s.match(/(\d+)ms/);
  if (h)    total += safeInt(h[1])    * 3600000;
  if (m)    total += safeInt(m[1])    * 60000;
  if (sec)  total += safeInt(sec[1])  * 1000;
  if (msec) total += safeInt(msec[1]);
  return total;
}

// ---------------------------------------------------------------------------
// parseDumpsys — main public API
// ---------------------------------------------------------------------------

export function parseDumpsys(raw: string, watchedPackages?: readonly string[]): DumpsysResult {
  const watched = new Set(watchedPackages ?? []);
  const defaults: DumpsysResult = {
    timestamp: Date.now(),
    chargeLevel: -1,
    totalDrainMah: 0,
    screenOnTimeMs: 0,
    screenOffTimeMs: 0,
    components: {},
    perUid: [],
    wakelocks: [],
    network: [],
    dozeViolations: [],
    cpuWakeups: [],
    appDrainMah: null,
    appPackages: [],
  };

  if (!raw || raw.trim() === '') return defaults;

  try {
    const sections = splitSections(raw);

    // Power use
    let components: Record<string, number> = {};
    let totalDrainMah = 0;
    try {
      const p = parseEstimatedPowerUse(sections.estimatedPower);
      components = p.components;
      totalDrainMah = p.totalDrainMah;
    } catch { /* defensive */ }

    // Per-uid
    let perUid: PerUidEntry[] = [];
    try {
      perUid = parsePerUidData(sections.estimatedPower + '\n' + sections.discharge);
    } catch { /* defensive */ }

    // uid → package, from the rows that carry package names (see
    // buildUidPackageMap). It attributes the Estimated-power-use rows when
    // batterystats omits the parenthetical package, and it is what lets the
    // wakelock, network and whitelist rows below report a real package name
    // instead of a bare uid.
    const uidToPackage = buildUidPackageMap(
      sections.estimatedPower + '\n' + sections.discharge,
      perUid
    );

    let appDrainMah: number | null = null;
    let appPackages: string[] = [];
    if (watched.size > 0) {
      try {
        const app = parseAppDrain(sections.estimatedPower, watched, uidToPackage);
        if (app.packages.length > 0) {
          appDrainMah = app.mah;
          appPackages = app.packages;
        }
      } catch { /* defensive */ }
    }

    // Wakelocks
    let wakelocks: WakelockEntry[] = [];
    try {
      wakelocks = parseWakelockHistory(sections.wakeLocks, uidToPackage);
    } catch { /* defensive */ }

    // Network — parse wifi and mobile sections, then merge by uid
    let network: NetworkEntry[] = [];
    try {
      const wifiEntries = parseNetworkStats(sections.wifiNetwork, uidToPackage);
      const mobileEntries = parseNetworkStats(sections.mobileNetwork, uidToPackage);
      // Merge by uid
      const netMap = new Map<string, NetworkEntry>();
      for (const e of [...wifiEntries, ...mobileEntries]) {
        if (!netMap.has(e.uid)) {
          netMap.set(e.uid, { ...e });
        } else {
          const ex = netMap.get(e.uid)!;
          ex.wifiRxBytes += e.wifiRxBytes;
          ex.wifiTxBytes += e.wifiTxBytes;
          ex.mobileRxBytes += e.mobileRxBytes;
          ex.mobileTxBytes += e.mobileTxBytes;
        }
      }
      network = Array.from(netMap.values());
    } catch { /* defensive */ }

    // Doze violations — scan the full raw text
    let dozeViolations: DozeViolation[] = [];
    try {
      dozeViolations = parseDozeViolations(raw, uidToPackage);
    } catch { /* defensive */ }

    // CPU wakeups — scan the full raw text
    let cpuWakeups: CpuWakeup[] = [];
    try {
      cpuWakeups = parseCpuWakeups(raw);
    } catch { /* defensive */ }

    // Battery level
    const chargeLevel = parseBatteryLevel(raw);

    // Screen times
    const { screenOnTimeMs, screenOffTimeMs } = parseScreenTimes(raw);

    return {
      timestamp: Date.now(),
      chargeLevel,
      totalDrainMah,
      screenOnTimeMs,
      screenOffTimeMs,
      components,
      perUid,
      wakelocks,
      network,
      dozeViolations,
      cpuWakeups,
      appDrainMah,
      appPackages,
    };
  } catch {
    return defaults;
  }
}

// ---------------------------------------------------------------------------
// computeDelta
// ---------------------------------------------------------------------------

/**
 * Computes the drain rate between two snapshots.
 *
 * Two estimators, in order of preference:
 *
 *  1. `appDrainMah` — batterystats' own per-uid mAh accounting for the
 *     packages under test, differenced between the two snapshots so the figure
 *     is the window's increment. Resolution 0.1 mAh, and scoped to the app
 *     rather than to the whole device. This is the number a developer can act
 *     on.
 *  2. Charge level — `(before% - after%) / 100 * capacity`. The capacity is a
 *     nominal guess (a 3000 mAh cell is typical but not universal) and the
 *     resolution is one percentage point, i.e. 30 mAh. On a short session that
 *     is the difference between "0.00 mAh/min" and "15.00 mAh/min" for a
 *     battery that did not measurably move. It is reported with its
 *     resolution attached so the UI can say so out loud.
 */
export function computeDelta(
  before: DumpsysResult,
  after: DumpsysResult,
  batteryCapacityMah = 3000
): DumpsysDelta {
  const elapsedMinutes = (after.timestamp - before.timestamp) / 60000;

  let drainRateMahPerMin = 0;
  let source: DumpsysDelta['source'] = 'unavailable';
  let resolutionMah = 0;

  if (elapsedMinutes > 0) {
    // 1. Prefer the per-package estimator.
    if (
      after.appDrainMah !== null &&
      before.appDrainMah !== null &&
      Number.isFinite(after.appDrainMah) &&
      Number.isFinite(before.appDrainMah)
    ) {
      const deltaMah = after.appDrainMah - before.appDrainMah;
      if (deltaMah > 0) {
        drainRateMahPerMin = deltaMah / elapsedMinutes;
        source = 'app-estimator';
        resolutionMah = 0.1;
      }
    }

    // 2. Fall back to the charge-level difference.
    if (source === 'unavailable') {
      const levelsValid =
        before.chargeLevel >= 0 && before.chargeLevel <= 100 &&
        after.chargeLevel >= 0 && after.chargeLevel <= 100;
      if (levelsValid) {
        const dropMah = ((before.chargeLevel - after.chargeLevel) / 100) * batteryCapacityMah;
        // A level that went *up* means the device charged during the window;
        // reporting 0 there would imply a measurement rather than a rewind.
        if (dropMah > 0) {
          drainRateMahPerMin = dropMah / elapsedMinutes;
          source = 'charge-level';
          resolutionMah = round2(batteryCapacityMah / 100);
        }
      }
    }
  }

  drainRateMahPerMin = Math.max(0, round2(drainRateMahPerMin));

  // topDrainers: sort after.perUid by cpuTimeMs desc, take top 5
  const topDrainers = [...after.perUid]
    .sort((a, b) => b.cpuTimeMs - a.cpuTimeMs)
    .slice(0, 5);

  // newWakelocks: wakelocks in after not present in before (by name)
  const beforeNames = new Set(before.wakelocks.map(w => w.name));
  const newWakelocks = after.wakelocks.filter(w => !beforeNames.has(w.name));

  return {
    drainRateMahPerMin,
    elapsedMinutes,
    source,
    resolutionMah,
    before,
    after,
    topDrainers,
    newWakelocks,
    dozeViolations: after.dozeViolations,
    cpuWakeups: after.cpuWakeups,
  };
}
