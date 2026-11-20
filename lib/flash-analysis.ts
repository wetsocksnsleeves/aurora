/**
 * Frame counting for the real-device test (SPEC 6.4, docs/device-test.md).
 * Pure: `scripts/flash-frames.ts` decodes the slow-motion video with ffmpeg
 * and passes in one brightness value per phone per frame.
 */

/** Normalised brightness thresholds for edge detection. */
export type EdgeThresholds = {
  /** Below this the screen counts as dark again. */
  low: number;
  /** The edge is the first frame at or above this... */
  mid: number;
  /** ...provided the screen then reaches this before going dark. */
  high: number;
};

export const DEFAULT_THRESHOLDS: EdgeThresholds = {
  low: 0.25,
  mid: 0.5,
  high: 0.75,
};

/** Scale a series to 0..1 by its own min and max (flat series give zeros). */
export function normalise(series: readonly number[]): number[] {
  let min = Infinity;
  let max = -Infinity;
  for (const v of series) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  return series.map((v) => (range > 0 ? (v - min) / range : 0));
}

/**
 * Frame indices where a screen turns from dark to lit. The edge is the first
 * frame at or above `mid`. Hysteresis keeps noise from counting twice: the
 * screen must reach `high` to confirm an edge and drop below `low` before
 * the next one can start.
 */
export function risingEdges(
  series: readonly number[],
  thresholds: EdgeThresholds = DEFAULT_THRESHOLDS,
): number[] {
  const v = normalise(series);
  const edges: number[] = [];
  let lit = (v[0] ?? 0) >= thresholds.mid;
  let candidate: number | null = null;
  for (let i = 0; i < v.length; i++) {
    const x = v[i]!;
    if (lit) {
      if (x < thresholds.low) lit = false;
      continue;
    }
    if (x < thresholds.low) {
      candidate = null;
      continue;
    }
    if (candidate === null && x >= thresholds.mid) candidate = i;
    if (candidate !== null && x >= thresholds.high) {
      edges.push(candidate);
      candidate = null;
      lit = true;
    }
  }
  return edges;
}

/** One flash: the frame each phone lit up on, or null if it was not seen. */
export type FlashRow = {
  /** Frame of the first phone to light up. */
  firstFrame: number;
  /** Per phone: frames after `firstFrame`, or null if missing. */
  lateFrames: (number | null)[];
  /** Last minus first, over the phones that were seen. */
  spreadFrames: number;
};

/**
 * Group each phone's edges into flashes. Edges within `windowFrames` of a
 * flash's first edge belong to it; use about half the flash period.
 */
export function groupFlashes(
  edgesPerPhone: readonly (readonly number[])[],
  windowFrames: number,
): FlashRow[] {
  const all: { frame: number; phone: number }[] = [];
  edgesPerPhone.forEach((edges, phone) => {
    for (const frame of edges) all.push({ frame, phone });
  });
  all.sort((a, b) => a.frame - b.frame);

  const rows: FlashRow[] = [];
  let i = 0;
  while (i < all.length) {
    const first = all[i]!.frame;
    const frames: (number | null)[] = edgesPerPhone.map(() => null);
    while (i < all.length && all[i]!.frame - first < windowFrames) {
      const { frame, phone } = all[i]!;
      if (frames[phone] === null) frames[phone] = frame;
      i++;
    }
    const seen = frames.filter((f): f is number => f !== null);
    rows.push({
      firstFrame: first,
      lateFrames: frames.map((f) => (f === null ? null : f - first)),
      spreadFrames: Math.max(...seen) - first,
    });
  }
  return rows;
}

export type PhoneSummary = {
  /** Flashes this phone was seen in. */
  flashes: number;
  medianLateFrames: number | null;
  maxLateFrames: number | null;
  /** Flashes where this phone was the last to light up. */
  lastCount: number;
};

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Per-phone lateness over all flashes, to spot a consistently late device. */
export function summarisePhones(
  rows: readonly FlashRow[],
  phones: number,
): PhoneSummary[] {
  return Array.from({ length: phones }, (_, p) => {
    const late = rows
      .map((r) => r.lateFrames[p])
      .filter((f): f is number => f !== null && f !== undefined);
    return {
      flashes: late.length,
      medianLateFrames: median(late),
      maxLateFrames: late.length ? Math.max(...late) : null,
      lastCount: rows.filter(
        (r) => r.spreadFrames > 0 && r.lateFrames[p] === r.spreadFrames,
      ).length,
    };
  });
}

/** Frames to milliseconds at `fps`. */
export function framesToMs(frames: number, fps: number): number {
  return (frames * 1000) / fps;
}
