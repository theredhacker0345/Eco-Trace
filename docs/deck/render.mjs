import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

// Renders docs/deck/deck.html to a 16:9 PDF and a 16:9 cover PNG.
// IBM Plex is referenced but not embedded; the renderer resolves it from the
// system-installed face, which is present on this machine, and falls back
// gracefully to the metric-compatible sans stack otherwise.
const DECK = 'C:/Users/urooj/Videos/eco trace/docs/deck/deck.html';
const OUT_PDF = 'C:/Users/urooj/Videos/eco trace/docs/deck/EcoTrace-pitch-deck.pdf';
const OUT_PNG = 'C:/Users/urooj/Videos/eco trace/assets/cover.png';

const html = readFileSync(DECK, 'utf8');

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 });
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.setContent(html, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);

const slides = await page.locator('.slide').count();

// Deck PDF: exact 16:9 page, no margins, background printed.
await page.pdf({
  path: OUT_PDF,
  width: '338.7mm',
  height: '190.5mm',
  printBackground: true,
  margin: { top: 0, right: 0, bottom: 0, left: 0 },
  pageRanges: `1-${slides}`,
});

// Cover: 16:9 PNG from the title slide.
const first = page.locator('.slide').first();
await first.screenshot({ path: OUT_PNG, type: 'png' });

// Overflow check: a slide whose content exceeds its box silently crops in a
// PDF, which is how decks lose their last bullet.
const overflow = await page.evaluate(() =>
  [...document.querySelectorAll('.slide')]
    .map((s, i) => ({ n: i + 1, over: s.scrollHeight - s.clientHeight }))
    .filter((x) => x.over > 1)
);

console.log(JSON.stringify({ slides, errors: errs, overflowing: overflow }, null, 2));
await browser.close();
