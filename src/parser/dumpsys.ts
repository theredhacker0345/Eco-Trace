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
}

export interface DumpsysDelta {
  drainRateMahPerMin: number;
  elapsedMinutes: number;
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

  try {
    const lines = section.split('\n');
    let inWhitelist = false;

    for (const line of lines) {
      // Whitelist section header
      if (/Doze Whitelist/i.test(line)) {
        inWhitelist = true;
        continue;
      }

      if (inWhitelist) {
        // End of whitelist section: blank line or different header
        if (line.trim() === '' || /^\s{0,2}\S/.test(line) && !/^\s+\w/.test(line)) {
          inWhitelist = false;
        } else {
          // Package name on its own line, possibly indented
          const pkg = line.trim();
          if (pkg && !pkg.startsWith('#')) {
            violations.push({ packageName: pkg, type: 'whitelist', details: line.trim() });
          }
          continue;
        }
      }

      // idle-exit: mDeviceIdleState changes to ACTIVE from non-IDLE
      const idleExitMatch = line.match(/mDeviceIdleState.*?ACTIVE.*?from\s+(\S+)/i);
      if (idleExitMatch) {
        const prev = idleExitMatch[1].toUpperCase();
        if (prev !== 'IDLE') {
          violations.push({ packageName: 'system', type: 'idle-exit', details: line.trim() });
        }
        continue;
      }

      // wakeup-alarm: setAlarmLocked with FLAG_WAKE_FROM_IDLE
      if (/setAlarmLocked/i.test(line) && /FLAG_WAKE_FROM_IDLE/i.test(line)) {
        // Try to extract a package name from the line
        const pkgMatch = line.match(/([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,})/i);
        const pkg = pkgMatch ? pkgMatch[1] : 'unknown';
        violations.push({ packageName: pkg, type: 'wakeup-alarm', details: line.trim() });
      }
    }
  } catch {
    // defensive
  }

  return violations;
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

export function parseDumpsys(raw: string): DumpsysResult {
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
    };
  } catch {
    return defaults;
  }
}

// ---------------------------------------------------------------------------
// computeDelta
// ---------------------------------------------------------------------------

export function computeDelta(
  before: DumpsysResult,
  after: DumpsysResult,
  batteryCapacityMah = 3000
): DumpsysDelta {
  const elapsedMinutes = (after.timestamp - before.timestamp) / 60000;

  let drainRateMahPerMin = 0;
  // Only compute drain rate when both charge levels are valid (0–100) and
  // enough time has elapsed. A chargeLevel of -1 means "not parsed" and
  // would produce a wildly wrong drain figure.
  const levelsValid =
    before.chargeLevel >= 0 && before.chargeLevel <= 100 &&
    after.chargeLevel  >= 0 && after.chargeLevel  <= 100;
  if (elapsedMinutes > 0 && levelsValid) {
    drainRateMahPerMin =
      Math.max(0, ((before.chargeLevel - after.chargeLevel) / 100) * batteryCapacityMah / elapsedMinutes);
  }

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
    before,
    after,
    topDrainers,
    newWakelocks,
    dozeViolations: after.dozeViolations,
    cpuWakeups: after.cpuWakeups,
  };
}
