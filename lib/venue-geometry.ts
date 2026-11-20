import type { Point, Venue } from "./types";

/**
 * Pure geometry helpers for venue maps: testing a normalised venue point
 * against the venue's shapes. Used by the host map and the editor preview.
 */

export function clampUnit(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Ray-casting point-in-polygon test. Points exactly on an edge may land on
 * either side.
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
