/**
 * IBM Bob 2.0 API client.
 *
 * The previous call site was a bare `fetch` with no timeout, no retry and no
 * accounting. That is not a theoretical concern: a hung request leaves the
 * Analyze button disabled forever with no way back, and a 429 from a rate
 * limiter discards an entire enrichment pass that may have cost real coins.
 *
 * What this adds, and why each is here rather than being decoration:
 *
 *   - A hard timeout on every request. Without one, a socket that never
 *     responds is indistinguishable from a slow model, and the UI is stuck.
 *   - Retry with exponential backoff and jitter, honouring `Retry-After`.
 *     Retries are only safe because the request is idempotent: it is a single
 *     completion call with a fixed temperature, so a retry produces a
 *     comparable answer rather than a second, different one.
 *   - Token accounting from the response `usage` block, surfaced to the UI.
 *     "How much did that cost" is unanswerable if the usage is discarded.
 *   - Error messages a person can act on. A 401 and a 429 need different
 *     responses, and neither is helped by a raw response body in a toast.
 *   - JSON extraction that tolerates a fenced block, a prose preamble, and a
 *     response truncated at the token limit. Models do all three, and the
 *     strict `JSON.parse` was discarding good answers over formatting.
 */

const DEFAULT_BASE = "https://api.bob.ibm.com/v2";

export interface BobUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Present when the endpoint reports it; otherwise null, never guessed. */
  costUsd: number | null;
  calls: number;
  wallClockMs: number;
}

export interface BobMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface BobRequest {
  messages: BobMessage[];
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** Overrides the default 120s. Large repository passes need longer. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BobResult {
  text: string;
  usage: BobUsage;
  /** How many HTTP round trips this cost, including retries. */
  attempts: number;
  /** Populated when a retry was needed, so the UI can say so honestly. */
  retried: boolean;
}

export class BobError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly hint: string;

  constructor(status: number, message: string, hint: string, retryable = false) {
    super(message);
    this.name = "BobError";
    this.status = status;
    this.hint = hint;
    this.retryable = retryable;
  }
}

/**
 * The message a user cancel carries, so the retry loop can recognise a
 * cancellation it did not construct itself.
 *
 * A cancel is never retryable: the caller asked the request to stop, and the
 * signal that stopped it is spent — a retried request could not be cancelled
 * again, because `addEventListener("abort")` on an already-fired signal never
 * fires. Reporting a cancel as a retryable "timed out" is how a cancelled
 * request used to be re-issued up to three times.
 */
const CANCELLED_MESSAGE = "Request cancelled";

function cancelledError(): BobError {
  return new BobError(
    0,
    CANCELLED_MESSAGE,
    "Cancelled before IBM Bob responded.",
    false
  );
}

/** True for both a raw AbortError and the non-retryable cancel BobError. */
function isCancellation(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  return (
    err instanceof BobError && !err.retryable && err.message === CANCELLED_MESSAGE
  );
}

/**
 * Cost per million tokens, in USD.
 *
 * Deliberately a table the user can see and correct rather than a constant
 * buried in the client: model pricing changes, and a wrong number presented
 * confidently is worse than an honest null. `null` cost is reported as unknown,
 * never as zero.
 */
const PRICE_PER_MTOK: Record<string, { in: number; out: number }> = {
  "bob-2": { in: 3, out: 15 },
  "bob-2-mini": { in: 1, out: 5 },
};

export function estimateCostUsd(model: string, usage: BobUsage): number | null {
  // Prefer a cost the server reported; fall back to the local table.
  if (usage.costUsd !== null) return usage.costUsd;
  const price = PRICE_PER_MTOK[model];
  if (!price) return null;
  const usd =
    (usage.promptTokens / 1_000_000) * price.in +
    (usage.completionTokens / 1_000_000) * price.out;
  return Math.round(usd * 10_000) / 10_000;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Pulls a JSON value out of a model response.
 *
 * Handles, in order of preference: a bare JSON document; a fenced ```json block;
 * JSON preceded by prose; and an array truncated at the token limit, which is
 * recovered by closing the open brackets. Returns null when nothing usable is
 * present, so the caller can report "unparseable" rather than crashing.
 */
export function extractJson<T>(raw: string): T | null {
  const text = raw.trim();
  if (!text) return null;

  const tryParse = (candidate: string): T | null => {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      return null;
    }
  };

  // 1 · Already clean.
  const direct = tryParse(text);
  if (direct !== null) return direct;

  // 2 · Fenced block, any language tag.
  const fence = /```(?:json|json5)?\s*\n?([\s\S]*?)```/i.exec(text);
  if (fence) {
    const inner = tryParse(fence[1].trim());
    if (inner !== null) return inner;
  }

  // 3 · The first balanced object or array anywhere in the response.
  const start = text.search(/[[{]/);
  if (start >= 0) {
    const open = text[start];
    const close = open === "[" ? "]" : "}";
    const slice = text.slice(start);
    const end = slice.lastIndexOf(close);
    if (end > 0) {
      const balanced = tryParse(slice.slice(0, end + 1));
      if (balanced !== null) return balanced;
    }

    // 4 · Truncated mid-array. Close whatever is still open and keep the
    //    complete elements, which is strictly better than discarding an answer
    //    that is 95% there because it ran out of tokens.
    if (open === "[") {
      const repaired = tryParse(closeTruncatedArray(slice));
      if (Array.isArray(repaired)) return repaired as T;
    }
  }

  return null;
}

/** Closes the brackets left open by a truncated array, dropping the partial tail. */
function closeTruncatedArray(slice: string): string {
  const items: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; continue; }
    if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) items.push(slice.slice(start, i + 1));
      continue;
    }
  }

  return `[${items.join(",")}]`;
}

interface RawResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost_usd?: number;
  };
  error?: { message?: string };
}

export interface BobClientOptions {
  baseUrl?: string;
  maxRetries?: number;
  defaultTimeoutMs?: number;
}

export class BobClient {
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly defaultTimeoutMs: number;

  constructor(options: BobClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE;
    this.maxRetries = options.maxRetries ?? 3;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
  }

  /**
   * Lists available models.
   *
   * Used by the connection test, so a 401 is reported as a bad key rather than
   * as a network failure -- the two are indistinguishable from a bare fetch
   * failure and mean opposite things to the person holding the key.
   */
  async listModels(apiKey: string, signal?: AbortSignal): Promise<string[]> {
    // No retry knob here or in rawFetch: retries belong to the caller, and
    // `retries: 1` used to be passed and silently ignored.
    const response = await this.rawFetch(
      `${this.baseUrl}/models`,
      { method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
      { timeoutMs: 20_000, signal }
    );
    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    return (data.data ?? []).map((m) => m.id ?? "").filter(Boolean);
  }

  async complete(apiKey: string, request: BobRequest): Promise<BobResult> {
    if (!apiKey.trim()) {
      throw new BobError(0, "No API key", "Add an IBM Bob 2.0 key in Settings.");
    }

    const started = Date.now();
    let attempts = 0;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Check before every attempt, not only when fetch throws: a cancel that
      // lands during the backoff sleep must stop the sequence there, rather
      // than start a round trip the caller has already asked to end.
      if (request.signal?.aborted) throw cancelledError();
      attempts++;
      try {
        const response = await this.rawFetch(
          `${this.baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: request.model,
              messages: request.messages,
              // Low temperature on purpose: this endpoint produces structured
              // analysis, and a creative answer is a wrong answer.
              temperature: request.temperature ?? 0.1,
              max_tokens: request.maxTokens ?? 4096,
            }),
          },
          {
            timeoutMs: request.timeoutMs ?? this.defaultTimeoutMs,
            signal: request.signal,
          }
        );

        const data = (await response.json()) as RawResponse;
        const text = data.choices?.[0]?.message?.content ?? "";
        if (!text.trim()) {
          throw new BobError(
            response.status,
            "Bob returned an empty response",
            "Try again, or switch to bob-2-mini for a lighter pass."
          );
        }

        const u = data.usage ?? {};
        const usage: BobUsage = {
          promptTokens: u.prompt_tokens ?? 0,
          completionTokens: u.completion_tokens ?? 0,
          totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
          costUsd: typeof u.cost_usd === "number" ? u.cost_usd : null,
          calls: attempts,
          wallClockMs: Date.now() - started,
        };
        return { text, usage, attempts, retried: attempt > 0 };
      } catch (err) {
        lastError = err;
        // A cancellation is terminal — rethrow it as it is (raw AbortError or
        // the non-retryable BobError) instead of converting it into retries.
        if (isCancellation(err)) throw err;
        // The signal may also have fired while we were reading the response or
        // sleeping between attempts; that is a cancel too, never a retry.
        if (request.signal?.aborted) throw cancelledError();
        const retryable = err instanceof BobError ? err.retryable : false;

        if (!retryable || attempt === this.maxRetries) break;

        await sleep(backoffMs(attempt, err));
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new BobError(0, "Unknown failure", "Check the key and the network.", true);
  }

  /** One fetch, with a timeout. Retries are handled by the caller. */
  private async rawFetch(
    url: string,
    init: RequestInit,
    opts: { timeoutMs: number; signal?: AbortSignal }
  ): Promise<Response> {
    // An already-fired signal would never trigger the `onAbort` listener
    // below, so the request would start out unable to be cancelled. Refuse it
    // up front instead — non-retryably, like every other cancel.
    if (opts.signal?.aborted) throw cancelledError();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

    // Chain the caller's signal, so a cancel button really does cancel the
    // in-flight request rather than only the UI around it.
    const onAbort = (): void => controller.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });

      if (response.ok) return response;

      // Drain the body so the connection is not left hanging.
      const body = await response.text().catch(() => "");

      if (response.status === 401 || response.status === 403) {
        throw new BobError(
          response.status,
          "IBM Bob rejected the API key",
          "Check the key in Settings, and that it is authorised for this model."
        );
      }
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after") ?? 0);
        const err = new BobError(
          response.status,
          "Rate limited by IBM Bob",
          retryAfter
            ? `Retrying in ${Math.round(retryAfter)}s.`
            : "Retrying with backoff.",
          true
        );
        (err as BobError & { retryAfterMs?: number }).retryAfterMs = retryAfter * 1000;
        throw err;
      }
      if (response.status >= 500) {
        throw new BobError(
          response.status,
          `IBM Bob is unavailable (HTTP ${response.status})`,
          "This is usually transient. Retrying.",
          true
        );
      }
      if (response.status === 400) {
        throw new BobError(
          response.status,
          "IBM Bob rejected the request",
          summarise(body) || "The model may not support these parameters."
        );
      }
      throw new BobError(
        response.status,
        `IBM Bob returned HTTP ${response.status}`,
        summarise(body)
      );
    } catch (err) {
      if (err instanceof BobError) throw err;
      if (err instanceof DOMException && err.name === "AbortError") {
        // Both the timeout timer and the caller's cancel surface here as
        // AbortError — fetch cannot tell them apart, but the retry logic must.
        // A timeout is worth retrying; a user cancel must never be, and
        // reporting it as a retryable "timed out" is what used to re-issue a
        // cancelled request (with a signal that could no longer stop it).
        if (opts.signal?.aborted) throw cancelledError();
        throw new BobError(
          0,
          "The request timed out",
          `No response in ${Math.round(opts.timeoutMs / 1000)}s. A large project can exceed this; try bob-2-mini.`,
          true
        );
      }
      // Network-level failure: fetch itself rejected.
      throw new BobError(
        0,
        "Could not reach IBM Bob",
        "Check the network connection and that api.bob.ibm.com is reachable.",
        true
      );
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** Exponential backoff with full jitter, so parallel clients do not resync. */
function backoffMs(attempt: number, err: unknown): number {
  const explicit = (err as { retryAfterMs?: number } | undefined)?.retryAfterMs;
  if (typeof explicit === "number" && explicit > 0) return explicit;
  const base = Math.min(8000, 600 * 2 ** attempt);
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

/** First line of an error body, trimmed, so a toast is not a wall of HTML. */
function summarise(body: string): string {
  const text = (body ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text.slice(0, 160);
}

/** Human-readable cost, for the UI. Never invents a figure. */
export function formatCost(usd: number | null): string {
  if (usd === null) return "cost unknown";
  if (usd === 0) return "no cost";
  if (usd < 0.01) return `< $0.01`;
  return `$${usd.toFixed(2)}`;
}

export function formatUsage(usage: BobUsage, model: string): string {
  const cost = estimateCostUsd(model, usage);
  return (
    `${usage.totalTokens.toLocaleString()} tokens` +
    ` · ${formatCost(cost)}` +
    (usage.calls > 1 ? ` · ${usage.calls} attempts` : "")
  );
}
