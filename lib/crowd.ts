import type { Point } from "./types";

/**
 * Fitting the show to the crowd. Seats come from the camera in room
 * coordinates (`lib/positioning/seat.ts`): the screen is at the top centre
 * (x 0.5, y 0) of a large box. Shows are drawn on a 0..1 room with the
 * screen in the same place, so before compiling each seat is mapped through
 * a box sized to the crowd but anchored to the screen: centred on it across,
 * and starting at it in depth. A phone left of the screen stays left of the
 * screen, and the show still spans the people actually there.
 */

/** The area the crowd covers, in the same coordinates as the seats. */
export type CrowdBox = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

/** Margin added beyond the outermost seats, as a fraction of the box. */
const PADDING = 0.06;
/** The screen's centre in seat coordinates. */
const SCREEN_X = 0.5;

/**
 * Smallest box, in seat units, so one phone or a small group isn't stretched
 * over the whole show. `halfWidth` is either side of the screen's centre.
 */
export type MinimumRoom = { halfWidth: number; depth: number };

/** With this many seats or more, the outermost 2% each side are ignored. */
const TRIM_FROM = 20;
const TRIM = 0.02;

/**
 * The room the crowd fills, anchored to the screen; the minimum room with no
 * seats. In a large crowd the most extreme seats are left out, so one stray
 * (or spoofed) position can't stretch everyone's show.
 */
export function crowdBox(seats: readonly Point[], min: MinimumRoom): CrowdBox {
  if (!seats.length) {
    return {
      minX: SCREEN_X - min.halfWidth,
      minY: 0,
      maxX: SCREEN_X + min.halfWidth,
      maxY: min.depth,
    };
  }
  const xs = seats.map((s) => s.x).sort((a, b) => a - b);
  const ys = seats.map((s) => s.y).sort((a, b) => a - b);
  const cut = seats.length >= TRIM_FROM ? Math.floor(seats.length * TRIM) : 0;
  const reach = Math.max(
    SCREEN_X - xs[cut]!,
    xs[xs.length - 1 - cut]! - SCREEN_X,
  );
  const halfWidth = Math.max(reach * (1 + PADDING), min.halfWidth);
  const depth = Math.max(ys[ys.length - 1 - cut]! * (1 + PADDING), min.depth);
  return {
    minX: SCREEN_X - halfWidth,
    minY: 0,
    maxX: SCREEN_X + halfWidth,
    maxY: depth,
  };
}

/** The minimum room for a positioning config: 8 m across, 6 m deep. */
export function minimumRoom(config: {
  venueWidthM: number;
  venueDepthM: number;
}): MinimumRoom {
  return { halfWidth: 4 / config.venueWidthM, depth: 6 / config.venueDepthM };
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
