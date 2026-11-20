/**
 * Browser device APIs for the Ready tap (SPEC 2.3, 4.9). Both requests must
 * start synchronously inside the tap handler: browsers only allow them as
 * part of a user gesture.
 */

/**
 * Enter fullscreen where the Fullscreen API exists (Android). iPhone Safari
 * has none; the page is already a black full-viewport layout there.
 */
export function enterFullscreen(): void {
  const el = document.documentElement;
  if (document.fullscreenElement || typeof el.requestFullscreen !== "function")
    return;
  try {
    el.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
  } catch {
    // Some browsers throw synchronously when not allowed.
  }
}

export function wakeLockSupported(): boolean {
  return typeof navigator !== "undefined" && "wakeLock" in navigator;
}

/**
 * Request a screen wake lock. Resolves to the sentinel, or null when the API
 * is missing (no HTTPS, old browser) or the request is refused. The browser
 * releases the lock when the tab is hidden; call again on return to visible.
 */
export function requestWakeLock(): Promise<WakeLockSentinel | null> {
  if (!wakeLockSupported()) return Promise.resolve(null);
  try {
    return navigator.wakeLock.request("screen").catch(() => null);
  } catch {
    return Promise.resolve(null);
  }
}
