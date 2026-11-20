import type { ClockSyncEnv } from "@/lib/clock-sync";

/**
 * `ClockSync` env for a browser page: `performance.now()` (SPEC 4.1) and the
 * window timers. Call only in the browser.
 */
export function browserClockEnv(): ClockSyncEnv {
  return {
    now: () => performance.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (h) => window.clearInterval(h as number),
  };
}
