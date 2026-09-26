/**
 * EcoTrace Static Analyzer
 * Detects all 23 Android energy anti-patterns across Java and Kotlin source files.
 * See .bob/rules-agent/energy.md for the full detection spec.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = "Critical" | "High" | "Medium";
export type Category =
  | "Wakefulness"
  | "Network"
  | "Location/Sensors"
  | "Lifecycle/Architecture";

export interface FileContent {
  path: string; // absolute path
  content: string;
  language: "java" | "kotlin";
}

export interface Finding {
  patternId: string; // e.g. "W01"
  patternName: string;
  severity: Severity;
  category: Category;
  file: string;
  line: number;
  snippet: string; // the offending line (trimmed)
  description: string;
  causalChainHint: string; // where Bob should start tracing backwards
}

export interface CallEdge {
  callerFile: string;
  callerMethod: string;
  callerLine: number;
  calleeMethod: string; // just the method name called
}

export interface CallGraph {
  // method name → list of call edges that invoke it
  callers: Map<string, CallEdge[]>;
  // file+method → list of call edges it makes
  calls: Map<string, CallEdge[]>;
  // absolute path → comment-stripped source, so chain tracing can resolve the
  // method that encloses a finding without re-reading the project. Carried on
  // the graph rather than in module scope: a module-level map is shared by
  // every graph the process ever builds, so tracing a chain from a graph that
  // was not the most recent analyse silently resolved method names against
  // whichever project happened to be loaded last.
  sources: Map<string, string>;
}

export interface ChainNode {
  file: string;
  method: string;
  line: number;
  role: "root" | "intermediate" | "symptom";
  description: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lines(content: string): string[] {
  return content.split(/\r?\n/);
}

/**
 * Blank out the *contents* of `//`, `/* *\/` and `/** *\/` comments while
 * preserving every newline, so line numbers reported by detectors stay exact.
 *
 * String and character literals are deliberately left untouched: patterns like
 * N04 need to see the URL text inside `"http://..."`. The scanner skips over
 * literals so a `//` inside a string is not mistaken for a comment.
 */
export function stripComments(content: string): string {
  const out = content.split("");
  const n = content.length;
  let i = 0;
  let inBlock = false;

  while (i < n) {
    const c = content[i];
    const next = content[i + 1];

    if (inBlock) {
      if (c === "*" && next === "/") {
        out[i] = " ";
        out[i + 1] = " ";
        i += 2;
        inBlock = false;
        continue;
      }
      if (c !== "\n" && c !== "\r") out[i] = " ";
      i++;
      continue;
    }

    if (c === "/" && next === "*") {
      out[i] = " ";
      out[i + 1] = " ";
      i += 2;
      inBlock = true;
      continue;
    }

    if (c === "/" && next === "/") {
      while (i < n && content[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }

    // String literal — copy verbatim so comment markers inside are ignored.
    if (c === '"') {
      i++;
      while (i < n) {
        if (content[i] === "\\") { i += 2; continue; }
        if (content[i] === '"' || content[i] === "\n") { i++; break; }
        i++;
      }
      continue;
    }

    // Character literal.
    if (c === "'") {
      i++;
      while (i < n) {
        if (content[i] === "\\") { i += 2; continue; }
        if (content[i] === "'" || content[i] === "\n") { i++; break; }
        i++;
      }
      continue;
    }

    i++;
  }

  return out.join("");
}

/**
 * Blank out `import` lines while preserving every newline.
 *
 * An import is a *mention* of a class, not a *use* of it. The N-series
 * detectors ask "is an HTTP client configured in this file", and
 * `import okhttp3.OkHttpClient;` answered yes — so a file that merely named the
 * class was reported as having no connect timeout. That was the single largest
 * source of false positives in the tool.
 *
 * Blanking rather than deleting keeps the line numbering that findings, the
 * inspector and the exported report all index by.
 */
function blankImports(content: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => (/^\s*import\s/.test(line) ? "" : line))
    .join("\n");
}

/** Strip comments and imports once per file; detectors only ever see code. */
function withoutComments(files: FileContent[]): FileContent[] {
  return files.map((f) => ({
    ...f,
    content: blankImports(stripComments(f.content)),
  }));
}

/** Return the 1-based line number of the first regex match, or -1. */
function firstMatchLine(content: string, re: RegExp): number {
  const ls = lines(content);
  for (let i = 0; i < ls.length; i++) {
    if (re.test(ls[i])) return i + 1;
  }
  return -1;
}

function snippet(content: string, lineNo: number): string {
  const ls = lines(content);
  return (ls[lineNo - 1] ?? "").trim();
}

// ---------------------------------------------------------------------------
// Precision helpers
//
// Every detector is a regex over source text, so the difference between a
// finding and a false positive is nearly always whether the matched token is a
// *use* of the API or merely a *mention* of it. These helpers encode that
// distinction once instead of leaving each detector to re-invent it:
//
//   mention — an import, a permission constant, an XML namespace, a doc string
//   use     — a constructor call, a setter on the same receiver, a lifecycle pairing
//
// Tightening a detector is only worth doing if the corpus proves it, which is
// what `npm run analyzer:check` does: the demo corpus and the test fixture must
// still produce every rule their documentation claims.
// ---------------------------------------------------------------------------

/** Evidence that this file creates, holds or names a PowerManager WakeLock. */
const WAKELOCK_EVIDENCE = /newWakeLock\s*\(|PowerManager\.WakeLock|WakeLock\b/i;

/**
 * Evidence that this file *constructs* an HTTP client, as opposed to importing
 * one, receiving one as a parameter, or referring to one in a type position.
 */
const HTTP_CLIENT_CONSTRUCTED =
  /new\s+OkHttpClient\s*\(|OkHttpClient\s*\(\s*\)|OkHttpClient\.Builder|new\s+Retrofit|Retrofit\.Builder|new\s+URL\s*\([^)]*\)\s*\.\s*openConnection\s*\(|\.openConnection\s*\(|HttpURLConnection/;

/** Evidence that a call actually goes to the network, at a call site. */
const NETWORK_CALL_SITE =
  /\.newCall\s*\(|\.enqueue\s*\(|\.execute\s*\(\s*\)|getInputStream\s*\(|openConnection\s*\(|new\s+OkHttpClient\s*\(|OkHttpClient\s*\(\s*\)|Retrofit|HttpURLConnection/;

/**
 * Teardown calls that legitimately balance a sensor or location registration.
 * The platform offers several spellings, and a base class or ViewModel may own
 * the deregistration, so the previous "same file must contain
 * `unregisterListener(`" test reported correct code as a leak.
 */
const LISTENER_TEARDOWN =
  /unregisterListener\s*\(|removeUpdates\s*\(|removeLocationUpdates\s*\(/;

/**
 * Evidence of a server-push channel, so a poller is only reported when the
 * platform push option is genuinely absent. These are matched with word
 * boundaries because the first version matched `SSE` inside `SUCCESSES`, and a
 * single counter name was enough to silence the rule project-wide.
 */
const PUSH_CHANNEL =
  /FirebaseMessaging|\bFCM\b|\bSSE\b|WebSocket\s*\(|EventSource\s*\(/;

/**
 * Hosts that appear in `http://` strings without being endpoints: XML
 * namespaces, platform schema URIs and documentation links. Reporting these as
 * cleartext traffic is noise, and noise is what makes a report untrustworthy.
 */
const NON_ENDPOINT_HOST =
  /^http:\/\/(?:schemas\.android\.com|www\.w3\.org|w3\.org|xmlpull\.org|xml\.org|apache\.org|www\.apache\.org|purl\.org|ns\.adobe\.com|schemas\.microsoft\.com|json-schema\.org)(?:\/|$)/i;

/** Hosts that are reachable only from a development machine or an emulator. */
const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|10\.0\.2\.2|0\.0\.0\.0|\[::1\])(?::|$)/i;

/** The method name enclosing `lineNo` (1-based) in `content`, or "<top>". */
function enclosingMethod(content: string, lineNo: number): string {
  const ls = lines(content);
  const defRe =
    /(?:fun\s+|(?:public|private|protected|internal|static|final|override|suspend)\s+(?:[\w<>\[\],. ]+\s+)*)(\w+)\s*\(/;
  for (let i = Math.min(lineNo - 1, ls.length - 1); i >= 0; i--) {
    const m = defRe.exec(ls[i]);
    if (!m) continue;
    const name = m[1];
    if (
      !/^(if|for|while|switch|when|catch|new|return|class|interface|try|else)$/.test(
        name
      )
    ) {
      return name;
    }
  }
  return "<top>";
}

/**
 * Every `<receiver>.acquire(` site, with the receiver name and line number.
 *
 * The receiver is what makes two acquisitions interesting: the same lock
 * acquired twice is a counting bug, two different locks in two unrelated
 * methods are two independent operations.
 */
function acquireSites(content: string): Array<{ receiver: string; line: number }> {
  const out: Array<{ receiver: string; line: number }> = [];
  const ls = lines(content);
  const re = /([A-Za-z_$][\w$]*)\s*\.\s*acquire\s*\(/g;
  for (let i = 0; i < ls.length; i++) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ls[i])) !== null) out.push({ receiver: m[1], line: i + 1 });
  }
  return out;
}

/** Numeric constants declared in this file, so `UPDATE_INTERVAL_MS` has a value. */
function numericConstants(content: string): Map<string, number> {
  const values = new Map<string, number>();
  const re =
    /(?:static\s+final|final\s+static|const\s+val|const)\s+(?:long|int|float|double|Int|Long|Float|Double)?\s*([A-Za-z_$][\w$]*)\s*=\s*(\d[\d_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    values.set(m[1], Number(m[2].replace(/_/g, "")));
  }
  return values;
}

/** Text inside the first balanced parenthesis pair at or after `from`. */
function callArguments(text: string, from: number): string {
  const open = text.indexOf("(", from);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

/** True when `onBind()` returns something other than `null`, i.e. a bound service. */
function isBoundService(content: string): boolean {
  const m = content.match(/IBinder\s+onBind\s*\([^)]*\)\s*\{([\s\S]{0,240}?)\}/);
  if (!m) return false;
  return !/\breturn\s+null\b/.test(m[1]);
}

/**
 * Suppression directives, read from the file **as written**.
 *
 * Directives live in comments and annotations, and comments are stripped before
 * any detector runs, so the index has to be built from the original text. The
 * reason this exists: a local regex cannot see that a WakeLock is released by a
 * lifecycle observer three files away, and a developer who knows that should be
 * able to say so where the code is, rather than in a bug tracker.
 *
 *   // ecotrace-ignore W01,N02         suppress those rules on this line
 *   // ecotrace-ignore                  suppress every rule on this line
 *   // ecotrace-disable-next-line W01   suppress on the following line
 *   // ecotrace-ignore-file N02         suppress across the whole file
 *   @Suppress("EcoTrace:W01")          suppress across the whole file
 */
interface Suppressions {
  file: Set<string>;
  lines: Map<number, Set<string>>;
}

const SUPPRESSION_RULE = /^(?:ECOTRACE:)?[WNLA]\d{2}$/i;

function collectSuppressions(content: string): Suppressions {
  const fileWide = new Set<string>();
  const lineScoped = new Map<number, Set<string>>();

  const add = (lineNo: number, ids: string[]): void => {
    const set = lineScoped.get(lineNo) ?? new Set<string>();
    for (const id of ids) set.add(id);
    lineScoped.set(lineNo, set);
  };

  /** Turns the text after a directive into rule ids; a bare directive = all. */
  const parse = (raw: string): string[] => {
    const ids = raw
      .split(/[\s,;"'{}\[\]]+/)
      .map((t) => t.trim().toUpperCase())
      .filter((t) => SUPPRESSION_RULE.test(t))
      .map((t) => t.replace(/^ECOTRACE:/, ""));
    return ids.length > 0 ? ids : ["*"];
  };

  const src = content.split(/\r?\n/);

  for (let i = 0; i < src.length; i++) {
    const line = src[i];

    const fileDirective = line.match(/ecotrace-ignore-file\b([^*]*)/i);
    if (fileDirective) {
      for (const id of parse(fileDirective[1])) fileWide.add(id);
      continue;
    }

    const nextLine = line.match(/ecotrace-disable-next-line\b([^*]*)/i);
    if (nextLine) {
      for (const id of parse(nextLine[1])) add(i + 2, [id]);
      continue;
    }

    const inline = line.match(/ecotrace-ignore\b([^*]*)/i);
    if (inline) {
      for (const id of parse(inline[1])) add(i + 1, [id]);
    }

    // An annotation that names EcoTrace explicitly opts the whole file out,
    // because that is the only reading under which the prefix means anything.
    // A generic @Suppress("W01") is scoped to the declaration it annotates.
    const annotationRe = /@Suppress(?:Warnings)?\s*\(\s*\{?\s*"([^"]+)"[^)]*\)/g;
    let annotation: RegExpExecArray | null;
    while ((annotation = annotationRe.exec(line)) !== null) {
      const value = annotation[1];
      const ids = parse(value);
      if (/ecotrace:/i.test(value)) {
        for (const id of ids) fileWide.add(id);
      } else {
        for (const id of ids) add(i + 1, [id]);
      }
    }
  }

  return { file: fileWide, lines: lineScoped };
}

/**
 * Whether a directive covers `line`.
 *
 * A directive on the line above a finding counts too, because that is where a
 * comment explaining "this lock is intentional" naturally sits.
 */
function suppressionApplies(s: Suppressions, line: number, rule: string): boolean {
  if (s.file.has("*") || s.file.has(rule)) return true;
  for (let i = 0; i < 2; i++) {
    const set = s.lines.get(line - i);
    if (set && (set.has("*") || set.has(rule))) return true;
  }
  return false;
}

/**
 * Files that are not the product's own shipped code.
 *
 * An instrumented test that deliberately leaks a WakeLock, a mock HTTP client
 * with no timeout, and generated code from a codegen step are all real matches
 * and all useless findings: nobody ships them, and reporting them is how a
 * report earns a reputation for crying wolf.
 */
function isNonProductionPath(path: string): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  return (
    /\/src\/(test|androidtest)\//.test(p) ||
    /\/tests?\//.test(p) ||
    /(?:^|[^a-z])[^/\\]*tests?\.(?:java|kt)$/.test(p) ||
    /(?:^|[^a-z])[^/\\]*spec\.(?:java|kt)$/.test(p) ||
    /\/generated\//.test(p) ||
    /\.g\.(?:java|kt)$/.test(p)
  );
}

function finding(
  patternId: string,
  patternName: string,
  severity: Severity,
  category: Category,
  file: string,
  line: number,
  content: string,
  description: string,
  causalChainHint: string
): Finding {
  return {
    patternId,
    patternName,
    severity,
    category,
    file,
    line,
    snippet: snippet(content, line),
    description,
    causalChainHint,
  };
}

// ---------------------------------------------------------------------------
// Pattern detectors — one function per pattern
// ---------------------------------------------------------------------------

// W01 — Unclosed WakeLock
function detectW01(f: FileContent): Finding[] {
  // A bare `.acquire(` is equally a semaphore, a mutex, a camera or a
  // connection pool. Requiring WakeLock evidence in the same file is what
  // separates "this file leaks a wake lock" from "this file calls a method
  // called acquire", which was the rule's most common false positive.
  if (!WAKELOCK_EVIDENCE.test(f.content)) return [];

  const sites = acquireSites(f.content);
  if (sites.length === 0) return [];

  const hasRelease = /\.release\s*\(/.test(f.content);
  const hasTryFinally = /finally\s*\{[\s\S]*?\.release\s*\(/.test(f.content);
  // `use.withWakeLock { }` and library equivalents release for you.
  const hasScopedApi = /\bwithWakeLock\b/.test(f.content);

  if (!hasRelease) {
    return [
      finding(
        "W01",
        "Unclosed WakeLock",
        "Critical",
        "Wakefulness",
        f.path,
        sites[0].line,
        f.content,
        `WakeLock.acquire() called on '${sites[0].receiver}' with no matching release() found in this file.`,
        "Trace acquire() call upward to find the lifecycle method that holds this WakeLock."
      ),
    ];
  }

  // release() exists somewhere. It is not a leak when it is guaranteed by a
  // finally block, when a scoped helper API is in use, or when the lock is
  // acquired and released around a lifecycle callback pair — that last shape is
  // the documented Android idiom, not an oversight.
  const lifecyclePaired =
    /\bon(?:Resume|Start|Create|StartCommand|Bind)\s*\(/.test(f.content) &&
    /\bon(?:Pause|Stop|Destroy|DestroyView|Unbind)\s*\([\s\S]{0,400}?\.release\s*\(/.test(
      f.content
    );

  if (hasTryFinally || hasScopedApi || lifecyclePaired) return [];

  return [
    finding(
      "W01",
      "Unclosed WakeLock",
      "Critical",
      "Wakefulness",
      f.path,
      sites[0].line,
      f.content,
      "WakeLock.acquire() found but release() is not guaranteed: it is not in a finally block and it does not sit on the matching lifecycle path, so an exception or an early return leaks the lock.",
      "Wrap acquire/release in try/finally. Trace up to find which lifecycle method owns this lock."
    ),
  ];
}

// W02 — WakeLock across IPC boundary
function detectW02(f: FileContent): Finding[] {
  const results: Finding[] = [];
  // A non-blocking lifecycle callback paired with a binder call is only this
  // defect if a wake lock is actually involved.
  if (!WAKELOCK_EVIDENCE.test(f.content)) return [];
  const ls = lines(f.content);
  for (let i = 0; i < ls.length; i++) {
    if (/([A-Za-z_$][\w$]*)\s*\.\s*acquire\s*\(/.test(ls[i])) {
      // Look within the next 10 lines for an IPC call. AIDL/binder calls are
      // matched by the trailing `...<method>(` on a bound-service reference,
      // which is the shape the previous placeholder pattern failed to catch.
      const window = ls.slice(i + 1, i + 11).join("\n");
      if (/startService\(|bindService\(|sendBroadcast\(|startWakefulService\(/.test(window)) {
        results.push(
          finding(
            "W02",
            "WakeLock Across IPC Boundary",
            "Critical",
            "Wakefulness",
            f.path,
            i + 1,
            f.content,
            "WakeLock acquired immediately before an IPC call (startService/bindService/sendBroadcast). IPC may not complete reliably.",
            "Find the Service or BroadcastReceiver being started. Trace whether it completes reliably and releases the lock."
          )
        );
      }
    }
  }
  return results;
}

// W03 — WakeLock in AsyncTask
function detectW03(f: FileContent): Finding[] {
  const isAsyncTask = /extends\s+AsyncTask|:\s*AsyncTask</.test(f.content);
  if (!isAsyncTask) return [];
  if (!WAKELOCK_EVIDENCE.test(f.content)) return [];
  const line = firstMatchLine(f.content, /\.acquire\s*\(/);
  if (line === -1) return [];
  return [
    finding(
      "W03",
      "WakeLock in AsyncTask",
      "Critical",
      "Wakefulness",
      f.path,
      line,
      f.content,
      "WakeLock acquired inside an AsyncTask. AsyncTask is not lifecycle-aware — rotation destroys the Activity but the WakeLock stays held.",
      "Find the Activity/Fragment that creates and executes this AsyncTask. Replace with lifecycleScope coroutine."
    ),
  ];
}

// W04 — PARTIAL_WAKE_LOCK in background Service
function detectW04(f: FileContent): Finding[] {
  const isService = /extends\s+Service\b|:\s*Service\s*\(/.test(f.content);
  if (!isService) return [];
  // The pattern is "a partial lock is *held* in a Service". A constant, a
  // string, a commented-out line or a doc reference is not a held lock, and a
  // service that never acquires one is not running the CPU awake.
  if (!/newWakeLock\s*\(/.test(f.content)) return [];
  const line = firstMatchLine(f.content, /PARTIAL_WAKE_LOCK/);
  if (line === -1) return [];
  if (!/\.acquire\s*\(/.test(f.content)) return [];
  // A foreground service with an ongoing notification is the platform's
  // sanctioned shape for long-running user-visible work, not this defect.
  if (/startForeground\s*\(/.test(f.content)) return [];
  return [
    finding(
      "W04",
      "PARTIAL_WAKE_LOCK in Background Service",
      "Critical",
      "Wakefulness",
      f.path,
      line,
      f.content,
      "PARTIAL_WAKE_LOCK used inside a Service. Services have no built-in wake constraint handling — replace with WorkManager.",
      "Find the caller of startService() for this Service. Root cause is choosing Service over WorkManager."
    ),
  ];
}

// W05 — WakeLock in BroadcastReceiver without goAsync
function detectW05(f: FileContent): Finding[] {
  const isReceiver =
    /extends\s+BroadcastReceiver|:\s*BroadcastReceiver\(\)/.test(f.content);
  if (!isReceiver) return [];
  if (!WAKELOCK_EVIDENCE.test(f.content)) return [];
  const hasAcquire = /\.acquire\s*\(/.test(f.content);
  if (!hasAcquire) return [];
  const hasGoAsync = /goAsync\s*\(\)/.test(f.content);
  if (hasGoAsync) return [];
  const line = firstMatchLine(f.content, /\.acquire\s*\(/);
  return [
    finding(
      "W05",
      "WakeLock in BroadcastReceiver Without goAsync",
      "Critical",
      "Wakefulness",
      f.path,
      line,
      f.content,
      "WakeLock acquired in BroadcastReceiver.onReceive() without goAsync(). The receiver window is extremely short.",
      "Root cause: doing heavy work in BroadcastReceiver. Delegate to WorkManager instead."
    ),
  ];
}

// W06 — Nested WakeLock acquisition
function detectW06(f: FileContent): Finding[] {
  if (!WAKELOCK_EVIDENCE.test(f.content)) return [];
  const sites = acquireSites(f.content);
  if (sites.length < 2) return [];

  // Two acquires in two unrelated methods are two independent, balanced
  // operations — flagging that pair was the rule's false positive. What this
  // rule is about is one lock (or one job) taken twice, so the pair must share
  // a receiver or an enclosing method.
  const byMethod = new Map<string, number[]>();
  const byReceiver = new Map<string, number[]>();
  for (const site of sites) {
    const method = enclosingMethod(f.content, site.line);
    byMethod.set(method, [...(byMethod.get(method) ?? []), site.line]);
    byReceiver.set(site.receiver, [
      ...(byReceiver.get(site.receiver) ?? []),
      site.line,
    ]);
  }

  const pair =
    [...byMethod.values()].find((l) => l.length >= 2) ??
    [...byReceiver.values()].find((l) => l.length >= 2);
  if (!pair) return [];

  // If every acquisition is inside a try/finally that releases, the counting is
  // already correct and the pair is deliberate layering rather than a bug.
  if (/finally\s*\{[\s\S]*?\.release\s*\(/.test(f.content)) return [];

  return [
    finding(
      "W06",
      "Nested WakeLock Acquisition",
      "High",
      "Wakefulness",
      f.path,
      pair[1],
      f.content,
      `WakeLock.acquire() is reached twice for the same lock or the same unit of work (lines ${pair[0]} and ${pair[1]}), so a single release() unbalances the count.`,
      "Find all callers of both methods. Is there a code path where both execute sequentially?"
    ),
  ];
}

// N01 — Network call inside loop or postDelayed chain
function detectN01(f: FileContent): Finding[] {
  const results: Finding[] = [];
  const ls = lines(f.content);

  // One report per site, not per matching line. A self-reposting loop has two
  // `postDelayed` lines (the re-post inside the callback and the kick-off
  // outside it) that describe the same defect, and reporting both is noise.
  const push = (line: number, name: string, description: string, hint: string): void => {
    if (results.some((r) => Math.abs(r.line - line) <= 20)) return;
    results.push(
      finding("N01", name, "Critical", "Network", f.path, line, f.content, description, hint)
    );
  };

  for (let i = 0; i < ls.length; i++) {
    // Self-re-posting Handler. The previous guard was "any other postDelayed
    // within ±5 lines", which fired on two unrelated timers in one file; the
    // shape that actually drains is a callback that re-posts *itself*.
    if (/\.postDelayed\s*\(/.test(ls[i])) {
      const window = ls.slice(Math.max(0, i - 6), i + 14).join("\n");
      const selfReposting = /\.postDelayed\s*\(\s*this\s*,/.test(window);
      if (selfReposting && NETWORK_CALL_SITE.test(window)) {
        push(
          i + 1,
          "Network Call in PostDelayed Loop",
          "Handler.postDelayed() self-re-posts with a network call inside — continuous radio wake.",
          "Find the entry point that starts this chain. Replace with WorkManager periodic work."
        );
      }
    }

    // Network inside a for/while loop. Both halves matter: a loop, and a call
    // that actually goes to the network. Matching a bare `.execute(` flagged
    // `list.execute(item)` and every `executor.execute(runnable)` in the file.
    if (/\b(for|while)\s*\(/.test(ls[i])) {
      const body = ls.slice(i + 1, i + 16).join("\n");
      if (NETWORK_CALL_SITE.test(body)) {
        push(
          i + 1,
          "Network Call Inside Loop",
          "Network call detected inside a for/while loop — unbounded repeated HTTP requests.",
          "Batch requests outside the loop. Find what triggers this loop to identify the root cause."
        );
      }
    }
  }
  return results;
}

// N02 — No connection timeout
function detectN02(f: FileContent): Finding[] {
  // The client has to be *constructed here*. A file that imports OkHttp, or
  // that receives an already-configured client as a parameter, has no timeout
  // to set — and reporting those files was the rule's dominant false positive.
  if (!HTTP_CLIENT_CONSTRUCTED.test(f.content)) return [];
  if (/connectTimeout\s*\(|setConnectTimeout\s*\(/.test(f.content)) return [];

  const usesUrlConnection = /\.openConnection\s*\(|HttpURLConnection/.test(
    f.content
  );
  const line = firstMatchLine(f.content, HTTP_CLIENT_CONSTRUCTED);

  // The two clients have different defaults, so they get different sentences.
  // Saying "blocks indefinitely" about OkHttp would be wrong: it defaults to
  // 10 seconds. Saying it about HttpURLConnection is exactly right.
  const description = usesUrlConnection
    ? "HttpURLConnection is used with no connect timeout. Its default is 0, which means *no timeout at all* — a hung socket blocks the calling thread until the OS tears the connection down."
    : "An HTTP client is constructed here with no explicit connect timeout, so behaviour falls back to the library default (10 s for OkHttp). Pin an explicit value so a slow endpoint cannot hold a wake lock open by default.";

  return [
    finding(
      "N02",
      "No Connection Timeout",
      "High",
      "Network",
      f.path,
      line,
      f.content,
      description,
      "Find where this client is instantiated. Is it a singleton shared across the app?"
    ),
  ];
}

// N03 — No read timeout
function detectN03(f: FileContent): Finding[] {
  if (!HTTP_CLIENT_CONSTRUCTED.test(f.content)) return [];
  if (/readTimeout\s*\(|setReadTimeout\s*\(/.test(f.content)) return [];
  // Only flag the half-configured case; N02 covers the both-missing one.
  if (!/connectTimeout\s*\(|setConnectTimeout\s*\(/.test(f.content)) return [];
  const line = firstMatchLine(f.content, HTTP_CLIENT_CONSTRUCTED);
  return [
    finding(
      "N03",
      "No Read Timeout",
      "High",
      "Network",
      f.path,
      line,
      f.content,
      "Connection timeout is set but read timeout is missing — server can accept then stall indefinitely.",
      "Add .readTimeout() alongside .connectTimeout() on the same OkHttpClient.Builder."
    ),
  ];
}

// N04 — HTTP instead of HTTPS
function detectN04(f: FileContent): Finding[] {
  const results: Finding[] = [];
  const ls = lines(f.content);
  for (let i = 0; i < ls.length; i++) {
    const url = ls[i].match(/http:\/\/[^"'\s)]+/);
    if (!url) continue;
    // XML namespaces and platform schema URIs are not endpoints and are not
    // fetched; a report that flags `http://schemas.android.com/...` is a report
    // nobody reads to the end.
    if (NON_ENDPOINT_HOST.test(url[0])) continue;
    if (LOCAL_HOST.test(url[0].slice("http://".length))) continue;
    results.push(
      finding(
        "N04",
        "HTTP Instead of HTTPS",
        "High",
        "Network",
        f.path,
        i + 1,
        f.content,
        "Plaintext HTTP endpoint found. On Android 9+ cleartext is blocked by default, so the first attempt fails and the retry costs another radio wakeup.",
        "Find where this URL is defined. Is it a constant? Trace to the network call site."
      )
    );
  }
  return results;
}

// N05 — Synchronous network on main thread
function detectN05(f: FileContent): Finding[] {
  const isUiContext =
    /extends\s+(Activity|Fragment|AppCompatActivity|FragmentActivity|View|ComponentActivity)\b/.test(
      f.content
    ) ||
    /:\s*(Activity|Fragment|AppCompatActivity|FragmentActivity|View|ComponentActivity)\s*\(/.test(
      f.content
    );
  if (!isUiContext) return [];

  // A synchronous *network* call is the defect: `.execute()` on a database, a
  // query builder or a shell command is not one. An AsyncTask moves the call
  // off the main thread by construction, so a body that calls it is not this
  // rule.
  const syncRe = /\.newCall\s*\([^;]*?\)\s*\.\s*execute\s*\(\s*\)|getInputStream\s*\(\s*\)/;
  if (!syncRe.test(f.content)) return [];
  if (/doInBackground\s*\(/.test(f.content)) return [];

  const line = firstMatchLine(f.content, syncRe);
  return [
    finding(
      "N05",
      "Synchronous Network on Main Thread",
      "Critical",
      "Network",
      f.path,
      line,
      f.content,
      "Synchronous HTTP call in a UI class (Activity/Fragment/View). On API 11+ this throws NetworkOnMainThreadException; where it does not, it blocks the frame loop.",
      "Root cause: this Activity/Fragment method. Move to Dispatchers.IO coroutine or use .enqueue() async callback."
    ),
  ];
}

// N06 — Polling without FCM/WebSocket
function detectN06(files: FileContent[], f: FileContent): Finding[] {
  // Only flag if: this file re-arms a timer AND actually talks to the network
  // (both are uses, not mentions), and the project has no push channel.
  const hasScheduler =
    /setRepeating\s*\(|setInexactRepeating\s*\(|RTC_WAKEUP|ELAPSED_REALTIME_WAKEUP|scheduleAtFixedRate\s*\(|\.postDelayed\s*\(\s*this\s*,|\.postDelayed\s*\(\s*\w+\s*,\s*[A-Z_]+/.test(
      f.content
    );
  if (!hasScheduler) return [];
  if (!NETWORK_CALL_SITE.test(f.content)) return [];
  const projectHasPush = files.some((fi) => PUSH_CHANNEL.test(fi.content));
  if (projectHasPush) return [];
  const line = firstMatchLine(
    f.content,
    /setRepeating\s*\(|setInexactRepeating\s*\(|RTC_WAKEUP|ELAPSED_REALTIME_WAKEUP|scheduleAtFixedRate\s*\(|\.postDelayed\s*\(/
  );
  return [
    finding(
      "N06",
      "Polling Without FCM/WebSocket",
      "High",
      "Network",
      f.path,
      line,
      f.content,
      "Repeating scheduler + network call detected. No push notification (FCM/WebSocket) found in project — this is a polling pattern.",
      "Find the scheduling entry point. Replace polling with FCM for server-push or WorkManager for background sync."
    ),
  ];
}

// L01 — GPS interval < 30 seconds
function detectL01(f: FileContent): Finding[] {
  const results: Finding[] = [];
  const ls = lines(f.content);
  const constants = numericConstants(f.content);
  const callRe =
    /requestLocationUpdates\s*\(|setInterval\s*\(|setFastestInterval\s*\(|setMinUpdateIntervalMillis\s*\(/;

  for (let i = 0; i < ls.length; i++) {
    const m = callRe.exec(ls[i]);
    if (!m) continue;

    // Only the call's *own* argument list is examined. The previous version
    // took the first number within three lines, so a provider constant, a
    // status code or a resource id could be reported as a 5 ms GPS interval.
    //
    // Named constants are resolved because nobody writes the literal inline:
    // `requestLocationUpdates(GPS_PROVIDER, UPDATE_INTERVAL_MS, ...)` is the
    // normal shape, and reading only literals missed it.
    const raw = callArguments(ls.slice(i, i + 8).join(" "), m.index);
    const args = raw.replace(/[A-Za-z_$][\w$]*/g, (id) =>
      constants.has(id) ? String(constants.get(id)) : id
    );
    let interval = -1;

    const numRe = /(\d[\d_]*)/g;
    let n: RegExpExecArray | null;
    while ((n = numRe.exec(args)) !== null) {
      const value = Number(n[1].replace(/_/g, ""));
      // A bare number under 30 is seconds rather than milliseconds; both
      // readings sit below the 30-second floor this rule is about.
      const ms = value > 0 && value < 30 ? value * 1000 : value;
      if (ms > 0 && ms < 30_000) {
        interval = ms;
        break;
      }
    }
    if (interval === -1) continue;

    results.push(
      finding(
        "L01",
        "GPS Update Interval < 30 Seconds",
        "Critical",
        "Location/Sensors",
        f.path,
        i + 1,
        f.content,
        `Location update interval is ${interval}ms (< 30s). High-frequency GPS is the single largest battery drain on mobile: the radio cannot sleep while a fix is pending.`,
        "Find where the LocationRequest or interval is defined. Trace to the entry point that starts location tracking."
      )
    );
  }
  return results;
}

// L02 — FINE location when COARSE sufficient
function detectL02(f: FileContent): Finding[] {
  // A request for high accuracy is the defect. Asking the platform whether the
  // permission is granted — `checkSelfPermission(ACCESS_FINE_LOCATION)` — or
  // naming the constant in a preferences class is not a request, and treating
  // it as one was this rule's false positive.
  const requestEvidence =
    /requestLocationUpdates\s*\(|LocationRequest\.Builder|FusedLocationProviderClient|getCurrentLocation\s*\(|getLastLocation\s*\(|LocationManager\./;
  if (!requestEvidence.test(f.content)) return [];

  const fineRe =
    /ACCESS_FINE_LOCATION|GPS_PROVIDER|PRIORITY_HIGH_ACCURACY|Priority\.PRIORITY_HIGH_ACCURACY/;
  if (!fineRe.test(f.content)) return [];

  const line = firstMatchLine(f.content, fineRe);
  return [
    finding(
      "L02",
      "FINE Location When COARSE Sufficient",
      "High",
      "Location/Sensors",
      f.path,
      line,
      f.content,
      "A location request asks for FINE accuracy / the GPS provider. Verify the feature actually needs sub-10 m precision — COARSE costs roughly a third of the power.",
      "Find the feature consuming this location. If it shows nearby POIs, weather, or city-level content — COARSE is sufficient."
    ),
  ];
}

// L03 — Listener registered with no matching teardown
function detectL03(f: FileContent): Finding[] {
  // Both registrations are the same defect: a sensor callback and a location
  // callback are both held open by the platform until something removes them,
  // and a location listener outlives the screen exactly as a sensor one does.
  const registerRe = /registerListener\s*\(|requestLocationUpdates\s*\(/;
  if (!registerRe.test(f.content)) return [];
  // Paired teardown is the fix, and the platform offers more than one spelling
  // of it. Requiring `unregisterListener(` inside this same file reported a
  // base class, a ViewModel or a `removeUpdates()`-based tracker as a leak.
  if (LISTENER_TEARDOWN.test(f.content)) return [];

  const line = firstMatchLine(f.content, registerRe);
  return [
    finding(
      "L03",
      "Listener Not Unregistered in onPause/onStop",
      "Critical",
      "Location/Sensors",
      f.path,
      line,
      f.content,
      "A sensor or location listener is registered with no matching unregisterListener() / removeUpdates() anywhere in this file, so the provider keeps the callback alive after the screen is gone.",
      "Find this Activity/Fragment's onPause()/onStop(). Root cause: registration without deregistration."
    ),
  ];
}

// L04 — Full-rate accelerometer for step counting
function detectL04(f: FileContent): Finding[] {
  const hasAccelerometer = /TYPE_ACCELEROMETER/.test(f.content);
  if (!hasAccelerometer) return [];
  const hasStepKeyword = /step|pedometer|walk|pace|stride/i.test(f.content);
  if (!hasStepKeyword) return [];
  const line = firstMatchLine(f.content, /TYPE_ACCELEROMETER/);
  return [
    finding(
      "L04",
      "Full-Rate Accelerometer for Step Counting",
      "High",
      "Location/Sensors",
      f.path,
      line,
      f.content,
      "TYPE_ACCELEROMETER used in a file with step-counting keywords. Use TYPE_STEP_COUNTER (hardware-assisted, low power).",
      "Root cause: choosing TYPE_ACCELEROMETER over the dedicated step-counter sensor."
    ),
  ];
}

// L05 — Geofencing via polling
function detectL05(files: FileContent[], f: FileContent): Finding[] {
  // Polling means a *loop that re-arms*, not the mere presence of a Handler:
  // a Handler next to a location callback is ordinary UI plumbing. Requiring a
  // real repeating schedule is what separates the two.
  const hasPollingLocation =
    /requestLocationUpdates|getLastKnownLocation\s*\(/.test(f.content) &&
    /setRepeating\s*\(|setInexactRepeating\s*\(|RTC_WAKEUP|ELAPSED_REALTIME_WAKEUP|\.postDelayed\s*\(\s*this\s*,|scheduleAtFixedRate\s*\(/.test(
      f.content
    );
  if (!hasPollingLocation) return [];
  const hasDistanceCalc =
    /distanceTo\(|distanceBetween\(|Haversine|Math\.sin\(|Math\.cos\(/.test(
      f.content
    );
  if (!hasDistanceCalc) return [];
  const projectHasGeofence = files.some((fi) =>
    /GeofencingClient|Geofence\.Builder|addGeofences/.test(fi.content)
  );
  if (projectHasGeofence) return [];
  const line = firstMatchLine(f.content, /requestLocationUpdates/);
  return [
    finding(
      "L05",
      "Geofencing via Polling",
      "High",
      "Location/Sensors",
      f.path,
      line,
      f.content,
      "Location polling + distance calculation detected with no GeofencingClient in project — manual geofence polling.",
      "Replace with GeofencingClient API which uses hardware-optimized boundary detection."
    ),
  ];
}

// A01 — Service with no stopSelf
function detectA01(f: FileContent): Finding[] {
  const isService =
    /extends\s+Service\b|extends\s+IntentService\b|:\s*Service\s*\(|:\s*IntentService\s*\(/.test(
      f.content
    );
  if (!isService) return [];
  // A bound service is stopped by its clients; `stopSelf()` is neither expected
  // nor correct there.
  if (isBoundService(f.content)) return [];
  // `IntentService` calls `stopSelf()` itself once `onHandleIntent` returns.
  if (/extends\s+IntentService\b|:\s*IntentService\s*\(/.test(f.content)) return [];
  // `stopSelf(startId)` is the documented form. Requiring the empty-argument
  // spelling made every correct call site invisible, and reported a flagged
  // service as one that never stops.
  if (/stopSelf\s*\(|stopService\s*\(/.test(f.content)) return [];
  const line = firstMatchLine(f.content, /onStartCommand|onHandleIntent/);
  if (line === -1) return [];
  return [
    finding(
      "A01",
      "Service With No stopSelf()",
      "High",
      "Lifecycle/Architecture",
      f.path,
      line,
      f.content,
      "Service.onStartCommand() found with no stopSelf() or stopService() anywhere in the class — Service runs indefinitely.",
      "Find all startService() callers for this Service. Is it triggered repeatedly? Root cause: no termination condition."
    ),
  ];
}

// A02 — Deferrable work using raw Service
function detectA02(files: FileContent[], f: FileContent): Finding[] {
  const isService =
    /extends\s+(Service|IntentService)\b|:\s*(Service|IntentService)\s*\(/.test(
      f.content
    );
  if (!isService) return [];
  // A foreground service is user-visible by construction, and a bound service
  // is driven by its client's lifecycle. "Deferrable" describes neither.
  if (/startForeground\s*\(/.test(f.content)) return [];
  if (isBoundService(f.content)) return [];
  const isDeferrableWork =
    /sync|upload|backup|analytics|report|flush/i.test(
      f.path + " " + f.content.slice(0, 500)
    );
  if (!isDeferrableWork) return [];
  const projectHasWorkManager = files.some((fi) =>
    /WorkManager|Worker\b|CoroutineWorker/.test(fi.content)
  );
  if (projectHasWorkManager) return [];
  const line = firstMatchLine(f.content, /onStartCommand|onHandleIntent/);
  if (line === -1) return [];
  return [
    finding(
      "A02",
      "Deferrable Work Using Raw Service",
      "High",
      "Lifecycle/Architecture",
      f.path,
      line,
      f.content,
      "Deferrable work (sync/upload/backup) implemented as a raw Service with no WorkManager in the project.",
      "Find startService() callers. Is this triggered on a schedule? Scheduled deferrable work = WorkManager."
    ),
  ];
}

// A03 — JobScheduler ignored for background sync
function detectA03(files: FileContent[], f: FileContent): Finding[] {
  const submits = (content: string): boolean =>
    /\.schedule\s*\(|WorkManager\s*\.\s*getInstance\s*\(|\.enqueue\s*\(\s*\w*(?:Request|Work)/.test(
      content
    );

  // Shape 1 — constraints written and never submitted. A JobInfo built with
  // `setPeriodic`/`setRequiredNetworkType` and no `schedule()` anywhere in the
  // project is the most explicit form of this defect: the author knew what to
  // do, and the submission never happened. The constraints are dead code, so
  // the work that was supposed to be deferred runs unconstrained instead.
  if (
    /new\s+JobInfo\.Builder\s*\(/.test(f.content) &&
    !files.some((fi) => submits(fi.content))
  ) {
    const line = firstMatchLine(f.content, /new\s+JobInfo\.Builder\s*\(/);
    return [
      finding(
        "A03",
        "JobScheduler Ignored for Background Sync",
        "Medium",
        "Lifecycle/Architecture",
        f.path,
        line,
        f.content,
        "A JobInfo is built with constraints and never submitted: nothing in the project calls jobScheduler.schedule(). The constraints never take effect, so the work runs with no network or charging requirement.",
        "Submit the job with jobScheduler.schedule(jobInfo), or move the work to WorkManager."
      ),
    ];
  }

  // Shape 2 — network work in a Service, with no scheduling constraints at all.
  // A network call inside a Service means a client that is *constructed* here,
  // not an import or a type reference.
  const hasNetworkInService =
    /extends\s+Service\b|:\s*Service\s*\(/.test(f.content) &&
    HTTP_CLIENT_CONSTRUCTED.test(f.content);
  if (!hasNetworkInService) return [];
  if (firstMatchLine(f.content, /onStartCommand|onHandleIntent/) === -1) return [];
  const hasConstraints = /setRequiredNetworkType|setRequiresCharging|JobScheduler|JobInfo/.test(
    f.content
  );
  if (hasConstraints) return [];
  const projectHasWorkManager = files.some((fi) =>
    /WorkManager|JobScheduler/.test(fi.content)
  );
  if (projectHasWorkManager) return [];
  const line = firstMatchLine(f.content, HTTP_CLIENT_CONSTRUCTED);
  return [
    finding(
      "A03",
      "JobScheduler Ignored for Background Sync",
      "Medium",
      "Lifecycle/Architecture",
      f.path,
      line,
      f.content,
      "Network call in a Service with no JobScheduler/WorkManager constraints — sync runs on metered connections and battery.",
      "Is there a WiFi/charging check before the sync? If not, add WorkManager constraints: setRequiredNetworkType, setRequiresCharging."
    ),
  ];
}

// A04 — Infinite ValueAnimator not cancelled
function detectA04(f: FileContent): Finding[] {
  const hasInfinite =
    /setRepeatCount\s*\(\s*(?:ValueAnimator\.INFINITE|-1)\s*\)|repeatCount\s*=\s*(?:ValueAnimator\.INFINITE|-1)/.test(
      f.content
    );
  if (!hasInfinite) return [];
  const hasCancelInLifecycle =
    /onPause\s*\(\)|onStop\s*\(\)|onDestroyView\s*\(\)/.test(f.content) &&
    /\.cancel\(\)|\.end\(\)/.test(f.content);
  if (hasCancelInLifecycle) return [];
  const line = firstMatchLine(
    f.content,
    /setRepeatCount\s*\(\s*(?:ValueAnimator\.INFINITE|-1)\s*\)|repeatCount\s*=\s*(?:ValueAnimator\.INFINITE|-1)/
  );
  return [
    finding(
      "A04",
      "Infinite Animator Not Cancelled in Lifecycle",
      "High",
      "Lifecycle/Architecture",
      f.path,
      line,
      f.content,
      "ValueAnimator with INFINITE repeat count — no cancel() found in onPause/onStop. GPU redraws continuously when backgrounded.",
      "Find the Activity/Fragment. Is onPause() defined? Does it cancel this animator?"
    ),
  ];
}

// A05 — Heavy computation in onDraw
function detectA05(f: FileContent): Finding[] {
  const results: Finding[] = [];
  const ls = lines(f.content);
  let inOnDraw = false;
  let braceDepth = 0;
  let sawOpenBrace = false; // true once we've counted ≥1 opening brace

  for (let i = 0; i < ls.length; i++) {
    const line = ls[i];
    if (/override\s+fun\s+onDraw\s*\(|protected\s+void\s+onDraw\s*\(/.test(line)) {
      inOnDraw = true;
      braceDepth = 0;
      sawOpenBrace = false;
    }
    if (inOnDraw) {
      braceDepth += (line.match(/\{/g) || []).length;
      braceDepth -= (line.match(/\}/g) || []).length;
      if (braceDepth > 0) sawOpenBrace = true;
      // Exit only after we've seen the opening brace and depth returns to 0
      if (sawOpenBrace && braceDepth <= 0) {
        inOnDraw = false;
        continue;
      }
      // Check for problematic patterns inside onDraw
      if (/new\s+Paint\s*\(\)|Paint\s*\(\)/.test(line)) {
        results.push(
          finding(
            "A05",
            "Heavy Work in onDraw()",
            "Critical",
            "Lifecycle/Architecture",
            f.path,
            i + 1,
            f.content,
            "Paint object allocated inside onDraw() — called up to 120x/sec on high-refresh devices.",
            "Pre-allocate Paint as a class field in init/constructor. Move all allocation out of the draw loop."
          )
        );
      }
      if (/BitmapFactory\.|Bitmap\.createBitmap\(/.test(line)) {
        results.push(
          finding(
            "A05",
            "Heavy Work in onDraw()",
            "Critical",
            "Lifecycle/Architecture",
            f.path,
            i + 1,
            f.content,
            "Bitmap created/decoded inside onDraw() — I/O in the draw loop causes continuous CPU + GPU load.",
            "Decode bitmaps once in onSizeChanged() or init. Cache the result."
          )
        );
      }
    }
  }
  return results;
}

// A06 — AlarmManager WAKEUP for non-critical work
function detectA06(f: FileContent): Finding[] {
  // `setAlarmClock()` is the API for a user-visible alarm or reminder, and it is
  // *supposed* to wake the device. That is not this defect.
  if (/setAlarmClock\s*\(/.test(f.content)) return [];
  const re =
    /ELAPSED_REALTIME_WAKEUP|RTC_WAKEUP|setExactAndAllowWhileIdle\s*\(/;
  const line = firstMatchLine(f.content, re);
  if (line === -1) return [];
  return [
    finding(
      "A06",
      "AlarmManager WAKEUP for Non-Critical Work",
      "High",
      "Lifecycle/Architecture",
      f.path,
      line,
      f.content,
      "AlarmManager wakeup alarm detected. Wakeup alarms force device out of Doze mode — defeats Android 6+ battery optimization.",
      "Trace the PendingIntent target. If it does deferrable work, replace with WorkManager. Only use wakeup alarms for true time-critical tasks."
    ),
  ];
}

// ---------------------------------------------------------------------------
// Call graph builder
// ---------------------------------------------------------------------------

export function buildCallGraph(files: FileContent[]): CallGraph {
  const callers = new Map<string, CallEdge[]>();
  const calls = new Map<string, CallEdge[]>();
  const sources = new Map<string, string>();

  const methodDefRe =
    /(?:fun\s+|(?:public|private|protected|static|void|override)\s+(?:\w+\s+)*)(\w+)\s*\(/g;
  const callRe = /(\w+)\s*\(/g;

  for (const f of withoutComments(files)) {
    const ls = lines(f.content);
    sources.set(f.path, f.content);
    let currentMethod = "<top>";

    for (let i = 0; i < ls.length; i++) {
      const line = ls[i];

      // Detect method definition
      let defMatch: RegExpExecArray | null;
      methodDefRe.lastIndex = 0;
      while ((defMatch = methodDefRe.exec(line)) !== null) {
        const name = defMatch[1];
        // Skip common false positives
        if (!/^(if|for|while|switch|catch|new|return|class|interface)$/.test(name)) {
          currentMethod = name;
        }
      }

      // Detect call sites
      let callMatch: RegExpExecArray | null;
      callRe.lastIndex = 0;
      while ((callMatch = callRe.exec(line)) !== null) {
        const callee = callMatch[1];
        if (
          /^(if|for|while|switch|catch|new|return|class|interface|import|package)$/.test(
            callee
          )
        )
          continue;

        const edge: CallEdge = {
          callerFile: f.path,
          callerMethod: currentMethod,
          callerLine: i + 1,
          calleeMethod: callee,
        };

        // callers map: callee → edges that call it
        const existing = callers.get(callee) ?? [];
        existing.push(edge);
        callers.set(callee, existing);

        // calls map: file+method → edges it makes
        const key = `${f.path}::${currentMethod}`;
        const outgoing = calls.get(key) ?? [];
        outgoing.push(edge);
        calls.set(key, outgoing);
      }
    }
  }

  return { callers, calls, sources };
}

// ---------------------------------------------------------------------------
// Causal chain tracer
// ---------------------------------------------------------------------------

const LIFECYCLE_ROOTS = new Set([
  "onCreate", "onStartCommand", "onReceive", "onBind", "onHandleIntent",
  "onStart", "onResume", "onAttach", "doInBackground", "onPostExecute",
]);

export function traceCallChain(
  finding: Finding,
  callGraph: CallGraph,
  maxHops = 6
): ChainNode[] {
  const symptomMethod = detectMethodAtLine(finding, callGraph.sources);
  const chain: ChainNode[] = [
    {
      file: finding.file,
      method: symptomMethod,
      line: finding.line,
      role: "symptom",
      description: finding.description,
    },
  ];

  const visited = new Set<string>([symptomMethod]);
  let current = symptomMethod;

  for (let hop = 0; hop < maxHops; hop++) {
    const edges = callGraph.callers.get(current) ?? [];
    if (edges.length === 0) break;

    /*
     * A method's own definition site is recorded as a call to itself, so the
     * edge list for any method leads with a self-reference. Choosing it trips
     * the `visited` guard on the very first hop and ends the walk, which is
     * why the tracer used to return a single node for almost every finding:
     * the edge that could have continued the chain was never a candidate,
     * because the one it did choose was always itself.
     */
    const candidates = edges.filter((e) => e.callerMethod !== current);
    if (candidates.length === 0) break;

    // Prefer a lifecycle root, so the chain terminates at an architectural
    // decision point rather than wherever the walk happens to run out.
    const lifecycleEdge = candidates.find((e) => LIFECYCLE_ROOTS.has(e.callerMethod));
    const edge = lifecycleEdge ?? candidates[0];
    if (visited.has(edge.callerMethod)) break;
    visited.add(edge.callerMethod);

    const isRoot = LIFECYCLE_ROOTS.has(edge.callerMethod) || hop === maxHops - 1;
    chain.unshift({
      file: edge.callerFile,
      method: edge.callerMethod,
      line: edge.callerLine,
      role: isRoot ? "root" : "intermediate",
      description: isRoot
        ? `Architectural decision point - this is where the drain chain originates.`
        : `Calls ${current}`,
    });

    if (isRoot) break;
    current = edge.callerMethod;
  }

  // The walk can also end by running out of callers rather than by reaching a
  // lifecycle root. Leaving every node marked "intermediate" would render a
  // chain with no origin, which reads as a broken diagram rather than as an
  // honest one, so the outermost node is promoted and says why it is there.
  if (chain.length > 1 && !chain.some((node) => node.role === "root")) {
    chain[0].role = "root";
    chain[0].description =
      "Outermost caller the call graph could reach for this finding. " +
      "Nothing above it invokes the method, so the defect is entered from here.";
  }

  return chain;
}

function detectMethodAtLine(f: Finding, sources: Map<string, string>): string {
  // Walk up from the finding's line in the file to find the nearest enclosing
  // method definition. This gives us the actual containing method rather than
  // extracting a name from the causalChainHint text (which points to a callee,
  // not the containing method).
  const content = sources.get(f.file);
  if (content) {
    const ls = lines(content);
    const methodDefRe =
      /(?:fun\s+|(?:public|private|protected|static|void|override)\s+(?:\w+\s+)*)(\w+)\s*\(/;
    for (let i = Math.min(f.line - 1, ls.length - 1); i >= 0; i--) {
      const m = methodDefRe.exec(ls[i]);
      if (m) {
        const name = m[1];
        if (!/^(if|for|while|switch|catch|new|return|class|interface)$/.test(name)) {
          return name;
        }
      }
    }
  }
  // Fallback: extract from causalChainHint or use a generic name
  const hintMatch = f.causalChainHint.match(/(\w+)\(\)/);
  return hintMatch ? hintMatch[1] : f.patternId.toLowerCase() + "_site";
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export function analyzeProject(files: FileContent[]): Finding[] {
  const results: Finding[] = [];

  // Detectors run against comment-free, import-free source. Without the first,
  // documentation comments that *name* an anti-pattern (e.g. "W01 —
  // WakeLock.acquire()") both raise false positives and suppress real
  // detections, because the negative guard sees the word in prose. Without the
  // second, merely importing a class counted as using it.
  //
  // Test trees and generated code are excluded outright: a fixture that
  // deliberately leaks a WakeLock is a real match and a useless finding.
  const scan = withoutComments(files).filter((f) => !isNonProductionPath(f.path));
  const originalByPath = new Map<string, string>();
  for (const f of files) originalByPath.set(f.path, f.content);

  // Suppression directives are read from the sources as written, because they
  // live in the comments the detectors never see.
  const suppressions = new Map<string, Suppressions>();
  for (const f of files) suppressions.set(f.path, collectSuppressions(f.content));

  for (const f of scan) {
    results.push(...detectW01(f));
    results.push(...detectW02(f));
    results.push(...detectW03(f));
    results.push(...detectW04(f));
    results.push(...detectW05(f));
    results.push(...detectW06(f));

    results.push(...detectN01(f));
    results.push(...detectN02(f));
    results.push(...detectN03(f));
    results.push(...detectN04(f));
    results.push(...detectN05(f));
    results.push(...detectN06(scan, f));

    results.push(...detectL01(f));
    results.push(...detectL02(f));
    results.push(...detectL03(f));
    results.push(...detectL04(f));
    results.push(...detectL05(scan, f));

    results.push(...detectA01(f));
    results.push(...detectA02(scan, f));
    results.push(...detectA03(scan, f));
    results.push(...detectA04(f));
    results.push(...detectA05(f));
    results.push(...detectA06(f));
  }

  // Inline suppression, applied after every detector has run so that no rule
  // can opt itself out of the filter. `results` is spliced in place rather than
  // reassigned because it is the array the rest of this function indexes.
  const kept = results.filter((r) => {
    const s = suppressions.get(r.file);
    return !s || !suppressionApplies(s, r.line, r.patternId);
  });
  results.length = 0;
  results.push(...kept);

  // Report the real source line, not the comment-stripped copy.
  for (const r of results) {
    const original = originalByPath.get(r.file);
    if (original !== undefined) r.snippet = snippet(original, r.line);
  }

  // Sort: Critical first, then High, then Medium; within severity by file
  const severityOrder: Record<Severity, number> = {
    Critical: 0,
    High: 1,
    Medium: 2,
  };
  results.sort((a, b) => {
    const sd = severityOrder[a.severity] - severityOrder[b.severity];
    if (sd !== 0) return sd;
    const fd = a.file.localeCompare(b.file);
    if (fd !== 0) return fd;
    return a.line - b.line;
  });

  return results;
}
