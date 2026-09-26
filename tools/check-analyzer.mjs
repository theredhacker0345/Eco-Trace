import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/*
 * Analyzer precision check.
 *
 * Three questions, in order of how easy it is to get them wrong:
 *
 *   1. Does every rule the corpus documents still fire? (recall — the detections
 *      a precision change must not lose)
 *   2. Does a file documented as clean stay silent? (precision)
 *   3. Do a set of correct, idiomatic patterns produce *no* finding? (the false
 *      positives that prompted this file: an import counted as a use, a
 *      permission check counted as a location request, an XML namespace counted
 *      as a cleartext endpoint, `stopSelf(startId)` counted as never stopping)
 *
 * Runs the real analyzer, imported from its source and transpiled with the
 * TypeScript that already builds the app — not a copy, and not a stub. Run by
 * `npm run analyzer:check`, and by CI on every push.
 */

function loadAnalyzer() {
  const source = readFileSync("src/analyzer/static.ts", "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const exports = {};
  new Function("exports", outputText)(exports);
  return exports;
}

const { analyzeProject } = loadAnalyzer();

/** Loads every Java/Kotlin source in a directory as analyzer input. */
function loadCorpus(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".java") || name.endsWith(".kt"))
    .sort()
    .map((name) => ({
      path: join(dir, name),
      content: readFileSync(join(dir, name), "utf8"),
      language: name.endsWith(".kt") ? "kotlin" : "java",
    }));
}

const failures = [];

function report(ok, label, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

const ruleOf = (f) => f.patternId;
const fileOf = (f) => f.file.replace(/\\/g, "/").split("/").pop();
const pairs = (findings) =>
  new Set(findings.map((f) => `${f.patternId} ${fileOf(f)}`));

// ---------------------------------------------------------------------------
// 1 + 2 · The demo corpus, against the table its README publishes
// ---------------------------------------------------------------------------

const CORPUS = "src/demo-project";
const readme = readFileSync(join(CORPUS, "README.md"), "utf8");

/** Rows of the "what is planted" table: `| \`File.java\` | prose | W04, A01 |`. */
const planted = [];
for (const line of readme.split(/\r?\n/)) {
  const m = line.match(/^\|\s*`([^`]+)`\s*\|(.+?)\|\s*([WNLA]\d{2}(?:\s*,\s*[WNLA]\d{2})*)\s*\|$/);
  if (!m) continue;
  planted.push({ file: m[1], rules: m[3].split(",").map((r) => r.trim()) });
}

/** Names in the paragraph that declares which files contain nothing. */
const cleanFiles = (() => {
  const lines = readme.split(/\r?\n/);
  const at = lines.findIndex((l) => /contain no/i.test(l));
  if (at === -1) return [];
  const block = lines.slice(Math.max(0, at - 2), at + 1).join(" ");
  return [...block.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
})();

const corpusFindings = analyzeProject(loadCorpus(CORPUS));
const corpusPairs = pairs(corpusFindings);

console.log(`\n${CORPUS} — ${corpusFindings.length} findings`);
for (const f of corpusFindings) {
  console.log(`    ${f.patternId.padEnd(4)} ${f.severity.padEnd(8)} ${fileOf(f)}:${f.line}`);
}

console.log("\ndocumented rules");
for (const { file, rules } of planted) {
  for (const rule of rules) {
    report(corpusPairs.has(`${rule} ${file}`), `${rule} in ${file}`);
  }
}

// The table is the corpus's contract, not a summary of it: a rule that fires
// and is not listed means the documentation is behind the detector, which is
// how the table drifted from the code in the first place.
console.log("\ntable completeness");
for (const { file, rules } of planted) {
  const actual = [
    ...new Set(corpusFindings.filter((f) => fileOf(f) === file).map(ruleOf)),
  ].sort();
  const documented = [...new Set(rules)].sort();
  report(
    actual.join(",") === documented.join(","),
    `${file} lists exactly what it plants`,
    actual.join(",") === documented.join(",")
      ? ""
      : `documented [${documented.join(",")}], actual [${actual.join(",")}]`
  );
}

console.log("\ndocumented-clean files");
for (const name of cleanFiles) {
  const hits = corpusFindings.filter((f) => fileOf(f) === name);
  report(
    hits.length === 0,
    `${name} stays silent`,
    hits.map((f) => `${ruleOf(f)}:${f.line}`).join(", ")
  );
}


// ---------------------------------------------------------------------------
// 1 + 2 · The standalone test fixture, against its own findings table
// ---------------------------------------------------------------------------

const FIXTURE = "src/test-fixtures/SampleAndroidApp";
const fixtureReadme = readFileSync(join(FIXTURE, "README.md"), "utf8");

/** Rows shaped `| W01 | Critical | Unclosed WakeLock | `SyncService.java` |`. */
const fixtureExpected = [];
for (const line of fixtureReadme.split(/\r?\n/)) {
  const m = line.match(/^\|\s*([WNLA]\d{2})\s*\|[^|]*\|[^|]*\|\s*`([^`]+)`\s*\|/);
  if (m) fixtureExpected.push({ rule: m[1], file: m[2] });
}

const fixtureFindings = analyzeProject(loadCorpus(FIXTURE));
const fixturePairs = pairs(fixtureFindings);

console.log(`\n${FIXTURE} — ${fixtureFindings.length} findings`);
for (const f of fixtureFindings) {
  console.log(`    ${f.patternId.padEnd(4)} ${f.severity.padEnd(8)} ${fileOf(f)}:${f.line}`);
}

console.log("\nfixture rules");
for (const { rule, file } of fixtureExpected) {
  report(fixturePairs.has(`${rule} ${file}`), `${rule} in ${file}`);
}

console.log("\nfixture table completeness");
for (const file of [...new Set(fixtureExpected.map((e) => e.file))]) {
  const actual = [
    ...new Set(fixtureFindings.filter((f) => fileOf(f) === file).map(ruleOf)),
  ].sort();
  const documented = [
    ...new Set(fixtureExpected.filter((e) => e.file === file).map((e) => e.rule)),
  ].sort();
  report(
    actual.join(",") === documented.join(","),
    `${file} lists exactly what it plants`,
    actual.join(",") === documented.join(",")
      ? ""
      : `documented [${documented.join(",")}], actual [${actual.join(",")}]`
  );
}

// ---------------------------------------------------------------------------
// 3 · Patterns that are correct, idiomatic, and must produce nothing
//
// Each of these was reported before the precision pass. They are written as
// real Android shapes rather than fragments, because the fixes key off context:
// a lifecycle pair, a constructor call, a permission check.
// ---------------------------------------------------------------------------

const java = (body) => `package com.example;\n\npublic class Case {\n${body}\n}\n`;

const CLEAN = [
  {
    name: "an OkHttp import is not a configured client",
    code:
      "package com.example;\n\nimport okhttp3.OkHttpClient;\n\npublic class Case {\n  OkHttpClient c = ClientFactory.shared();\n}\n",
  },
  {
    name: "checking FINE_LOCATION permission is not a location request",
    code: java(
      "  boolean f(Context c) {\n    return c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == 0;\n  }"
    ),
  },
  {
    name: "an XML namespace is not a cleartext endpoint",
    code: java('  String ns = "http://schemas.android.com/apk/res/android";'),
  },
  {
    name: "a W3C namespace is not a cleartext endpoint",
    code: java('  String ns = "http://www.w3.org/2000/svg";'),
  },
  {
    name: "a semaphore acquire is not a wake lock leak",
    code: java(
      "  final Semaphore gate = new Semaphore(1);\n\n  void f() throws Exception {\n    gate.acquire();\n  }"
    ),
  },
  {
    name: "a wake lock released in finally is balanced",
    code: java(
      "  void f(PowerManager.WakeLock wl) {\n    wl.acquire();\n    try {\n      work();\n    } finally {\n      wl.release();\n    }\n  }"
    ),
  },
  {
    name: "a wake lock paired across onResume/onPause is the documented idiom",
    code: "package com.example;\n\npublic class Case extends Activity {\n  PowerManager.WakeLock wl;\n\n  protected void onResume() {\n    super.onResume();\n    wl.acquire();\n  }\n\n  protected void onPause() {\n    super.onPause();\n    wl.release();\n  }\n}\n",
  },
  {
    name: "stopSelf(startId) is a stop",
    code: "package com.example;\n\npublic class Case extends Service {\n  public int onStartCommand(Intent i, int f, int s) {\n    work();\n    stopSelf(s);\n    return START_NOT_STICKY;\n  }\n}\n",
  },
  {
    name: "a bound service is stopped by its clients",
    code: "package com.example;\n\npublic class Case extends Service {\n  public int onStartCommand(Intent i, int f, int s) {\n    return START_NOT_STICKY;\n  }\n\n  public IBinder onBind(Intent i) {\n    return binder;\n  }\n}\n",
  },
  {
    name: "a foreground service may hold a partial wake lock",
    code: 'package com.example;\n\npublic class Case extends Service {\n  public int onStartCommand(Intent i, int f, int s) {\n    startForeground(1, buildNotification());\n    PowerManager.WakeLock wl = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "t");\n    wl.acquire();\n    try {\n      work();\n    } finally {\n      wl.release();\n    }\n    stopSelf(s);\n    return START_STICKY;\n  }\n}\n',
  },
  {
    name: "setAlarmClock is meant to wake the device",
    code: java(
      "  void f(AlarmManager am, PendingIntent pi) {\n    am.setAlarmClock(new AlarmManager.AlarmClockInfo(next, pi), pi);\n  }"
    ),
  },
  {
    name: "two unrelated timers are not a self-reposting loop",
    code: java(
      "  void f(Handler a, Handler b) {\n    a.postDelayed(tick, 1000);\n    b.postDelayed(prune, 5000);\n  }"
    ),
  },
  {
    name: "list.execute(item) inside a loop is not a network call",
    code: java(
      "  void f(TaskRunner tasks) {\n    for (Job j : jobs) {\n      tasks.execute(j);\n    }\n  }"
    ),
  },
  {
    name: "a listener unregistered via removeUpdates is balanced",
    code: java(
      "  void onResume() {\n    sm.registerListener(listener, sensor, 0);\n  }\n\n  void onPause() {\n    lm.removeUpdates(listener);\n  }"
    ),
  },
  {
    name: "a leak in a test tree is not a shipped defect",
    path: "src/test/java/com/example/CaseTest.java",
    code: java("  void f(PowerManager.WakeLock wl) {\n    wl.acquire();\n  }"),
  },
];

console.log("\nclean patterns (must produce nothing)");
for (const [i, c] of CLEAN.entries()) {
  const findings = analyzeProject([
    { path: c.path ?? `case-${i}.java`, content: c.code, language: "java" },
  ]);
  report(
    findings.length === 0,
    c.name,
    findings.map((f) => `${f.patternId}:${f.line}`).join(", ")
  );
}

// ---------------------------------------------------------------------------
// 4 · Suppression, and the true positives the tightening must not lose
// ---------------------------------------------------------------------------

const SUPPRESSED = [
  {
    name: "// ecotrace-ignore on the offending line",
    code: java(
      "  void f() {\n    OkHttpClient c = new OkHttpClient(); // ecotrace-ignore N02\n  }"
    ),
  },
  {
    name: "// ecotrace-disable-next-line",
    code: java(
      "  void f() {\n    // ecotrace-disable-next-line L01,L02,L03\n    lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 5000, 0f, l);\n  }"
    ),
  },
  {
    name: '@Suppress("EcoTrace:W01") on the declaration',
    code: java(
      '  @Suppress("EcoTrace:W01")\n  void f(PowerManager.WakeLock wl) {\n    wl.acquire();\n  }'
    ),
  },
];

console.log("\nsuppression");
for (const [i, c] of SUPPRESSED.entries()) {
  const findings = analyzeProject([
    { path: `suppressed-${i}.java`, content: c.code, language: "java" },
  ]);
  report(
    findings.length === 0,
    c.name,
    findings.map((f) => `${f.patternId}:${f.line}`).join(", ")
  );
}

const STILL_CAUGHT = [
  {
    name: "a client constructed with no timeout",
    rule: "N02",
    code: java("  void f() {\n    OkHttpClient c = new OkHttpClient();\n  }"),
  },
  {
    name: "GPS registered at 5 seconds",
    rule: "L01",
    code: java(
      "  void f() {\n    lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 5000, 0f, l);\n  }"
    ),
  },
  {
    name: "a wake lock with no release at all",
    rule: "W01",
    code: java(
      "  void f(PowerManager.WakeLock wl) {\n    wl.acquire();\n    work();\n  }"
    ),
  },
  {
    name: "a wake lock released only on the success path",
    rule: "W01",
    code: java(
      "  void f(PowerManager.WakeLock wl) {\n    wl.acquire();\n    try {\n      work();\n      wl.release();\n    } catch (Exception e) {\n      log(e);\n    }\n  }"
    ),
  },
  {
    name: "an OkHttp client used inside a self-reposting retry loop",
    rule: "N01",
    code: java(
      "  void f(final Handler h, OkHttpClient c) {\n    Runnable retry = new Runnable() {\n      public void run() {\n        c.newCall(req).execute();\n        h.postDelayed(this, 5000);\n      }\n    };\n    h.postDelayed(retry, 5000);\n  }"
    ),
  },
];

console.log("\ntrue positives (must still fire)");
for (const [i, c] of STILL_CAUGHT.entries()) {
  const findings = analyzeProject([
    { path: `caught-${i}.java`, content: c.code, language: "java" },
  ]);
  report(
    findings.some((f) => f.patternId === c.rule),
    c.name,
    findings.map((f) => f.patternId).join(", ") || "nothing"
  );
}

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nanalyzer precision check passed");
