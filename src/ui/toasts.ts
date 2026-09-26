/**
 * Toasts.
 *
 * Carbon's toast notification: bottom-left, raised surface, auto-dismiss,
 * closable. Severity travels in a leading icon and a coloured left edge rather
 * than a fully recoloured surface, so a stack of messages stays readable and
 * never shouts.
 *
 * The container is an aria-live region, so a scan completing or an action
 * failing is announced to a screen reader as well as being shown.
 */

import { esc, icon, qs } from "./dom.js";

export type ToastKind = "info" | "success" | "warning" | "error";

const ICONS: Record<ToastKind, string> = {
  info: "info",
  success: "check-circle",
  warning: "warning",
  error: "error",
};

const DEFAULT_DURATION = 6000;
const MAX_VISIBLE = 4;

let region: HTMLElement | null = null;

function container(): HTMLElement {
  if (!region) region = qs("toasts");
  return region;
}

function dismiss(toast: HTMLElement): void {
  if (toast.dataset.leaving === "true") return;
  toast.dataset.leaving = "true";
  toast.addEventListener("animationend", () => toast.remove(), { once: true });
  // Belt and braces: if the animation never fires (reduced motion, background
  // throttling) the element must still leave the DOM.
  window.setTimeout(() => toast.remove(), 400);
}

export function notify(
  kind: ToastKind,
  title: string,
  detail?: string,
  duration = DEFAULT_DURATION
): void {
  const host = container();

  // Keep the stack shallow; the oldest message is the least relevant.
  while (host.children.length >= MAX_VISIBLE) {
    host.firstElementChild?.remove();
  }

  const toast = document.createElement("div");
  toast.className = `cx-toast cx-toast--${kind}`;
  toast.innerHTML = `
    <svg class="cx-toast__icon" aria-hidden="true"><use href="#i-${ICONS[kind]}" /></svg>
    <div class="cx-toast__body">
      <div class="cx-toast__title">${esc(title)}</div>
      ${detail ? `<div class="cx-toast__detail">${esc(detail)}</div>` : ""}
    </div>
    <button class="cx-toast__close" aria-label="Dismiss notification">
      ${icon("close")}
    </button>
  `;

  toast.querySelector(".cx-toast__close")?.addEventListener("click", () => {
    dismiss(toast);
  });

  host.appendChild(toast);

  if (duration > 0) {
    window.setTimeout(() => dismiss(toast), duration);
  }
}

/**
 * Transient inline confirmation for an action that has no other visible result
 * — copying text, mostly. Announces through the same live region so the
 * outcome is not purely visual.
 */
export function flash(message: string): void {
  notify("success", message, undefined, 2600);
}
