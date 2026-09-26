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
