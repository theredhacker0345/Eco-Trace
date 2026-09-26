/**
 * Run log.
 *
 * The previous build streamed the analyzer's reasoning into a permanent
 * centre panel, which was useful during a scan and noise afterwards. This is
 * the same stream presented as a first-class view: monospaced, level-filtered,
 * copyable, with autoscroll that yields the moment the user scrolls up.
 *
 * A log is only worth reading if it can be taken away, so the copy action is
 * part of the view rather than an afterthought.
 */

import { esc, qs, qsa } from "./dom.js";
import { clockTime } from "./format.js";
import type { LogLevel } from "./store.js";

type Filter = "all" | "critical" | "success";

interface Entry {
  level: LogLevel;
  time: string;
  message: string;
}

const entries: Entry[] = [];
let filter: Filter = "all";
let follow = true;
let stream: HTMLElement | null = null;

function levelMatches(level: LogLevel): boolean {
  if (filter === "all") return true;
  if (filter === "critical") return level === "critical" || level === "high";
  return level === "success";
}

function rowMarkup(entry: Entry): string {
  return `
    <div class="cx-log__line" data-level="${entry.level}">
      <span class="cx-log__time">${esc(entry.time)}</span>
      <span class="cx-log__level">${esc(entry.level)}</span>
      <span>
        <span class="cx-log__msg">${esc(entry.message)}</span>
      </span>
    </div>`;
}

function render(): void {
  if (!stream) return;
  const visible = entries.filter((entry) => levelMatches(entry.level));
  stream.innerHTML =
    visible.length === 0
      ? `<p class="cx-log__empty">${
          entries.length === 0
            ? "Nothing logged yet. Open a project and run an analysis."
            : "No entries match the current level filter."
        }</p>`
      : visible.map(rowMarkup).join("");

  if (follow) stream.scrollTop = stream.scrollHeight;
}

function onScroll(): void {
  if (!stream) return;
  // Scrolling up detaches the view from the tail; returning to the bottom
  // re-attaches it. Never fight the user for the scroll position.
  const atBottom =
    stream.scrollHeight - stream.scrollTop - stream.clientHeight < 24;
  if (atBottom === follow) return;
  follow = atBottom;
  const btn = document.getElementById("btn-log-autoscroll");
  if (btn) {
    btn.setAttribute("aria-pressed", String(follow));
    btn.textContent = follow ? "Follow" : "Paused";
  }
}

export function log(level: LogLevel, message: string): void {
  entries.push({ level, message, time: clockTime() });
  // Bound the buffer: a long scan on a large project can emit thousands of
  // lines, and an unbounded array in a long-lived desktop app is a leak.
  if (entries.length > 2000) entries.splice(0, entries.length - 2000);
  render();
}

export function initRunLog(): void {
  stream = qs("intelligence-feed");

  const bar = stream.parentElement?.querySelector(".cx-log__bar");
  bar?.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>(".cx-filter");
    if (target) {
      filter = (target.dataset.level as Filter) ?? "all";
      for (const chip of qsa<HTMLElement>(".cx-filter", bar)) {
        chip.setAttribute("aria-pressed", String(chip === target));
      }
      render();
    }
  });

  stream.addEventListener("scroll", onScroll, { passive: true });

  document.getElementById("btn-log-clear")?.addEventListener("click", () => {
    entries.length = 0;
    render();
  });

  document.getElementById("btn-log-copy")?.addEventListener("click", async () => {
    const text = entries
      .filter((entry) => levelMatches(entry.level))
      .map((entry) => `${entry.time}  ${entry.level.padEnd(8)}  ${entry.message}`)
      .join("\n");
    await navigator.clipboard.writeText(text || "EcoTrace run log was empty.");
    document.dispatchEvent(new CustomEvent("ecotrace:copied", { detail: "Run log copied" }));
  });

  const followBtn = document.getElementById("btn-log-autoscroll");
  followBtn?.addEventListener("click", () => {
    follow = !follow;
    followBtn.setAttribute("aria-pressed", String(follow));
    followBtn.textContent = follow ? "Follow" : "Paused";
    if (follow) render();
  });

  // No subscription to the store: `log()` renders as it appends, and the
  // events the rest of the app emits are about findings, not about this view.
  render();
}
