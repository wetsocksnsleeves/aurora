import type { Point } from "./types";

/**
 * Fitting the show to the crowd. Seats come from the camera in room
 * coordinates (`lib/positioning/seat.ts`), which can sit anywhere in a large
 * box. Shows are drawn on a 0..1 room, so before compiling, each seat is
 * mapped through the crowd's own bounding box: "the left half" of a show is
 * the left half of wherever people actually are.
 */

/** The area the crowd covers, in the same coordinates as the seats. */
export type CrowdBox = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/** Margin added around the crowd, as a fraction of its size. */
const PADDING = 0.06;
/** Smallest box side, so one phone (or a tight cluster) doesn't blow up. */
const MIN_SIDE = 0.01;

/** The box around `seats`, padded; null with no seats. */
export function crowdBox(seats: readonly Point[]): CrowdBox | null {
  if (!seats.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of seats) {
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x);
    maxY = Math.max(maxY, s.y);
  }
  const grow = (lo: number, hi: number): [number, number] => {
    const side = Math.max(hi - lo, MIN_SIDE);
    const mid = (lo + hi) / 2;
    const half = (side * (1 + 2 * PADDING)) / 2;
    return [mid - half, mid + half];
  };
  const [x0, x1] = grow(minX, maxX);
  const [y0, y1] = grow(minY, maxY);
  return { minX: x0, minY: y0, maxX: x1, maxY: y1 };
}

/** A seat in show coordinates (0..1 across the crowd). Unchanged with no box. */
export function fitToCrowd(seat: Point, box: CrowdBox | null): Point {
  if (!box) return seat;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return {
    x: clamp((seat.x - box.minX) / (box.maxX - box.minX)),
    y: clamp((seat.y - box.minY) / (box.maxY - box.minY)),
  };
}

/**
 * Whether two boxes differ enough to be worth recompiling every phone for:
 * any edge moved by more than `tolerance` of the box's size.
 */
export function boxChanged(
  a: CrowdBox | null,
  b: CrowdBox | null,
  tolerance = 0.02,
): boolean {
  if (!a || !b) return a !== b;
  const w = Math.max(a.maxX - a.minX, b.maxX - b.minX);
  const h = Math.max(a.maxY - a.minY, b.maxY - b.minY);
  return (
    Math.abs(a.minX - b.minX) > tolerance * w ||
    Math.abs(a.maxX - b.maxX) > tolerance * w ||
    Math.abs(a.minY - b.minY) > tolerance * h ||
    Math.abs(a.maxY - b.maxY) > tolerance * h
  );
}
