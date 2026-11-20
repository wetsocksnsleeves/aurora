import type { Point, Venue } from "@/lib/types";
import { pointInPolygon } from "@/lib/venue-geometry";

export { pointInPolygon };

/**
 * Width / height of the venue drawing. Points are stored normalised to 0..1
 * on both axes, so every view of the venue must use the same aspect ratio to
 * show the shapes undistorted. Square, matching `VenueView`'s default on the
 * participant page and host map.
 */
export const VENUE_ASPECT = 1;

export type Size = { width: number; height: number };
export type PixelPoint = { x: number; y: number };

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function clampPoint(p: Point): Point {
  return { x: clamp01(p.x), y: clamp01(p.y) };
}

/** Normalised point to canvas pixels. */
export function toPx(p: Point, size: Size): PixelPoint {
  return { x: p.x * size.width, y: p.y * size.height };
}

/** Canvas pixels to a normalised point, clamped to the venue. */
export function fromPx(px: PixelPoint, size: Size): Point {
  return clampPoint({
    x: size.width > 0 ? px.x / size.width : 0,
    y: size.height > 0 ? px.y / size.height : 0,
  });
}

export function pxDistance(a: Point, b: Point, size: Size): number {
  return Math.hypot((a.x - b.x) * size.width, (a.y - b.y) * size.height);
}

/** Four corners, clockwise from top-left, of the rectangle spanned by a and b. */
export function rectFromCorners(a: Point, b: Point): Point[] {
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y, b.y);
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ];
}

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number };

export function polygonBounds(points: Point[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

/** Pixel distance from p to the segment ab. */
export function distanceToSegmentPx(
  p: Point,
  a: Point,
  b: Point,
  size: Size,
): number {
  const P = toPx(p, size);
  const A = toPx(a, size);
  const B = toPx(b, size);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0
      ? 0
      : Math.min(
          1,
          Math.max(0, ((P.x - A.x) * dx + (P.y - A.y) * dy) / lengthSq),
        );
  return Math.hypot(P.x - (A.x + t * dx), P.y - (A.y + t * dy));
}

/**
 * The topmost venue shape under p: inside it, or within `tolerancePx` of its
 * outline. Later shapes draw on top, so they win.
 */
export function hitTestShapes(
  shapes: Venue["shapes"],
  p: Point,
  size: Size,
  tolerancePx = 6,
): string | null {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const { id, points } = shapes[i];
    if (pointInPolygon(p, points)) return id;
    for (let k = 0; k < points.length; k++) {
      const a = points[k];
      const b = points[(k + 1) % points.length];
      if (distanceToSegmentPx(p, a, b, size) <= tolerancePx) return id;
    }
  }
  return null;
}

/**
 * Move a polygon by (dx, dy), limiting the move so every point stays inside
 * 0..1. The shape keeps its form when dragged against an edge.
 */
export function translatePolygon(
  points: Point[],
  dx: number,
  dy: number,
): Point[] {
  const b = polygonBounds(points);
  const cx = Math.min(1 - b.maxX, Math.max(-b.minX, dx));
  const cy = Math.min(1 - b.maxY, Math.max(-b.minY, dy));
  return points.map((p) => ({ x: p.x + cx, y: p.y + cy }));
}

/** Twice the signed area. Zero for degenerate (collinear) polygons. */
export function signedArea2(points: Point[]): number {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    sum += (points[j].x - points[i].x) * (points[j].y + points[i].y);
  }
  return sum;
}
