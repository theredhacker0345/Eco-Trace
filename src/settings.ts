// EcoTrace — Settings persistence (Sub-Task 4b)
// Reads/writes %APPDATA%\ecotrace\settings.json via the Tauri FS plugin.

import { readTextFile, writeTextFile, mkdir, exists } from "@tauri-apps/plugin-fs";
import { appDataDir, join } from "@tauri-apps/api/path";

export interface AppSettings {
  /** Full path to the adb executable, or just "adb" if it is on PATH. */
  adbPath: string;
  /** API key — stored only, not used in this build. */
  apiKey: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export function getDefaultSettings(): AppSettings {
  return { adbPath: "adb", apiKey: "" };
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

export async function saveSettings(settings: AppSettings): Promise<void> {
  const dir = await settingsDirPath();
  const dirExists = await exists(dir);
  if (!dirExists) {
    await mkdir(dir, { recursive: true });
  }
  const filePath = await settingsFilePath();
  await writeTextFile(filePath, JSON.stringify(settings, null, 2));
}
