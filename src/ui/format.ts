/**
 * Path, text and number formatting.
 *
 * All path presentation goes through here so the same absolute path always
 * renders identically in the navigator, the table, the inspector and the log.
 * A reviewer comparing a table row to a tree node should not have to decode
 * two different renderings of the same file.
 */

const SEP = /[\\/]/;

export function fileName(absPath: string): string {
  const parts = absPath.split(SEP).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : absPath;
}

export function fileDir(absPath: string): string {
  const parts = absPath.split(SEP).filter(Boolean);
  return parts.slice(0, -1).join("/") || ".";
}

export function fileExt(absPath: string): string {
  const name = fileName(absPath);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1) : "";
}

/** Project-relative path, used everywhere a path is shown to the user. */
export function relPath(absPath: string, projectPath: string | null): string {
  if (!projectPath) return absPath;
  const root = projectPath.replace(/[\\/]+$/, "");
  if (absPath === root) return fileName(absPath);
  const prefix = root + "/";
  const altPrefix = root + "\\";
  if (absPath.startsWith(prefix)) return absPath.slice(prefix.length);
  if (absPath.startsWith(altPrefix)) return absPath.slice(altPrefix.length);
  return absPath;
}

export function pathDir(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx > 0 ? rel.slice(0, idx) : "";
}

export function baseName(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx >= 0 ? rel.slice(idx + 1) : rel;
}

export function locationLabel(
  absPath: string,
  line: number,
  projectPath: string | null
): string {
  return `${relPath(absPath, projectPath)}:${line}`;
}

export function clockTime(when = new Date()): string {
  return when.toLocaleTimeString("en-GB", { hour12: false });
}

export function shortDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function dateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** Case-insensitive subsequence match, for command-palette style filtering. */
export function fuzzyMatch(haystack: string, needle: string): boolean {
  if (!needle) return true;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  let i = 0;
  for (const ch of n) {
    if (ch === " ") continue;
    const found = h.indexOf(ch, i);
    if (found === -1) return false;
    i = found + 1;
  }
  return true;
}

/** "apple" from "src/main/java/com/demo/apple/Foo.kt" — the folder above the file. */
export function packageOf(absPath: string, projectPath: string | null): string {
  const rel = relPath(absPath, projectPath);
  const dir = pathDir(rel);
  const parts = dir.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "root";
}
