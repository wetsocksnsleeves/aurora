import type { Point, Venue } from "./types";

/**
 * Pure geometry helpers for venue maps: turning a tap into a normalised
 * venue point, and testing that point against the venue's shapes. Used by
 * the participant page, the host map and the editor preview.
 */

/** An element's box in client pixels, as from `getBoundingClientRect()`. */
export type ClientRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/** How far outside a shape (in normalised units) a tap still counts. */
export const SEAT_SNAP_TOLERANCE = 0.04;

export function clampUnit(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Convert a pointer position in client pixels to a venue point in 0..1, given
 * the box the venue is drawn in. Returns null if the pointer is outside the
 * box or the box is empty.
 */
export function clientToVenuePoint(
  clientX: number,
  clientY: number,
  rect: ClientRect,
): Point | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/**
 * Ray-casting point-in-polygon test. Points exactly on an edge may land on
 * either side; callers that care use `pickSeat`, which snaps to edges.
 */
export function pointInPolygon(p: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/** The point on segment `a`–`b` closest to `p`. */
export function nearestPointOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return { x: a.x, y: a.y };
  const t = Math.min(
    1,
    Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq),
  );
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** The point on any shape edge closest to `p`, with its distance, or null. */
export function nearestPointOnVenue(
  venue: Venue,
  p: Point,
): { point: Point; distance: number } | null {
  let best: { point: Point; distance: number } | null = null;
  for (const shape of venue.shapes) {
    const pts = shape.points;
    for (let i = 0; i < pts.length; i++) {
      const q = nearestPointOnSegment(p, pts[i]!, pts[(i + 1) % pts.length]!);
      const distance = Math.hypot(q.x - p.x, q.y - p.y);
      if (!best || distance < best.distance) best = { point: q, distance };
    }
  }
  return best;
}

/** The id of the topmost (last drawn) shape containing `p`, or null. */
export function shapeAt(venue: Venue, p: Point): string | null {
  for (let i = venue.shapes.length - 1; i >= 0; i--) {
    const shape = venue.shapes[i]!;
    if (pointInPolygon(p, shape.points)) return shape.id;
  }
  return null;
}

/**
 * Decide where a tap at `p` puts the participant's seat:
 *
 * - inside a shape: the tapped point;
 * - within `tolerance` of a shape edge: the nearest point on that edge, so a
 *   slightly-off tap near the outline still counts;
 * - anywhere else: null (the tap is ignored);
 * - a venue with no shapes accepts any point.
 *
 * The result is clamped to 0..1, which the protocol requires.
 */
export function pickSeat(
  venue: Venue,
  p: Point,
  tolerance = SEAT_SNAP_TOLERANCE,
): Point | null {
  const clamped = { x: clampUnit(p.x), y: clampUnit(p.y) };
  if (venue.shapes.length === 0) return clamped;
  if (shapeAt(venue, clamped) !== null) return clamped;
  const nearest = nearestPointOnVenue(venue, clamped);
  if (!nearest || nearest.distance > tolerance) return null;
  return { x: clampUnit(nearest.point.x), y: clampUnit(nearest.point.y) };
}
