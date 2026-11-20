// Schedule compiler (SPEC 3.3). Pure: no Node or browser globals, so the
// server worker, the editor preview and the test harness all share it.

import type { Clip, Point, Schedule, Show, Venue } from "./types";

/** Sampling interval of the compiler (50 Hz). */
export const SAMPLE_MS = 20;

const BLACK = "#000000";

/**
 * A schedule plus the show length, as sent in the `schedule` message (5.2).
 * Same shape as `TimedSchedule` in server/sessions.ts.
 */
export type CompiledSchedule = Schedule & { durationMs: number };

/** Points closer than this to a polygon edge count as on the edge. */
const EDGE_EPSILON = 1e-9;

type Rgb = { r: number; g: number; b: number };

type PreparedClip = {
  clip: Clip;
  rgb: Rgb;
  /** Hit test result for a fill or static polygon, filled in on first use. */
  staticHit: boolean | undefined;
};

/**
 * Compiles the per-seat schedule: samples the show every 20 ms, picks the
 * colour of the highest-layer clip that covers the seat, and run-length
 * encodes the samples into change events. The first event is always at 0.
 *
 * A seat outside every venue shape is first snapped to the venue
 * (`snapSeatToVenue`).
 */
export function compileSchedule(show: Show, seat: Point): CompiledSchedule {
  const durationMs = showDurationMs(show);
  const clips = prepareClips(show);
  const p = snapSeatToVenue(show.venue, seat);
  const events: Schedule["events"] = [];

  let last = "";
  for (let k = 0; k * SAMPLE_MS < durationMs || k === 0; k++) {
    const tMs = k * SAMPLE_MS;
    const color = sample(clips, p, tMs);
    if (color !== last) {
      events.push({ tMs, color });
      last = color;
    }
  }

  return { events, durationMs };
}

/**
 * The colour a seat shows at `tMs`, evaluated directly from the clips. Used
 * by the editor preview and the host map. Matches `compileSchedule` at every
 * sample time.
 */
export function colorAt(show: Show, seat: Point, tMs: number): string {
  // A single linear scan with no sorting or allocation, since the preview and
  // host map call this for every dot on every frame.
  const p = snapSeatToVenue(show.venue, seat);
  let top: Clip | null = null;
  for (const clip of show.clips) {
    if (!isActive(clip, tMs)) continue;
    // On equal layers the later clip draws on top.
    if (top && clip.layer < top.layer) continue;
    if (covers(clip, p, tMs)) top = clip;
  }
  return top ? shade(parseColor(top.color), top, tMs) : BLACK;
}

/**
 * Length of the show: the audio duration, or the end of the last clip if a
 * clip runs past the audio.
 */
export function showDurationMs(show: Show): number {
  let end = Math.max(0, show.audio.durationMs);
  for (const clip of show.clips) end = Math.max(end, clip.endMs);
  return end;
}

/**
 * Returns `p` if it lies inside (or on the edge of) any venue shape.
 * Otherwise returns the nearest point on the nearest shape edge (SPEC 8).
 * A venue without shapes leaves the seat unchanged.
 */
export function snapSeatToVenue(venue: Venue, p: Point): Point {
  let best: Point | null = null;
  let bestDist = Infinity;
  for (const shape of venue.shapes) {
    if (pointInPolygon(p, shape.points)) return p;
    const pts = shape.points;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const q = closestPointOnSegment(p, a, b);
      const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = q;
      }
    }
  }
  return best ?? p;
}

/**
 * Ray-casting point-in-polygon test. Points on an edge or vertex count as
 * inside, so a seat snapped onto a venue edge is lit by a clip drawn over
 * that venue shape.
 */
export function pointInPolygon(p: Point, polygon: Point[]): boolean {
  const n = polygon.length;
  if (n === 0) return false;
  for (let i = 0; i < n; i++) {
    if (onSegment(p, polygon[i], polygon[(i + 1) % n])) return true;
  }
  if (n < 3) return false;

  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if (a.y > p.y !== b.y > p.y) {
      const xCross = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (p.x < xCross) inside = !inside;
    }
  }
  return inside;
}

/**
 * Fade envelope in 0..1 at `tMs` for a clip active at `tMs`: ramps up over
 * `fadeInMs` from `startMs` and down over `fadeOutMs` to `endMs`.
 */
export function fadeEnvelope(
  clip: Pick<Clip, "startMs" | "endMs" | "fadeInMs" | "fadeOutMs">,
  tMs: number,
): number {
  let f = 1;
  if (clip.fadeInMs > 0) f = Math.min(f, (tMs - clip.startMs) / clip.fadeInMs);
  if (clip.fadeOutMs > 0) f = Math.min(f, (clip.endMs - tMs) / clip.fadeOutMs);
  return Math.max(0, Math.min(1, f));
}

function prepareClips(show: Show): PreparedClip[] {
  // Highest layer first. On equal layers the clip later in the list draws
  // on top, as it would in the editor.
  return show.clips
    .map((clip, index) => ({ clip, index }))
    .filter(({ clip }) => clip.endMs > clip.startMs)
    .sort((a, b) => b.clip.layer - a.clip.layer || b.index - a.index)
    .map(({ clip }) => ({
      clip,
      rgb: parseColor(clip.color),
      staticHit: undefined,
    }));
}

function sample(clips: PreparedClip[], p: Point, tMs: number): string {
  for (const c of clips) {
    if (!isActive(c.clip, tMs)) continue;
    let hit: boolean;
    if (isMoving(c.clip)) {
      hit = covers(c.clip, p, tMs);
    } else {
      c.staticHit ??= covers(c.clip, p, tMs);
      hit = c.staticHit;
    }
    if (hit) return shade(c.rgb, c.clip, tMs);
  }
  return BLACK;
}

function isActive(clip: Clip, tMs: number): boolean {
  return tMs >= clip.startMs && tMs < clip.endMs;
}

function isMoving(clip: Clip): boolean {
  const move = clip.shape.kind === "polygon" ? clip.shape.moveTo : undefined;
  return !!move && (move.x !== 0 || move.y !== 0);
}

/** Whether `clip`, positioned as at `tMs`, covers seat `p`. */
function covers(clip: Clip, p: Point, tMs: number): boolean {
  const shape = clip.shape;
  if (shape.kind === "fill") return true;
  const move = shape.moveTo;
  if (!move || (move.x === 0 && move.y === 0)) {
    return pointInPolygon(p, shape.points);
  }
  // Offsetting the polygon by d is the same as testing p - d against the
  // original polygon, which avoids allocating a moved copy.
  const progress = (tMs - clip.startMs) / (clip.endMs - clip.startMs);
  return pointInPolygon(
    { x: p.x - move.x * progress, y: p.y - move.y * progress },
    shape.points,
  );
}

function shade(rgb: Rgb, clip: Clip, tMs: number): string {
  return scaleColor(rgb, fadeEnvelope(clip, tMs));
}

/** Parses `#rgb` or `#rrggbb`. Anything else is treated as black. */
function parseColor(color: string): Rgb {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex) return { r: 0, g: 0, b: 0 };
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

function scaleColor({ r, g, b }: Rgb, f: number): string {
  const ch = (c: number) =>
    Math.round(c * f)
      .toString(16)
      .padStart(2, "0");
  return `#${ch(r)}${ch(g)}${ch(b)}`;
}

function closestPointOnSegment(p: Point, a: Point, b: Point): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { x: a.x, y: a.y };
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2),
  );
  return { x: a.x + t * dx, y: a.y + t * dy };
}

function onSegment(p: Point, a: Point, b: Point): boolean {
  const q = closestPointOnSegment(p, a, b);
  return (
    Math.abs(q.x - p.x) <= EDGE_EPSILON && Math.abs(q.y - p.y) <= EDGE_EPSILON
  );
}
