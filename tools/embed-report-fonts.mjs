/**
 * Inlines IBM Plex into the exported report.
 *
 * The report is a single file that gets emailed, attached to a ticket and
 * archived. If it referenced a webfont it would render in a fallback face for
 * every recipient who has not installed IBM Plex — which is all of them — and
 * the typography that makes it look designed would simply be absent.
 *
 * So the faces are embedded as data URIs at authoring time and baked into
 * src/ui/report.html. Run this after changing the weights shipped in
 * src/styles/fonts:
 *
 *     npm run report:fonts
 *
 * Cost: roughly 300 KB of base64 in a report that is generated per scan. That
 * is a good trade for a document that has to survive being emailed.
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const FONT_DIR = resolve(root, "src/styles/fonts");
const REPORT = resolve(root, "src/ui/report.html");
const MARKER = "/*@PLEX@*/";

/** Only the faces the report actually uses, to keep the payload honest. */
const FACES = [
  { file: "IBMPlexSans-Regular.woff2", family: "IBM Plex Sans", weight: 400 },
  { file: "IBMPlexSans-SemiBold.woff2", family: "IBM Plex Sans", weight: 600 },
  { file: "IBMPlexMono-Regular.woff2", family: "IBM Plex Mono", weight: 400 },
];

async function faceRule({ file, family, weight }) {
  const bytes = await readFile(resolve(FONT_DIR, file));
  return `@font-face {
  font-family: '${family}';
  font-style: normal;
  font-weight: ${weight};
  font-display: swap;
  /* IBM Plex — SIL Open Font License 1.1. See src/styles/fonts/LICENSE-IBM-Plex.txt */
  src: url(data:font/woff2;base64,${bytes.toString("base64")}) format('woff2');
}`;
}

const rules = await Promise.all(FACES.map(faceRule));
const block = `/* IBM Plex, embedded. Regenerate with: npm run report:fonts */\n${rules.join("\n")}`;

const source = await readFile(REPORT, "utf8");
if (!source.includes(MARKER)) {
  console.error(`Marker ${MARKER} not found in ${REPORT} — nothing to do.`);
  process.exit(1);
}

const output = source.replace(MARKER, () => block);
await writeFile(REPORT, output, "utf8");

const kb = (Buffer.byteLength(output) / 1024).toFixed(0);
console.log(`Embedded ${FACES.length} IBM Plex faces into src/ui/report.html (${kb} KB).`);
