import { chromium } from "playwright";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

/*
 * Captures the README's screenshots from the deployed demo.
 *
 * Shot from the live URL rather than a local build on purpose: a screenshot of
 * the deployment is evidence that the deployment works, and it is impossible to
 * accidentally depict a state the published site cannot reach.
 *
 * The report shots come from the report the demo actually exports, not from a
 * hand-written payload. If the demo grades F because its corpus is deliberately
 * broken, the screenshot says F -- the images and the product cannot drift apart.
 * This is not hypothetical: the first run of this script caught the report
 * exporter reading a chain map that the demo path never populated, so the
 * document a judge downloads was missing its headline section while the
 * inspector on screen showed the chain perfectly.
 *
 * Run with `npm run screenshots`. Requires the demo to be deployed.
 */

const LIVE = process.env.ECOTRACE_DEMO_URL ?? "https://theredhacker0345.github.io/Eco-Trace/";
const OUT = "docs/screenshots";
const TMP = process.env.TEMP ?? ".";

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1.5 });

const problems = [];
page.on("pageerror", (e) => problems.push("app: " + e.message));
page.on("response", (r) => {
  if (r.status() >= 400) problems.push(`${r.status()} ${r.url()}`);
});

await page.goto(LIVE, { waitUntil: "networkidle" });
await page.waitForSelector("#findings-body .cx-table__row", { timeout: 30_000 });
await page.waitForTimeout(2500);

const shot = async (name, locator) => {
  const target = locator ? page.locator(locator) : page;
  await target.screenshot({ path: join(OUT, name) });
  console.log(`  ${name.padEnd(26)} ${Math.round(statSync(join(OUT, name)).size / 1024)} KB`);
};

// 1 · The hero. What a judge sees in the first two seconds, so this is the shot
//     that carries the README: the populated workbench with the four-hop causal
//     chain already open, because the demo selects it on load.
await shot("workbench.png");

// 2 · Every finding expanded, offending source visible.
await page.locator("#btn-expand").click().catch(() => {});
await page.waitForTimeout(700);
await shot("findings-expanded.png");

// 3 · The command palette, to show the keyboard-first surface.
await page.locator("#btn-command-palette").click();
await page.waitForTimeout(500);
await page.locator("#palette-input").fill("export");
await page.waitForTimeout(500);
await shot("command-palette.png");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

// 4 · The white theme. Three Carbon themes ship, and a screenshot set showing
//     only one undersells work that took a token map.
//
//     Cycling once from g100 lands on g90, which is still dark -- so this walks
     the cycle until it actually reaches white rather than assuming one press is
//     enough. An earlier run captured g90 and labelled it "light".
async function cycleTheme() {
  await page.evaluate(() => document.getElementById("btn-command-palette")?.click());
  await page.waitForTimeout(350);
  await page.locator("#palette-input").fill("cycle carbon");
  await page.waitForTimeout(350);
  await page.locator("#palette-list [role='option']").first().click();
  await page.waitForTimeout(700);
  return page.evaluate(() => document.documentElement.getAttribute("data-theme"));
}
async function cycleUntil(target) {
  for (let i = 0; i < 4; i++) {
    if ((await page.evaluate(() => document.documentElement.getAttribute("data-theme"))) === target) {
      return true;
    }
    await cycleTheme();
  }
  return false;
}
if (await cycleUntil("white")) {
  await shot("theme-white.png");
} else {
  problems.push("could not reach the white theme");
}
await cycleUntil("g100");

// 5-8 · The exported report, exactly as the demo writes it.
const pending = page.waitForEvent("download", { timeout: 30_000 });
await page.locator("#btn-export").click();
const reportPath = join(TMP, "ecotrace-demo-report.html");
await (await pending).saveAs(reportPath);

const rp = await browser.newPage({ viewport: { width: 1100, height: 1400 }, deviceScaleFactor: 1.5 });
rp.on("pageerror", (e) => problems.push("report: " + e.message));
await rp.goto("file:///" + reportPath.replace(/\\/g, "/"), { waitUntil: "networkidle" });
await rp.waitForTimeout(1200);

await rp.screenshot({ path: join(OUT, "report-masthead.png"), clip: { x: 0, y: 0, width: 1100, height: 1000 } });
console.log("  report-masthead.png");

for (const [name, selector] of [
  ["report-plan.png", "section:has(.plan)"],
  ["report-chain.png", "section:has(.spotlight)"],
  ["report-coverage.png", "section:has(.coverage)"],
]) {
  const el = rp.locator(selector).first();
  // A missing selector means a report section stopped rendering, which is
  // exactly the regression this script exists to catch. Loud, not silent.
  if ((await el.count()) === 0) {
    problems.push(`report section not rendered: ${selector}`);
    continue;
  }
  await el.scrollIntoViewIfNeeded();
  await rp.waitForTimeout(300);
  await el.screenshot({ path: join(OUT, name) });
  console.log(`  ${name.padEnd(26)} ${Math.round(statSync(join(OUT, name)).size / 1024)} KB`);
}

const summary = await rp.evaluate(() => ({
  sections: document.querySelectorAll(".section").length,
  findings: document.querySelectorAll(".finding").length,
  coverage: document.querySelectorAll(".cov").length,
  chainNodes: document.querySelectorAll(".chain__node").length,
}));

console.log("\nreport:", JSON.stringify(summary));
if (summary.chainNodes === 0) {
  problems.push("report rendered no causal chain -- the exporter is reading an empty chain map");
}
if (problems.length) {
  console.error("\nPROBLEMS:\n  " + problems.join("\n  "));
  await browser.close();
  process.exit(1);
}
console.log("no problems found");
await browser.close();
