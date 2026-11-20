import {
  SAMPLE_MS,
  colorAt,
  pointInPolygon,
  showDurationMs,
} from "@/lib/compile";
import type { Point, Show, Venue } from "@/lib/types";

/**
 * Editor preview (SPEC 2.1 step 4): a grid of simulated seats inside the
 * venue, each coloured as a phone at that seat would be.
 *
 * Phones play the schedule from `compileSchedule`, which samples the show
 * every `SAMPLE_MS` and holds each sample until the next. `colorAt` matches
 * the compiler at sample times, so evaluating it at the last sample time at
 * or before the playhead gives exactly the phone's colour, without compiling
 * a schedule per dot (seconds of work for a long show) on every edit.
 */

/** Grid cells per side. A 40 x 40 grid gives about 1,000 dots in a typical venue. */
export const PREVIEW_GRID = 40;

/** Centres of a `grid` x `grid` grid over 0..1 that fall inside a venue shape. */
export function previewDots(venue: Venue, grid = PREVIEW_GRID): Point[] {
  const dots: Point[] = [];
  for (let row = 0; row < grid; row++) {
    for (let col = 0; col < grid; col++) {
      const p = { x: (col + 0.5) / grid, y: (row + 0.5) / grid };
      if (venue.shapes.some((s) => pointInPolygon(p, s.points))) dots.push(p);
    }
  }
  return dots;
}

/**
 * The compiler sample a phone shows at `tMs`: the last sample at or before
 * it. Past the end of the show the schedule holds its last sample.
 */
export function sampleTimeAt(show: Show, tMs: number): number {
  const durationMs = showDurationMs(show);
  const lastSample =
    Math.max(0, Math.ceil(durationMs / SAMPLE_MS) - 1) * SAMPLE_MS;
  const t = Math.floor(Math.max(0, tMs) / SAMPLE_MS) * SAMPLE_MS;
  return Math.min(t, lastSample);
}

/**
 * Colours of `dots` at `tMs`, as phones at those seats would show them.
 * Clips not active at the sample time are dropped once per call, so the
 * per-dot work only scans the few clips that can light anything.
 */
export function previewColors(
  show: Show,
  dots: readonly Point[],
  tMs: number,
  out: string[] = [],
): string[] {
  const t = sampleTimeAt(show, tMs);
  // Filtering keeps list order, which `colorAt` uses to break layer ties.
  const frameShow: Show = {
    ...show,
    clips: show.clips.filter((c) => t >= c.startMs && t < c.endMs),
  };
  out.length = dots.length;
  for (let i = 0; i < dots.length; i++) out[i] = colorAt(frameShow, dots[i], t);
  return out;
}
