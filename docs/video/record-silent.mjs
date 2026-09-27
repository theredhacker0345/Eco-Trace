/**
 * EcoTrace demo video — silent studio recording (part 1: camera).
 *
 * Produces docs/video/EcoTrace-demo.mp4: a narration-free, fixed-framerate
 * product video. Recorded frame-by-frame at exactly 30 fps (one screenshot per
 * frame), so motion is glass-smooth and the runtime is deterministic: frames /
 * 30 = seconds, always. No wall-clock sleeps, no dropped encoder frames, no
 * narration to drift. The voiceover is added by the editor afterwards — the
 * STORY timings below double as the voiceover script's section lengths.
 *
 * Story (budgets are narration-length seconds, ~2:54 total):
 *   problem  24s  the why-diagram card
 *   intro    23s  real app: 27 findings, grade F
 *   chain    30s  the 4-hop causal chain, clicked open
 *   fix      25s  remediation + AI-fix panel
 *   bob      21s  how Bob built it + the runtime tier
 *   report   18s  exported HTML report, scrolled
 *   close     8s  links card
 *
 * Run:  npm run video        (needs `npm run build` first, ffmpeg on PATH)
 */

import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const OUT = "docs/video";
const FR = join(OUT, ".frames");
const FILE = join(OUT, "EcoTrace-demo.mp4");
const DIST = resolve("dist");
const PORT = 4180;
const APP = `http://localhost:${PORT}/`;
const FPS = 30;
const W = 1920;
const H = 1080;
const TMP_REPORT = join(FR, "studio-report.html");

// Section lengths in seconds — the editor reads the voiceover against these.
const D = {
  problem: 24,
  intro: 23,
  chain: 30,
  fix: 25,
  bob: 21,
  report: 18,
  close: 8,
};

const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  }
  return (r.stdout || "").trim();
};

// ---------------------------------------------------------------------------
// Camera: every frame is an explicit screenshot, so the timeline is exact.
// ---------------------------------------------------------------------------

let page = null;
let frameCount = 0;

async function shot() {
  const name = join(FR, `f${String(frameCount).padStart(5, "0")}.jpg`);
  await page.screenshot({ path: name, type: "jpeg", quality: 90 });
  frameCount++;
  if (frameCount % 300 === 0) console.log(`  ${frameCount} frames`);
}

const sec = (n) => Math.round(n * FPS);

async function hold(seconds) {
  for (let k = 0; k < sec(seconds); k++) await shot();
}

// --- synthetic cursor: the OS pointer is invisible in screenshots, so the
// camera carries its own — one white dot with a dark ring, animated through
// every move. Cost comes out of the chapter budget, like a real cam.

let cx = 1560;
let cy = 120;

async function cursorMove(x, y) {
  await page.evaluate(
    ([X, Y]) => {
      const el = document.getElementById("camcursor");
      if (el) {
        el.style.left = `${X - 14}px`;
        el.style.top = `${Y - 14}px`;
      }
    },
    [Math.round(x), Math.round(y)]
  );
}

async function cursorShow(on) {
  await page.evaluate((v) => {
    const el = document.getElementById("camcursor");
    if (el) el.style.display = v ? "block" : "none";
  }, on);
}

/** Ease the cursor to a point (smoothstep: still at both ends, ~0.45s). */
async function moveTo(x, y, seconds = 0.45) {
  const steps = Math.max(2, Math.round(seconds * FPS));
  const sx = cx;
  const sy = cy;
  for (let k = 1; k <= steps; k++) {
    const t = k / steps;
    const e = t * t * (3 - 2 * t);
    cx = sx + (x - sx) * e;
    cy = sy + (y - sy) * e;
    await cursorMove(cx, cy);
    await shot();
  }
  cx = x;
  cy = y;
  await cursorMove(x, y);
  await shot();
}

async function clickAt(x, y) {
  await cursorShow(false);
  await page.mouse.click(x, y);
  await cursorShow(true);
  await shot();
}

async function hoverClick(selector) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error("no box for " + selector);
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  await moveTo(x, y);
  await clickAt(x, y);
  cx = x;
  cy = y;
}

/** Smooth stepped scroll; a jump-cut scroll reads as a glitch on video. */
async function scrollBy(dy, seconds = 0.7) {
  const steps = Math.max(2, Math.round(seconds * FPS));
  for (let k = 0; k < steps; k++) {
    await page.mouse.wheel(0, dy / steps);
    await shot();
  }
}

/** Re-install the cursor layer + hide the native pointer in a fresh document. */
async function cursorOn() {
  await page.addStyleTag({ content: "*{cursor:none!important}" });
  await page.evaluate(() => {
    if (document.getElementById("camcursor")) return;
    const d = document.createElement("div");
    d.id = "camcursor";
    d.innerHTML = `<svg width="28" height="28" viewBox="0 0 28 28"><circle cx="14" cy="14" r="10" fill="rgba(255,255,255,.92)"/><circle cx="14" cy="14" r="10" fill="none" stroke="#111" stroke-width="2.5"/></svg>`;
    d.style.cssText =
      "position:fixed;left:0;top:0;width:28px;height:28px;" +
      "z-index:2147483647;pointer-events:none;";
    (document.body || document.documentElement).appendChild(d);
  });
  await cursorMove(cx, cy);
}

/** Chapter guard: pad short, shout if long (a long chapter breaks the voice). */
async function chapter(name, seconds, fn) {
  const start = frameCount;
  await fn();
  const want = sec(seconds);
  const got = frameCount - start;
  if (got < want) await hold(seconds - got / FPS);
  else if (got > want + 2)
    console.log(`  !! ${name} over budget by ${((got - want) / FPS).toFixed(1)}s`);
  console.log(`  ${name}: ${((frameCount - start) / FPS).toFixed(1)}s`);
}

// ---------------------------------------------------------------------------
// Title cards as inline HTML, shot in the same session.
// ---------------------------------------------------------------------------

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: ${W}px; height: ${H}px; overflow: hidden;
    display: flex; flex-direction: column; justify-content: center;
    padding: 0 110px; gap: 44px;
    background: #161616; color: #f4f4f4;
    font: 400 21px/1.5 "Segoe UI", system-ui, sans-serif;
  }
  .eyebrow { display: flex; align-items: center; gap: 14px; color: #78a9ff;
    font: 600 17px/1 "Segoe UI", sans-serif; letter-spacing: .16em; text-transform: uppercase; }
  .eyebrow svg { width: 22px; height: 22px; fill: #78a9ff; }
  h1 { font: 600 60px/1.14 "Segoe UI", sans-serif; letter-spacing: -.02em; }
  h1 em { font-style: normal; color: #42be65; }
  h2 { font: 600 33px/1.2 "Segoe UI", sans-serif; }
  pre { background: #262626; border-left: 3px solid #f1c21b; padding: 26px 30px;
    font: 400 20px/1.7 Consolas, "Cascadia Mono", monospace; color: #c6c6c6; white-space: pre; }
  pre b { color: #ff8389; font-weight: 600; }
  pre i { color: #42be65; font-style: normal; }
  .cols { display: grid; grid-template-columns: 1.02fr .98fr; gap: 54px; align-items: start; }
  ul { list-style: none; display: flex; flex-direction: column; gap: 19px; }
  li { display: grid; grid-template-columns: 28px 1fr; gap: 15px; align-items: start; }
  li svg { width: 22px; height: 22px; fill: #42be65; margin-top: 5px; }
  li b { color: #fff; font-weight: 600; }
  li span { color: #a8a8a8; }
  code { font-family: Consolas, monospace; color: #78a9ff; }
  .foot { position: fixed; left: 110px; bottom: 60px; color: #6f6f6f; font-size: 18px; letter-spacing: .05em; }
`;

const CHECK = `<svg viewBox="0 0 16 16"><path d="M6.5 11.2 3.3 8l-1 1 4.2 4.2 8.5-8.5-1-1z"/></svg>`;
const BOLT = `<svg viewBox="0 0 16 16"><path d="M9 0 2 9h4l-1 7 7-9H8z"/></svg>`;

const CARD_PROBLEM = `<!doctype html><meta charset="utf-8"><style>${CSS}</style>
<div class="eyebrow">${BOLT}Android energy intelligence &middot; IBM Bob 2.0 hackathon</div>
<h1>Every battery tool tells you <em>what</em> drains.<br>EcoTrace tells you <em>why</em>.</h1>
<div class="cols">
  <pre>MainActivity.onCreate()
  <b>AlarmManager.setRepeating()</b>   &lt;- wakes the device 96x/day
    SyncScheduler.scheduleImmediate()
      SyncService.onStartCommand()
        SyncEngine.startSyncCycle()
          UserRepository.syncUserProfile()
            <i>NetworkManager.fetchUserProfile()  &lt;- WakeLock never released</i></pre>
  <ul>
    <li>${CHECK}<div><b>One finding is one line.</b><br><span>A linter stops at the leaked wakelock, four hops from the decision that caused it.</span></div></li>
    <li>${CHECK}<div><b>The cause is architectural.</b><br><span>An alarm chosen over WorkManager, re-arming the whole path all day.</span></div></li>
    <li>${CHECK}<div><b>So EcoTrace traces it.</b><br><span>A real cross-file call graph, walked backwards to the lifecycle entry point.</span></div></li>
  </ul>
</div>
<div class="foot">EcoTrace &middot; Android Energy Intelligence Platform</div>`;

const CARD_BOB = `<!doctype html><meta charset="utf-8"><style>${CSS}</style>
<div class="eyebrow">${BOLT}How IBM Bob 2.0 was used</div>
<div class="cols">
  <ul>
    <li>${CHECK}<div><b>Bob built it.</b><br><span>Seven recorded sessions in <code>bob_sessions/</code> produced the 23 detectors, the call-graph tracer, the <code>dumpsys</code> parser and this interface.</span></div></li>
    <li>${CHECK}<div><b>Bob reasons over the whole repository.</b><br><span>One pass holds every file at once: it revises severities and writes a fix against the exact chain.</span></div></li>
    <li>${CHECK}<div><b>Bob's patch is verified, not trusted.</b><br><span>The detectors re-run over the patched file; a patch that hides a defect is rejected.</span></div></li>
    <li>${CHECK}<div><b>Bob is optional by design.</b><br><span>Detectors, chains, grade and report all work with no key. A tool that dies without a paid key is a demo.</span></div></li>
  </ul>
  <pre>src/bob/client.ts
  timeout + backoff + jitter
  Retry-After honoured
  401 / 429 / 5xx told apart
  token + cost accounting

src/bob/aifix.ts
  <i>propose</i> &rarr; <i>verify</i> &rarr; <i>branch</i>
  one file, cited lines
  never straight to main</pre>
</div>
<div class="foot">Built with IBM Bob 2.0 &middot; <code>github.com/theredhacker0345/Eco-Trace</code></div>`;

const CARD_CLOSE = `<!doctype html><meta charset="utf-8"><style>${CSS}</style>
<div class="eyebrow">${BOLT}EcoTrace</div>
<h1>Find what drains the battery.<br><em>And why it happens.</em></h1>
<div class="cols">
  <ul>
    <li>${CHECK}<div><b>23 detectors</b><span> &middot; Java and Kotlin, local, instant</span></div></li>
    <li>${CHECK}<div><b>Causal chains</b><span> &middot; cross-file, back to the lifecycle root</span></div></li>
    <li>${CHECK}<div><b>Measured drain</b><span> &middot; from <code>dumpsys batterystats</code></span></div></li>
    <li>${CHECK}<div><b>IBM Bob 2.0</b><span> &middot; second-tier reasoning, verified fixes</span></div></li>
  </ul>
  <div>
    <h2>Try it now</h2>
    <p style="color:#a8a8a8;margin-top:12px">Live demo, no install, real analysis</p>
    <p style="font:600 26px/1.5 Consolas,monospace;color:#78a9ff;margin-top:8px">theredhacker0345.github.io/Eco-Trace</p>
    <p style="color:#a8a8a8;margin-top:24px">Windows installer and source</p>
    <p style="font:600 26px/1.5 Consolas,monospace;color:#78a9ff;margin-top:8px">github.com/theredhacker0345/Eco-Trace</p>
  </div>
</div>`;


// ---------------------------------------------------------------------------
// Static server + the take + the encode.
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function serveDist() {
  return new Promise((ok) => {
    const server = createServer((req, res) => {
      let path = decodeURIComponent((req.url || "/").split("?")[0]);
      if (path === "/") path = "/index.html";
      const file = join(DIST, path);
      if (!existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    });
    server.listen(PORT, () => ok(server));
  });
}

async function main() {
  mkdirSync(FR, { recursive: true });
  rmSync(FR, { recursive: true, force: true });
  mkdirSync(FR, { recursive: true });

  const server = await serveDist();
  const browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
  });
  page = await context.newPage();
  page.setDefaultTimeout(8000);

  await chapter("problem", D.problem, async () => {
    await page.setContent(CARD_PROBLEM, { waitUntil: "load" });
    await cursorOn();
    await hold(D.problem);
  });

  await chapter("intro", D.intro, async () => {
    await page.goto(APP, { waitUntil: "domcontentloaded" });
    await cursorOn();
    await page.waitForSelector("#findings-body .cx-table__row", { timeout: 30000 });
    if ((await page.getAttribute("#landing", "data-open")) !== "false") {
      await page.keyboard.press("Escape");
    }
    await hold(6);
    await hoverClick("#findings-body .cx-table__row");
    await hold(5);
    await moveTo(300, 540);
    await hold(4);
  });

  await chapter("chain", D.chain, async () => {
    await hoverClick("#tab-chain");
    await hold(7);
    const hops = page.locator("#chain-tree > li");
    const n = Math.min(await hops.count(), 4);
    for (let k = 0; k < n; k++) {
      await moveTo(640, 520 + k * 64, 0.7);
      await hold(2.5);
    }
    await moveTo(960, 900, 0.7);
    await hold(5);
  });

  await chapter("fix", D.fix, async () => {
    await hoverClick("#tab-fix");
    await hold(7);
    await hoverClick("#tab-aifix");
    await hold(9);
    await hoverClick("#tab-overview");
  });

  await chapter("bob", D.bob, async () => {
    await page.setContent(CARD_BOB, { waitUntil: "load" });
    await cursorOn();
    await moveTo(1480, 900, 0.6);
    await hold(D.bob - 0.7);
  });

  await chapter("report", D.report, async () => {
    // No click survives navigation, so the report is written straight from its
    // two ingredients — the payload the workbench just built in this take is
    // unavailable here, hence today's numbers would be stale. Instead: click
    // Export in the app (a real download through the same code path a judge
    // clicks), then open the file it saved.
    await page.goto(APP, { waitUntil: "domcontentloaded" });
    await cursorOn();
    await page.waitForSelector("#findings-body .cx-table__row", { timeout: 30000 });
    if ((await page.getAttribute("#landing", "data-open")) !== "false") {
      await page.keyboard.press("Escape");
    }
    const download = page.waitForEvent("download", { timeout: 30000 });
    await hoverClick("#btn-export");
    await (await download).saveAs(TMP_REPORT);
    await page.goto("file:///" + resolve(TMP_REPORT).replace(/\\/g, "/"), {
      waitUntil: "domcontentloaded",
    });
    await cursorOn();
    await hold(3);
    await scrollBy(900);
    await hold(4);
    await scrollBy(1100);
    await hold(3);
  });

  await chapter("close", D.close, async () => {
    await page.setContent(CARD_CLOSE, { waitUntil: "load" });
    await cursorOn();
    await hold(D.close);
  });

  await context.close();
  await browser.close();
  server.close();

  const total = frameCount / FPS;
  console.log(`\n${frameCount} frames = ${total.toFixed(1)}s`);
  if (total > 179)
    throw new Error(`video is ${total.toFixed(0)}s — over the 3 minute cap, trim the story`);

  sh("ffmpeg", [
    "-y",
    "-framerate", String(FPS),
    "-i", join(FR, "f%05d.jpg"),
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "19",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    FILE,
  ]);

  const mb = statSync(FILE).size / 1024 / 1024;
  console.log(`${FILE}  ${mb.toFixed(1)} MB  ${total.toFixed(1)}s — silent master, no narration`);
}

await main();

