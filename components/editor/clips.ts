import type { Clip, ClipShape, Point } from "@/lib/types";
import { snapStepMs, snapTime, type SnapSettings } from "./snap";

/**
 * Pure clip helpers for the editor (SPEC 2.1, 3.2): creating clips at the
 * playhead, moving-shape interpolation, brush simplification, timeline drags
 * and lane stacking. Shared by the tools, the canvas layers and the clip lane.
 */

/** Length of a newly drawn clip. */
export const DEFAULT_CLIP_MS = 1000;
/** Shortest clip when snapping is off. With snapping on, one grid step. */
export const MIN_CLIP_MS = 10;
export const DEFAULT_CLIP_COLOR = "#ffffff";
/** Matches the server's limit on polygon points (server/show-validation.ts). */
export const MAX_CLIP_POINTS = 500;

/** The layer above every existing clip, or 0 for the first clip. */
export function topLayer(clips: readonly Clip[]): number {
  let top = -1;
  for (const clip of clips) top = Math.max(top, clip.layer);
  return top + 1;
}

/** The shortest a clip may be under the current snap setting. */
export function minClipMs(snap: SnapSettings): number {
  return snapStepMs(snap) ?? MIN_CLIP_MS;
}

/**
 * Start and end of a clip drawn with the playhead at `playheadMs`: from the
 * snapped playhead, `DEFAULT_CLIP_MS` long, kept inside the audio. Near the
 * end of the audio the clip is shifted left so it keeps its length.
 */
export function newClipTiming(
  playheadMs: number,
  snap: SnapSettings,
  durationMs: number,
): { startMs: number; endMs: number } {
  let startMs = snapTime(playheadMs, snap, durationMs);
  let endMs = snapTime(startMs + DEFAULT_CLIP_MS, snap, durationMs);
  if (durationMs > 0 && endMs - startMs < DEFAULT_CLIP_MS) {
    startMs = snapTime(Math.max(0, durationMs - DEFAULT_CLIP_MS), snap);
    endMs = durationMs;
  }
  // Audio shorter than one grid step: ignore the grid.
  if (endMs <= startMs) endMs = startMs + DEFAULT_CLIP_MS;
  return { startMs, endMs };
}

export type NewClipInput = {
  clips: readonly Clip[];
  currentTimeMs: number;
  snap: SnapSettings;
  durationMs: number;
  color: string;
};

/** A new clip at the playhead, on the top layer, in the current colour. */
export function makeClip(
  input: NewClipInput,
  shape: ClipShape,
  id: string,
): Clip {
  return {
    id,
    layer: topLayer(input.clips),
    ...newClipTiming(input.currentTimeMs, input.snap, input.durationMs),
    color: input.color,
    fadeInMs: 0,
    fadeOutMs: 0,
    shape,
  };
}

/**
 * Progress through a clip in 0..1, as `lib/compile.ts` computes it for
 * moving shapes: `(t - startMs) / (endMs - startMs)`.
 */
export function clipProgress(clip: Clip, tMs: number): number {
  const length = clip.endMs - clip.startMs;
  if (length <= 0) return 0;
  return Math.min(1, Math.max(0, (tMs - clip.startMs) / length));
}

/** How far a moving shape has moved at `tMs`: `moveTo * progress`. */
export function clipOffsetAt(clip: Clip, tMs: number): Point {
  const move = clip.shape.kind === "polygon" ? clip.shape.moveTo : undefined;
  if (!move) return { x: 0, y: 0 };
  const f = clipProgress(clip, tMs);
  return { x: move.x * f, y: move.y * f };
}

/** A polygon clip's points as positioned at `tMs`. Null for fill clips. */
export function clipPolygonAt(clip: Clip, tMs: number): Point[] | null {
  if (clip.shape.kind !== "polygon") return null;
  const d = clipOffsetAt(clip, tMs);
  if (d.x === 0 && d.y === 0) return clip.shape.points;
  return clip.shape.points.map((p) => ({ x: p.x + d.x, y: p.y + d.y }));
}

export function isClipActive(clip: Clip, tMs: number): boolean {
  return tMs >= clip.startMs && tMs < clip.endMs;
}

/**
 * Clips active at `tMs`, bottom to top: by layer, and on equal layers in list
 * order, the same stacking `lib/compile.ts` uses.
 */
export function activeClips(clips: readonly Clip[], tMs: number): Clip[] {
  return clips
    .map((clip, index) => ({ clip, index }))
    .filter(({ clip }) => isClipActive(clip, tMs))
    .sort((a, b) => a.clip.layer - b.clip.layer || a.index - b.index)
    .map(({ clip }) => clip);
}

const PATTERN_LABELS = {
  wave: "Wave",
  split: "Split",
  chase: "Chase",
  sparkle: "Sparkle",
} as const;

export function clipKindLabel(clip: Clip): string {
  if (clip.label) return clip.label;
  const shape = clip.shape;
  if (shape.kind === "fill") return "Fill";
  if (shape.kind === "pattern") return PATTERN_LABELS[shape.pattern];
  if (shape.kind === "image") return "Image";
  return shape.moveTo ? "Moving shape" : "Shape";
}

/**
 * The lowest layer, from `from` up, with no clip overlapping
 * [startMs, endMs) other than `ignoreId`. Timeline tracks are layers.
 */
export function freeLayer(
  clips: readonly Clip[],
  startMs: number,
  endMs: number,
  from = 0,
  ignoreId?: string,
): number {
  for (let layer = Math.max(0, from); ; layer++) {
    const taken = clips.some(
      (c) =>
        c.id !== ignoreId &&
        c.layer === layer &&
        c.startMs < endMs &&
        startMs < c.endMs,
    );
    if (!taken) return layer;
  }
}

/**
 * Cut `clip` in two at `tMs`. The halves join without a fade at the cut,
 * and a moving shape or a travelling pattern carries on from where the first
 * half stopped. Null when `tMs` isn't inside the clip.
 */
export function splitClip(
  clip: Clip,
  tMs: number,
  secondId: string,
): [Clip, Clip] | null {
  if (!(tMs > clip.startMs && tMs < clip.endMs)) return null;
  const f = clipProgress(clip, tMs);
  const first: Clip = { ...clip, endMs: tMs, fadeOutMs: 0 };
  const second: Clip = { ...clip, id: secondId, startMs: tMs, fadeInMs: 0 };
  first.fadeInMs = Math.min(clip.fadeInMs, tMs - clip.startMs);
  second.fadeOutMs = Math.min(clip.fadeOutMs, clip.endMs - tMs);
  const shape = clip.shape;
  if (shape.kind === "polygon" && shape.moveTo) {
    const m = shape.moveTo;
    first.shape = { ...shape, moveTo: { x: m.x * f, y: m.y * f } };
    second.shape = {
      kind: "polygon",
      points: shape.points.map((p) => ({ x: p.x + m.x * f, y: p.y + m.y * f })),
      moveTo: { x: m.x * (1 - f), y: m.y * (1 - f) },
    };
  } else if (shape.kind === "pattern") {
    const mid = shape.from + (shape.to - shape.from) * f;
    first.shape = { ...shape, to: mid };
    second.shape = { ...shape, from: mid };
  }
  return [first, second];
}

/**
 * Snap `tMs` to the nearest of `targets` (clip edges, the playhead) within
 * `toleranceMs`, else return null.
 */
export function snapToTargets(
  tMs: number,
  targets: readonly number[],
  toleranceMs: number,
): number | null {
  let best: number | null = null;
  for (const t of targets) {
    const d = Math.abs(t - tMs);
    if (d <= toleranceMs && (best === null || d < Math.abs(best - tMs))) {
      best = t;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Brush

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.min(
    1,
    Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq),
  );
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Ramer–Douglas–Peucker: drops points that lie within `epsilon` of the line
 * through their neighbours. Keeps the first and last point.
 */
export function simplifyPath(
  points: readonly Point[],
  epsilon: number,
): Point[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  // Iterative, so long strokes cannot overflow the stack.
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    let maxDist = -1;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const d = distanceToSegment(points[i], points[first], points[last]);
      if (d > maxDist) {
        maxDist = d;
        index = i;
      }
    }
    if (index !== -1 && maxDist > epsilon) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/** Twice the signed area of a closed polygon. */
function area2(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    sum += (points[j].x - points[i].x) * (points[j].y + points[i].y);
  }
  return sum;
}

/**
 * Turns a freehand stroke into a clip polygon: simplified with tolerance
 * `epsilon` (normalised units), closed (a polygon's last point joins its
 * first), and at most `maxPoints` points. Returns null for a stroke that
 * encloses nothing.
 */
export function brushPolygon(
  stroke: readonly Point[],
  epsilon: number,
  maxPoints = MAX_CLIP_POINTS,
): Point[] | null {
  let points = simplifyPath(stroke, epsilon);
  for (let e = epsilon * 2; points.length > maxPoints; e *= 2) {
    points = simplifyPath(stroke, e);
  }
  // The stroke usually ends near where it started; the closing edge covers
  // that gap, so a duplicate end point is dropped.
  if (points.length > 3) {
    const a = points[0];
    const b = points[points.length - 1];
    if (Math.hypot(a.x - b.x, a.y - b.y) <= epsilon)
      points = points.slice(0, -1);
  }
  if (points.length < 3) return null;
  if (Math.abs(area2(points)) < 1e-6) return null;
  return points;
}

// ---------------------------------------------------------------------------
// Editing

/** A change to a clip from the inspector or the timeline. */
export type ClipPatch = Partial<Omit<Clip, "id">>;

/**
 * Applies `patch` and repairs the result: times not negative, the end after
 * the start, fades not negative, layer a whole number.
 */
export function patchClip(
  clip: Clip,
  patch: ClipPatch,
  minLengthMs = MIN_CLIP_MS,
): Clip {
  const next = { ...clip, ...patch };
  const finite = (v: number, fallback: number) =>
    Number.isFinite(v) ? v : fallback;
  next.startMs = Math.max(0, finite(next.startMs, clip.startMs));
  next.endMs = finite(next.endMs, clip.endMs);
  if (next.endMs - next.startMs < minLengthMs) {
    // Keep whichever side the patch did not touch.
    if (patch.startMs !== undefined && patch.endMs === undefined) {
      next.startMs = Math.max(0, next.endMs - minLengthMs);
      if (next.endMs - next.startMs < minLengthMs)
        next.endMs = next.startMs + minLengthMs;
    } else {
      next.endMs = next.startMs + minLengthMs;
    }
  }
  next.fadeInMs = Math.max(0, finite(next.fadeInMs, clip.fadeInMs));
  next.fadeOutMs = Math.max(0, finite(next.fadeOutMs, clip.fadeOutMs));
  next.layer = Math.round(finite(next.layer, clip.layer));
  return next;
}

export type ClipDragMode = "move" | "start" | "end";

/**
 * New start and end for a timeline drag of `deltaMs` from `original`.
 * "move" keeps the length; "start" and "end" move one handle. Times snap to
 * the grid and stay inside [0, durationMs] (no upper bound while the duration
 * is unknown).
 */
export function dragClipTiming(
  original: Pick<Clip, "startMs" | "endMs">,
  mode: ClipDragMode,
  deltaMs: number,
  snap: SnapSettings,
  durationMs: number,
): { startMs: number; endMs: number } {
  const { startMs, endMs } = original;
  const minLength = minClipMs(snap);
  const max = durationMs > 0 ? durationMs : Infinity;
  if (mode === "move") {
    const length = endMs - startMs;
    let start = snapTime(startMs + deltaMs, snap);
    start = Math.max(0, Math.min(start, max - length));
    return { startMs: start, endMs: start + length };
  }
  if (mode === "start") {
    const start = snapTime(startMs + deltaMs, snap, durationMs);
    return { startMs: Math.max(0, Math.min(start, endMs - minLength)), endMs };
  }
  const end = snapTime(endMs + deltaMs, snap, durationMs);
  return { startMs, endMs: Math.min(max, Math.max(end, startMs + minLength)) };
}

/**
 * Lane rows for drawing clips as bars: each clip sits one row above every
 * earlier-stacked clip it overlaps in time, so of two overlapping clips the
 * one that draws on top is higher in the lane. Non-overlapping clips share
 * row 0. Returns a row per clip id and the number of rows.
 */
export function laneRows(clips: readonly Clip[]): {
  rows: Map<string, number>;
  count: number;
} {
  const ordered = clips
    .map((clip, index) => ({ clip, index }))
    .sort((a, b) => a.clip.layer - b.clip.layer || a.index - b.index);
  const rows = new Map<string, number>();
  const placed: { clip: Clip; row: number }[] = [];
  let count = 0;
  for (const { clip } of ordered) {
    let row = 0;
    for (const p of placed) {
      if (p.clip.startMs < clip.endMs && clip.startMs < p.clip.endMs) {
        row = Math.max(row, p.row + 1);
      }
    }
    placed.push({ clip, row });
    rows.set(clip.id, row);
    count = Math.max(count, row + 1);
  }
  return { rows, count };
}

/** Black or white, whichever reads better on `color` (#rrggbb). */
export function contrastText(color: string): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return "#ffffff";
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#0b0b10" : "#ffffff";
}
