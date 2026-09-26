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
   * resolution and is already an *increment over the counting window*, so it
   * needs no battery-capacity assumption and no differencing — whereas the
   * charge-level percentage only has 1% granularity, which on a 3000 mAh cell
   * is a 30 mAh step: a two-minute session could only ever report 0 or
   * 15 mAh/min. Present when at least one watched uid was resolved to a
   * package; absent means the caller is profiling an unknown target, in which
   * case the charge-level fallback in computeDelta is the best available.
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

export function parseWakelockHistory(section: string): WakelockEntry[] {
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
        packageName: `uid:${m[4]}`,
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

export function parseNetworkStats(section: string): NetworkEntry[] {
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

  return mergeNetworkEntries(entries);
}

interface PerUidNetRaw {
  uid: string;
  rxBytes: number;
  txBytes: number;
  iface: 'wifi' | 'mobile';
}

function mergeNetworkEntries(raws: PerUidNetRaw[]): NetworkEntry[] {
  const map = new Map<string, NetworkEntry>();
  for (const r of raws) {
    if (!map.has(r.uid)) {
      map.set(r.uid, {
        uid: r.uid,
        packageName: r.uid,
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

export function parseDozeViolations(section: string): DozeViolation[] {
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

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // ── App-level Doze state machine ────────────────────────────────────
      // batterystats prints the device's own transitions as
      //   mDeviceIdleState=3 (IDLE) → mDeviceIdleState=2
      // and per-package transitions as
      //   App com.example.app deadline exceeded: [10] +5m0s
      // A transition out of IDLE/MAINTENANCE back to a running state means the
      // package pulled the device out of idle.
      const idleLine = /mDeviceIdleState=(\d+)/.exec(line);
      if (idleLine) {
        const next = Number(idleLine[1]);
        // 2 = IDLE, 3 = MAINTENANCE. 1 = LIGHT_IDLE on older builds. Anything
        // at or below those, arriving from a deeper state, is an idle exit.
        if (next <= 2) {
          const prev = previousIdleState(lines, i);
          if (prev !== null && prev > next) {
            const pkg = packageFor(lines, i);
            push({
              packageName: pkg,
              type: 'idle-exit',
              details: `Doze idle state ${prev} → ${next} (line ${i + 1})`,
            });
          }
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
      // and the section silently contributed nothing.
      if (/^\s*Whitelisted app stats\s*:?\s*$/i.test(line)) {
        for (let j = i + 1; j < lines.length; j++) {
          const entry = lines[j];
          if (entry.trim() === '') break;
          if (/^\s*[\d.]+:\s*[\d.]+mAh/.test(entry)) {
            const pkg = /^\s*([\w.]+)\s*:/.exec(entry)?.[1];
            if (pkg) {
              push({
                packageName: pkg,
                type: 'whitelist',
                details: entry.trim().slice(0, 200),
              });
            }
            continue;
          }
          if (/^\s*Uid\s/i.test(entry) || /^\s*\S/.test(entry)) break;
        }
        continue;
      }
    }
  } catch {
    // defensive
  }

  return violations;
}

/** Walks backwards to the last idle state seen, so a transition has two ends. */
function previousIdleState(lines: string[], before: number): number | null {
  for (let i = before - 1; i >= 0 && i >= before - 40; i--) {
    const m = /mDeviceIdleState=(\d+)/.exec(lines[i]);
    if (m) return Number(m[1]);
  }
  return null;
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

    // uid → package, so the Estimated-power-use rows can be attributed even
    // when batterystats omits the parenthetical package name.
    const uidToPackage = new Map<string, string>();
    for (const entry of perUid) {
      if (entry.packageName && entry.packageName !== entry.uid) {
        uidToPackage.set(entry.uid, entry.packageName);
      }
    }

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
      wakelocks = parseWakelockHistory(sections.wakeLocks);
    } catch { /* defensive */ }

    // Network — parse wifi and mobile sections, then merge by uid
    let network: NetworkEntry[] = [];
    try {
      const wifiEntries = parseNetworkStats(sections.wifiNetwork);
      const mobileEntries = parseNetworkStats(sections.mobileNetwork);
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
      dozeViolations = parseDozeViolations(raw);
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
 *     packages under test. Resolution 0.1 mAh, already a window delta, and
 *     scoped to the app rather than to the whole device. This is the number a
 *     developer can act on.
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
