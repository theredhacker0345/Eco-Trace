// EcoTrace — Settings persistence
// Reads/writes %APPDATA%\ecotrace\settings.json via the Tauri FS plugin.

import { readTextFile, writeTextFile, mkdir, exists } from "@tauri-apps/plugin-fs";
import { appDataDir, join } from "@tauri-apps/api/path";

export interface AppSettings {
  /** Full path to the adb executable, or just "adb" if it is on PATH. */
  adbPath: string;
  /** IBM Bob 2.0 API key — stored locally, used for all analysis calls. */
  apiKey: string;
  /** Bob model to use for analysis. */
  bobModel: "bob-2" | "bob-2-mini";
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export function getDefaultSettings(): AppSettings {
  return { adbPath: "adb", apiKey: "", bobModel: "bob-2" };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function settingsFilePath(): Promise<string> {
  const base = await appDataDir();
  return join(base, "ecotrace", "settings.json");
}

async function settingsDirPath(): Promise<string> {
  const base = await appDataDir();
  return join(base, "ecotrace");
}

/**
 * Where exported reports are written.
 *
 * Deliberately under the app's own app-data directory rather than the OS temp
 * directory. The `fs` capability is scoped to app-data, and Tauri's
 * `scope-appdata-recursive` resolves to `$APPDATA` (Roaming) — *not* to
 * `$LOCALAPPDATA\Temp`. Writing there therefore failed at the capability
 * boundary with `forbidden path: C:\Users\<user>\AppData\Local\Temp\...`, which
 * surfaced as "Could not open the report" and took the whole "open in browser"
 * action down with it.
 *
 * It is also the better location on the merits: a generated report the user was
 * told to open should not be somewhere the OS is entitled to delete.
 */
export async function reportsDirPath(): Promise<string> {
  return join(await settingsDirPath(), "reports");
}

/** Creates the reports directory if absent and returns it. */
export async function ensureReportsDir(): Promise<string> {
  const dir = await reportsDirPath();
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function loadSettings(): Promise<AppSettings> {
  try {
    const filePath = await settingsFilePath();
    const fileExists = await exists(filePath);
    if (!fileExists) return getDefaultSettings();
    const raw = await readTextFile(filePath);
    return { ...getDefaultSettings(), ...(JSON.parse(raw) as Partial<AppSettings>) };
  } catch {
    return getDefaultSettings();
  }
}

export async function saveSettings(s: AppSettings): Promise<void> {
  const dir = await settingsDirPath();
  if (!(await exists(dir))) {
    await mkdir(dir, { recursive: true });
  }
  const filePath = await settingsFilePath();
  await writeTextFile(filePath, JSON.stringify(s, null, 2));
}
