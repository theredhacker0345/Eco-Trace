import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * DOM contract check — every element id the TypeScript asks for must exist in
 * index.html.
 *
 * This exists because of a real outage: a cleanup commit deleted
 * `#btn-copy-fix` from index.html but left its wiring in src/ui/inspector.ts.
 * `qs()` throws on a missing id, so that one stale reference aborted
 * initInspector() and every listener registered after it. The hosted build
 * appeared to have no working buttons at all — no console warning about which
 * one, just a dead page. TypeScript cannot catch this: the id is a string.
 *
 * Running it against the source is enough, because the app only ever queries
 * its own shell (the exported report has its own template and its own ids, and
 * is rendered from src/ui/report.html, which is checked separately by nobody
 * yet — the report's anchors are asserted in src/report/export.ts at runtime).
 *
 * Run by `npm run dom:check`, and by CI on every push.
 */

const idsInHtml = (html) =>
  new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

const shellIds = idsInHtml(readFileSync("index.html", "utf8"));

const sources = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".ts")) sources.push(p);
  }
};
walk("src");

/**
 * Ids the app asks for, with file:line. Covers the three helpers in ui/dom.ts
 * and the raw DOM API, which is what the helpers wrap.
 *
 * A reference followed by `?.` is optional by construction — the code is
 * saying "this element may not be in the markup" (the landing overlay has no
 * close button, on purpose). Those are counted but not enforced: the whole
 * point of optional chaining is that absence is handled.
 */
const patterns = [
  /\b(?:qs|qsButton|qsInput)(?:<[^>]*>)?\(\s*[`"']([^`"'$]+)[`"']\s*\)/g,
  /getElementById(?:<[^>]*>)?\(\s*[`"']([^`"'$]+)[`"']\s*\)/g,
];

const missing = [];
let asked = 0;
let optional = 0;

for (const file of sources) {
  const text = readFileSync(file, "utf8");
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const id = m[1];
      // A template literal that is not a plain id (interpolated, or built at
      // runtime) is not a contract we can check statically.
      if (id.includes("${")) continue;
      // Optional chaining — possibly across a line break, as in
      // `getElementById("x")\n  ?.addEventListener(...)` — means the code
      // already handles absence, so this is a preference, not a contract.
      if (/^\s*\?\./.test(text.slice(re.lastIndex, re.lastIndex + 12))) {
        optional++;
        continue;
      }
      asked++;
      if (shellIds.has(id)) continue;
      const line = text.slice(0, m.index).split(/\r?\n/).length;
      missing.push({ id, at: `${file}:${line}` });
    }
  }
}

console.log(`ids in index.html: ${shellIds.size}`);
console.log(`contract references checked: ${asked}`);
if (optional > 0) console.log(`optional (guarded with ?.): ${optional}`);

if (missing.length === 0) {
  console.log("dom contract check passed — every id the code asks for exists");
  process.exit(0);
}

const byId = new Map();
for (const { id, at } of missing) {
  if (!byId.has(id)) byId.set(id, []);
  byId.get(id).push(at);
}
console.error(`\n${byId.size} id(s) referenced but missing from index.html:`);
for (const [id, at] of byId) console.error(`  #${id}  <-  ${at.join(", ")}`);
console.error(
  "\nAn app that cannot find an element throws during init, which stops every\n" +
    "listener registered after it. Fix the id or the markup — do not remove the check."
);
process.exit(1);
