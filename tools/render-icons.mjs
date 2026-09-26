import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * Renders the EcoTrace icon to every size the app and the web need.
 *
 * Run with `npm run icons`. It writes:
 *   - src-tauri/icons/icon-source.png   the 1024 master, which `tauri icon`
 *                                        fans out to the platform sizes
 *   - public/favicon.svg + .png         the browser tab icon
 *   - public/apple-touch-icon.png       iOS home screen
 *   - public/icon-192/512.png           PWA / manifest sizes
 *
 * Kept as a script rather than committed binaries alone so the mark can be
 * changed in one place: the app header, the report masthead, the pitch deck and
 * the favicon all render the same path.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_HTML = join(ROOT, 'assets', 'icon-source.html');

const browser = await chromium.launch({ channel: 'chrome' });

async function render(size, outPath, { transparent = false } = {}) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
    deviceScaleFactor: 1,
  });
  await page.setContent(readFileSync(SOURCE_HTML, 'utf8'), { waitUntil: 'networkidle' });
  await page.addStyleTag({
    content: `.icon { width: ${size}px; height: ${size}px; }`,
  });
  if (transparent) {
    // The plate already fills the canvas, so transparency means removing the
    // page background Chrome paints behind an SVG document.
    await page.addStyleTag({ content: 'html, body { background: transparent !important; }' });
  }
  await page.waitForTimeout(120);
  mkdirSync(dirname(outPath), { recursive: true });
  await page.locator('.icon').screenshot({ path: outPath, omitBackground: transparent });
  await page.close();
  return outPath;
}

const targets = [
  [1024, join(ROOT, 'src-tauri', 'icons', 'icon-source.png'), {}],
  [512, join(ROOT, 'public', 'icon-512.png'), {}],
  [192, join(ROOT, 'public', 'icon-192.png'), {}],
  [180, join(ROOT, 'public', 'apple-touch-icon.png'), {}],
  [64, join(ROOT, 'public', 'favicon.png'), {}],
  [32, join(ROOT, 'public', 'favicon-32.png'), {}],
];

for (const [size, path, opts] of targets) {
  await render(size, path, opts);
  console.log('wrote', path.replace(ROOT, ''));
}

// The scalable favicon: a copy of the source markup, so the tab icon is
// resolution-independent and weighs a few hundred bytes.
const svg = readFileSync(SOURCE_HTML, 'utf8').match(/<svg[\s\S]*?<\/svg>/)[0]
  .replace('class="icon"', 'width="16" height="16"')
  .replace('viewBox="0 0 16 16"', 'viewBox="0 0 16 16"');
writeFileSync(join(ROOT, 'public', 'favicon.svg'), svg + '\n', 'utf8');
console.log('wrote public/favicon.svg');

await browser.close();
