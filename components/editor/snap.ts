/**
 * Timeline snap grid (SPEC 3.1): 100 ms, 50 ms, or beat subdivisions when a
 * BPM is set. Pure functions, shared by the playhead now and by clip handles
 * in chunk 13.
 */

export type SnapMode = "off" | "100ms" | "50ms" | "beat";

export type SnapSettings = {
  mode: SnapMode;
  /** Beats per minute. Beat mode does not snap until this is set. */
  bpm: number | null;
  /** Grid lines per beat: 1, 2, 4 or 8. */
  subdivision: number;
  /** Time of the first beat, for tracks that do not start on a beat. */
  beatOffsetMs: number;
};

export const DEFAULT_SNAP: SnapSettings = {
  mode: "100ms",
  bpm: null,
  subdivision: 4,
  beatOffsetMs: 0,
};

export const SUBDIVISIONS = [1, 2, 4, 8] as const;
export const MIN_BPM = 20;
export const MAX_BPM = 400;

export function isValidBpm(bpm: number | null): bpm is number {
  return (
    bpm !== null && Number.isFinite(bpm) && bpm >= MIN_BPM && bpm <= MAX_BPM
  );
}

/** Grid spacing in ms, or null when snapping is off (or beat mode has no BPM). */
export function snapStepMs(snap: SnapSettings): number | null {
  switch (snap.mode) {
    case "off":
      return null;
    case "100ms":
      return 100;
    case "50ms":
      return 50;
    case "beat":
      if (!isValidBpm(snap.bpm) || snap.subdivision <= 0) return null;
      return 60_000 / snap.bpm / snap.subdivision;
  }
}

/** Where the grid starts: the beat offset folded into one step, else 0. */
export function gridOriginMs(snap: SnapSettings, stepMs: number): number {
  if (snap.mode !== "beat") return 0;
  const origin = snap.beatOffsetMs % stepMs;
  return origin < 0 ? origin + stepMs : origin;
}

// Grid times are sums of fractional steps (e.g. 60000 / 130 / 4); round away
// float noise so equal grid points compare equal.
function tidy(ms: number): number {
  return Math.round(ms * 1000) / 1000;
}

function clampTime(ms: number, maxMs?: number): number {
  const upper = maxMs !== undefined && maxMs > 0 ? maxMs : Infinity;
  return Math.min(upper, Math.max(0, ms));
}

/**
 * Snap `ms` to the nearest grid point, then clamp to [0, maxMs]. With snapping
 * off it only clamps.
 */
export function snapTime(
  ms: number,
  snap: SnapSettings,
  maxMs?: number,
): number {
  const step = snapStepMs(snap);
  if (step === null) return clampTime(ms, maxMs);
  const origin = gridOriginMs(snap, step);
  return clampTime(
    tidy(origin + Math.round((ms - origin) / step) * step),
    maxMs,
  );
}

/**
 * The next grid point strictly after (direction 1) or before (-1) `ms`. Used
 * for arrow-key nudging. With snapping off it moves by 100 ms.
 */
export function stepTime(
  ms: number,
  direction: 1 | -1,
  snap: SnapSettings,
  maxMs?: number,
): number {
  const step = snapStepMs(snap) ?? 100;
  const origin = snapStepMs(snap) === null ? 0 : gridOriginMs(snap, step);
  const index = (ms - origin) / step;
  // A small tolerance so a time already on the grid moves a full step.
  const epsilon = 1e-6;
  const nextIndex =
    direction === 1
      ? Math.floor(index + epsilon) + 1
      : Math.ceil(index - epsilon) - 1;
  return clampTime(tidy(origin + nextIndex * step), maxMs);
}

export type TimelineTicks = {
  /** Spacing between drawn ticks. A whole multiple of the snap step. */
  tickMs: number;
  /** Label every n-th tick. */
  labelEvery: number;
  /** Time of the first tick. */
  originMs: number;
};

const DECIMAL_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
const BINARY_STEPS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];

/**
 * Tick spacing for the timeline ruler at a zoom level. Ticks sit on the snap
 * grid but skip grid points so they stay at least `minTickPx` apart, and
 * labels at least `minLabelPx` apart. Beat grids skip in powers of two so
 * ticks land on beats and bars.
 */
export function timelineTicks(
  snap: SnapSettings,
  pxPerSec: number,
  minTickPx = 8,
  minLabelPx = 70,
): TimelineTicks {
  const snapStep = snapStepMs(snap);
  const base = snapStep ?? 100;
  const multipliers =
    snap.mode === "beat" && snapStep !== null ? BINARY_STEPS : DECIMAL_STEPS;
  const pxPerMs = pxPerSec / 1000;
  const pick = (unit: number, minPx: number) =>
    multipliers.find((m) => unit * m * pxPerMs >= minPx) ??
    multipliers[multipliers.length - 1];
  const tickMs = tidy(base * pick(base, minTickPx));
  return {
    tickMs,
    labelEvery: pick(tickMs, minLabelPx),
    originMs: snapStep === null ? 0 : gridOriginMs(snap, tickMs),
  };
}

/** `m:ss.mmm`, for the transport display. */
export function formatTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
