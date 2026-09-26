/**
 * The detector catalogue.
 *
 * EcoTrace ships 23 detectors. Listing them on the first-run surface is a
 * deliberate product decision: the rules are the product's actual content, and
 * a user deciding whether to trust a static analyser needs to know what it
 * will and will not look for before they point it at a repository.
 *
 * The list mirrors src/analyzer/static.ts. Both are kept adjacent in review so
 * a new detector cannot be added to one and forgotten in the other.
 */

export type CatalogSeverity = "Critical" | "High" | "Medium";

export interface DetectorEntry {
  id: string;
  name: string;
  severity: CatalogSeverity;
}

export interface CatalogGroup {
  key: string;
  title: string;
  icon: string;
  detectors: DetectorEntry[];
}

export const CATALOG: CatalogGroup[] = [
  {
    key: "wakefulness",
    title: "Wakefulness",
    icon: "battery",
    detectors: [
      { id: "W01", name: "Unclosed WakeLock", severity: "Critical" },
      { id: "W02", name: "WakeLock across an IPC boundary", severity: "Critical" },
      { id: "W03", name: "WakeLock inside AsyncTask", severity: "Critical" },
      { id: "W04", name: "PARTIAL_WAKE_LOCK in a service", severity: "Critical" },
      { id: "W05", name: "WakeLock in a receiver without goAsync", severity: "Critical" },
      { id: "W06", name: "Nested WakeLock acquisition", severity: "High" },
    ],
  },
  {
    key: "network",
    title: "Network",
    icon: "flow",
    detectors: [
      { id: "N01", name: "Network call in a postDelayed loop", severity: "Critical" },
      { id: "N02", name: "No connection timeout", severity: "High" },
      { id: "N03", name: "No read timeout", severity: "High" },
      { id: "N04", name: "Cleartext HTTP endpoint", severity: "High" },
      { id: "N05", name: "Synchronous network on the main thread", severity: "Critical" },
      { id: "N06", name: "Polling with no push alternative", severity: "High" },
    ],
  },
  {
    key: "location",
    title: "Location & sensors",
    icon: "device",
    detectors: [
      { id: "L01", name: "GPS interval under 30 seconds", severity: "Critical" },
      { id: "L02", name: "FINE location where COARSE suffices", severity: "High" },
      { id: "L03", name: "Sensor not unregistered on pause", severity: "Critical" },
      { id: "L04", name: "Full-rate accelerometer for step counting", severity: "High" },
      { id: "L05", name: "Geofencing implemented by polling", severity: "High" },
    ],
  },
  {
    key: "architecture",
    title: "Lifecycle",
    icon: "code",
    detectors: [
      { id: "A01", name: "Service with no stopSelf()", severity: "High" },
      { id: "A02", name: "Deferrable work on a raw service", severity: "High" },
      { id: "A03", name: "JobScheduler ignored for sync", severity: "Medium" },
      { id: "A04", name: "Infinite animator never cancelled", severity: "High" },
      { id: "A05", name: "Allocation or I/O inside onDraw()", severity: "Critical" },
      { id: "A06", name: "WAKEUP alarm for deferrable work", severity: "High" },
    ],
  },
];

export const DETECTOR_COUNT = CATALOG.reduce(
  (total, group) => total + group.detectors.length,
  0
);

/** Category inferred from a rule id prefix; matches the analyzer's taxonomy. */
export function categoryForRule(patternId: string): string {
  switch (patternId[0]) {
    case "W":
      return "Wakefulness";
    case "N":
      return "Network";
    case "L":
      return "Location/Sensors";
    case "A":
      return "Lifecycle";
    default:
      return "Unclassified";
  }
}

export function detectorById(patternId: string): DetectorEntry | undefined {
  for (const group of CATALOG) {
    const hit = group.detectors.find((d) => d.id === patternId);
    if (hit) return hit;
  }
  return undefined;
}
