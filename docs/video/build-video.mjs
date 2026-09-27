/**
 * EcoTrace demo video — build script.
 *
 * Produces docs/video/EcoTrace-demo.mp4 from nothing but this repository:
 *
 *   narration   Windows' own speech synthesiser (System.Speech), one WAV per
 *               section, so the voice is offline and free. Nothing here calls a
 *               paid service to make the video.
 *   picture     Playwright drives the real built app and records it. The same
 *               analyzer, the same report, the same UI a judge will click.
 *   assembly    ffmpeg muxes them, and each section's length is *measured* from
 *               its narration rather than guessed, so the picture changes when
 *               the voice says it does.
 *
 * That last point is why this is a script and not a screen recording: after a UI
 * change the video is one command, and the timings cannot drift out of sync.
 *
 * Run:  npm run video        (needs `npm run build` first, ffmpeg on PATH)
 */

import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const OUT = "docs/video";
const TMP = join(OUT, ".tmp");
const DIST = resolve("dist");
const PORT = 4180;
const FPS = 30;
const SIZE = { width: 1920, height: 1080 };

const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stderr || r.stdout}`);
  }
  return (r.stdout || "").trim();
};

/** Duration of a media file, in seconds. */
const duration = (file) =>
  Number(
    sh("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1",
      file,
    ])
  );

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 1 · The narration
//
// Written to be read aloud: short sentences, no parentheses, numbers spelled the
// way a person says them. Each section's length comes back from the synthesiser,
// so this text is the video's edit decision list.
// ---------------------------------------------------------------------------

const SCRIPT = [
  {
    id: "problem",
    voice:
      "Android battery tools tell you what is draining the battery. " +
      "None of them tell you why. " +
      "Why means understanding how one architectural decision, a repeating alarm in MainActivity, " +
      "propagates through six layers of your code to become a drain you can measure on a device. " +
      "That is not pattern matching. That is reasoning. " +
      "EcoTrace exists to do it.",
  },
  {
    id: "intro",
    voice:
      "This is EcoTrace, an Android energy intelligence platform built with IBM Bob 2.0. " +
      "It runs twenty three energy detectors over Java and Kotlin sources, then traces each finding back through the call graph. " +
      "This is the hosted demo, and the analysis is real: the same detectors and the same grader as the desktop build, " +
      "over a sample project with planted defects. Twenty seven findings, seventeen files, grade F.",
  },
  {
    id: "chain",
    voice:
      "Here is the part a linter cannot do. " +
      "EcoTrace builds a cross file call graph and walks backwards from every finding to the lifecycle method that caused it. " +
      "This chain is four hops deep. " +
      "The leaked wakelock is in NetworkManager, deep in the code. " +
      "But the root cause is in MainActivity, where a wakeup alarm re arms this path ninety six times a day. " +
      "The finding is the symptom. The alarm is the cause. And this is local, deterministic, and free.",
  },
  {
    id: "fix",
    voice:
      "Every finding carries a fix written for that chain, and a patch note for your review. " +
      "Now IBM Bob. With a key configured, the AI fix panel asks Bob to propose a patch for the selected finding. " +
      "Bob's patch is then re checked by the detectors before you see an apply button, " +
      "and an accepted change lands on a branch for a human to merge. Never straight to main.",
  },
  {
    id: "bobCard",
    voice:
      "So where exactly did Bob help? " +
      "Bob built this. Seven recorded sessions produced the detector set, the call graph tracer, " +
      "the batterystats parser and this interface. " +
      "Bob is also the second analysis tier inside the product: it holds the whole repository in one reasoning pass, " +
      "so it can revise a severity and write a fix against that exact chain. " +
      "The local tier always works. Bob makes it sharper.",
  },
  {
    id: "report",
    voice:
      "Finally, the report. " +
      "A self contained HTML or PDF with every finding, every chain, every fix, " +
      "the measured drain when a device is attached, and a coverage matrix of what was checked and found clean. " +
      "EcoTrace. Find what drains the battery, and why it happens.",
  },
];


// ---------------------------------------------------------------------------
// 2 · Synthesis — one WAV per section, with the voice picked for readability
// ---------------------------------------------------------------------------

async function synthesise() {
  mkdirSync(TMP, { recursive: true });
  // Awaited: PowerShell is handed these paths on the next line, and an
  // unflushed write is a "file is being used by another process" error.
  for (const s of SCRIPT) await writeFile(join(TMP, `${s.id}.txt`), s.voice, "utf8");

  // A male US English voice reads technical prose more clearly than the
  // default where both exist; the filter picks one if installed and falls back
  // to whatever the machine has, so this never fails on a machine without that
  // voice pack.
  const ps = [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$names = $s.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }",
    "$pick = $names | Where-Object { $_ -match 'Guy|Davis|Andrew|Christopher|Eric|Mark|David' } | Select-Object -First 1",
    "if (-not $pick) { $pick = $names | Select-Object -First 1 }",
    "$s.SelectVoice($pick)",
    "$s.Rate = 1",
    "$s.Volume = 100",
    'Write-Output "voice: $pick"',
    ...SCRIPT.map(
      (s) =>
        `$s.SetOutputToWaveFile('${join(TMP, `${s.id}.wav`)}')\n` +
        `$s.Speak([System.IO.File]::ReadAllText('${join(TMP, `${s.id}.txt`)}'))\n` +
        "$s.SetOutputToWaveFile($null)"
    ),
  ].join("\n");

  await writeFile(join(TMP, "speak.ps1"), ps, "utf8");
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(TMP, "speak.ps1")],
    { encoding: "utf8" }
  );
  if (r.status !== 0) throw new Error("synthesis failed:\n" + (r.stderr || r.stdout));
  console.log(r.stdout.trim());
}

// ---------------------------------------------------------------------------
// 3 · Cards — shown in the same recording, so there is one video and one clock
// ---------------------------------------------------------------------------

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: ${SIZE.width}px; height: ${SIZE.height}px; overflow: hidden;
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
    <li>${CHECK}<div><b>Bob reasons over the whole repository.</b><br><span>One pass holds every file at once, so it can revise a severity, correct a description, and write a fix against the exact chain.</span></div></li>
    <li>${CHECK}<div><b>Bob's patch is verified, not trusted.</b><br><span>The detectors re-run over the patched file; a patch that silences a rule by deleting the construct is rejected.</span></div></li>
    <li>${CHECK}<div><b>Bob is optional by design.</b><br><span>Detectors, chains, grade, history and report all work with no key. A tool that dies without a paid key is a demo, not a product.</span></div></li>
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
// 4 · A one-file static server for dist/
//
// The recorder must load the *built* app, and adding a dev-server dependency for
// that would be silly. Forty lines, no framework, and the video shows the exact
// artefact the deploy workflow publishes.
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

// ---------------------------------------------------------------------------
// 5 · Record
//
// One continuous take: cards and the real app in the same session, so there is a
// single clock and nothing can drift apart. Every hold is derived from the
// measured narration, which is what keeps the picture agreeing with the voice.
// ---------------------------------------------------------------------------

const CLOSE_HOLD = 8;

async function record() {
  const d = Object.fromEntries(
    SCRIPT.map((s) => [s.id, duration(join(TMP, `${s.id}.wav`))])
  );
  const speech = Object.values(d).reduce((a, b) => a + b, 0);
  const total = speech + CLOSE_HOLD;
  console.log(Object.entries(d).map(([k, v]) => `${k} ${v.toFixed(1)}s`).join("  |  "));
  console.log(`narration ${speech.toFixed(1)}s + ${CLOSE_HOLD}s card = ${total.toFixed(1)}s`);
  if (total > 178) throw new Error(`video would be ${total.toFixed(0)}s — over the 3 minute cap`);

  const server = await serveDist();
  const browser = await chromium.launch({ channel: "chrome" });
  const context = await browser.newContext({
    viewport: SIZE,
    deviceScaleFactor: 1,
    recordVideo: { dir: TMP, size: SIZE },
  });
  const page = await context.newPage();

  // `mark()` starts a section; `hold(n)` pads it to exactly n seconds.
  let t = Date.now();
  const mark = () => {
    t = Date.now();
  };
  const hold = async (seconds) => {
    const left = seconds - (Date.now() - t) / 1000;
    if (left > 0) await sleep(left * 1000);
  };

  await page.setContent(CARD_PROBLEM, { waitUntil: "load" });
  await sleep(d.problem * 1000);

  mark();
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#findings-body .cx-table__row", { timeout: 30000 });
  // The demo mount dismisses the landing overlay; a key press makes certain of
  // it on a slow first paint.
  if ((await page.getAttribute("#landing", "data-open")) !== "false") {
    await page.keyboard.press("Escape");
  }
  await page.locator("#findings-body .cx-table__row").first().click();
  await hold(d.intro);

  mark();
  await page.click("#tab-chain");
  await sleep(1600);
  await page.mouse.wheel(0, 260);
  await sleep(900);
  await hold(d.chain);

  mark();
  await page.click("#tab-fix");
  await sleep(1500);
  // The AI-fix panel is the Bob surface inside the product: what it does, and
  // that a patch is verified before it can be applied. Settings, where the Bob
  // key is entered, is disabled on the hosted build on purpose — it persists to
  // disk, and a browser has no disk — so the Bob card carries that half.
  await page.click("#tab-aifix");
  await sleep(2600);
  await page.click("#tab-overview");
  await hold(d.fix);

  await page.setContent(CARD_BOB, { waitUntil: "load" });
  await sleep(d.bobCard * 1000);

  mark();
  const download = page.waitForEvent("download", { timeout: 30000 });
  await page.click("#btn-export");
  const report = join(TMP, "report.html");
  await (await download).saveAs(report);
  await page.goto("file:///" + report.replace(/\\/g, "/"), { waitUntil: "load" });
  await sleep(2200);
  await page.evaluate(() => window.scrollTo(0, 1400));
  await sleep(1800);
  await page.evaluate(() => window.scrollTo(0, 3600));
  await hold(d.report);

  await page.setContent(CARD_CLOSE, { waitUntil: "load" });
  await sleep(CLOSE_HOLD * 1000);

  // The video is only written when the context closes, so grab the handle now
  // and resolve its path afterwards — awaiting it here would deadlock.
  const video = page.video();
  await context.close();
  await browser.close();
  server.close();
  return { video: await video.path() };
}

// ---------------------------------------------------------------------------
// 6 · Mux
// ---------------------------------------------------------------------------

function narrate() {
  const list = join(TMP, "audio.txt");
  writeFileSync(
    list,
    SCRIPT.map((s) => `file '${join(TMP, `${s.id}.wav`).replace(/\\/g, "/")}'`).join("\n"),
    "utf8"
  );
  // Every WAV comes from the same synthesiser, so the concat demuxer is safe and
  // there is no re-encode to soften.
  sh("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, join(TMP, "narration.wav")]);
  return join(TMP, "narration.wav");
}

// ---------------------------------------------------------------------------

await synthesise();
const { video } = await record();
const narration = narrate();

const out = join(OUT, "EcoTrace-demo.mp4");
sh("ffmpeg", [
  "-y",
  "-i", video,
  "-i", narration,
  "-filter_complex", `[0:v]scale=${SIZE.width}:${SIZE.height},fps=${FPS},format=yuv420p[v]`,
  "-map", "[v]",
  "-map", "1:a",
  "-c:v", "libx264",
  "-preset", "medium",
  "-crf", "20",
  "-pix_fmt", "yuv420p",
  "-c:a", "aac",
  "-b:a", "160k",
  "-movflags", "+faststart",
  out,
]);

console.log(`\n${out}  ${(statSync(out).size / 1024 / 1024).toFixed(1)} MB  ${duration(out).toFixed(1)}s`);

