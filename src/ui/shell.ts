/**
 * Shell capability detection.
 *
 * EcoTrace is a Tauri desktop application, and a growing part of it is simply
 * not available in a browser: there is no folder picker, no filesystem, no ADB
 * subprocess and no app-data directory. Every one of those reaches the Tauri
 * IPC bridge, and outside the desktop shell that bridge does not exist — the
 * plugin's `invoke` is `undefined`, so calling it throws
 * `TypeError: Cannot read properties of undefined (reading 'invoke')`.
 *
 * That error is useless to a reader. It says nothing about why the button was
 * there or what to do instead, and it surfaced in the hosted demo as a raw
 * TypeError in a toast on a button that could never have worked.
 *
 * So the check lives in one place, and every desktop-only action consults it
 * before touching a plugin. The rule the whole codebase follows:
 *
 *   Never call a Tauri plugin outside the Tauri shell. Detect first, explain
 *   second, and never leave a control on screen that is guaranteed to fail.
 */

/** True inside the Tauri desktop shell, where the IPC bridge exists. */
export function isDesktopShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** True in a hosted build, where the demo mode provides the project. */
export function isHostedBuild(): boolean {
  return !isDesktopShell();
}

/**
 * Why a feature is unavailable, phrased for the person clicking the button.
 *
 * `feature` is a short noun phrase used in the middle of the sentence, e.g.
 * "Opening a project folder" or "Saving settings".
 */
export function unavailableReason(feature: string): string {
  return (
    `${feature} needs the EcoTrace desktop app. ` +
    "The hosted build is a demo over a bundled sample project — it has no access " +
    "to your filesystem, so there is nothing to open or persist."
  );
}
