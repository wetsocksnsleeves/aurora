import type { Clip, Point } from "@/lib/types";
import { fadeEnvelope } from "@/lib/compile";
import { activeClips, clipPolygonAt, isClipActive } from "./clips";
import { toPx, type Size } from "./geometry";
import { COLORS, tracePolygon } from "./draw";
import type { CanvasLayer } from "./layers";
import type { EditorState } from "./store";

/** Opacity of a clip at full brightness in the overlay. */
const OVERLAY_ALPHA = 0.55;

/**
 * Fill or stroke a clip as positioned at `tMs`. A fill clip covers every
 * venue shape (each painted on its own, so overlapping shapes stay lit), or
 * the whole canvas when there is no venue yet. Polygons use the even-odd
 * rule, matching the ray-casting test in `lib/compile.ts`.
 */
function paintClip(
  ctx: CanvasRenderingContext2D,
  state: EditorState,
  clip: Clip,
  tMs: number,
  size: Size,
  mode: "fill" | "stroke",
): void {
  const points = clipPolygonAt(clip, tMs);
  const paint = () => (mode === "fill" ? ctx.fill("evenodd") : ctx.stroke());
  if (points) {
    tracePolygon(ctx, points, size);
    paint();
    return;
  }
  const shapes = state.show.venue.shapes;
  if (shapes.length === 0) {
    ctx.beginPath();
    ctx.rect(0, 0, size.width, size.height);
    paint();
    return;
  }
  for (const shape of shapes) {
    tracePolygon(ctx, shape.points, size);
    paint();
  }
}

/**
 * Clips active at the playhead, drawn translucent bottom to top, with moving
 * shapes at their interpolated position and fades applied. The selected clip
 * is outlined (dashed when the playhead is outside it), and a selected moving
 * shape also shows where it ends.
 */
export const clipOverlayLayer: CanvasLayer = {
  id: "clipOverlay",
  draw({ ctx, size, state }) {
    const t = state.currentTimeMs;
    for (const clip of activeClips(state.show.clips, t)) {
      ctx.globalAlpha = OVERLAY_ALPHA * fadeEnvelope(clip, t);
      ctx.fillStyle = clip.color;
      paintClip(ctx, state, clip, t, size, "fill");
    }
    ctx.globalAlpha = 1;

    const selection = state.selection;
    if (selection?.kind !== "clip") return;
    const clip = state.show.clips.find((c) => c.id === selection.id);
    if (!clip) return;
    const active = isClipActive(clip, t);
    ctx.strokeStyle = COLORS.selected;
    ctx.lineWidth = 2;
    if (!active) ctx.setLineDash([6, 4]);
    // Outside its time range, outline where the clip starts.
    paintClip(ctx, state, clip, active ? t : clip.startMs, size, "stroke");
    if (clip.shape.kind === "polygon" && clip.shape.moveTo) {
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      paintClip(ctx, state, clip, clip.endMs, size, "stroke");
    }
    ctx.setLineDash([]);
  },
};

function strokePath(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  size: Size,
  close: boolean,
): void {
  ctx.beginPath();
  points.forEach((p, i) => {
    const { x, y } = toPx(p, size);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  if (close) ctx.closePath();
  ctx.stroke();
}

function centroid(points: Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  return { x: x / points.length, y: y / points.length };
}

/** In-progress clip drawings, in the current clip colour. */
export const clipDraftLayer: CanvasLayer = {
  id: "clipDraft",
  draw({ ctx, size, state }) {
    const draft = state.draft;
    if (!draft) return;
    ctx.lineWidth = 2;
    ctx.strokeStyle = state.clipColor;
    ctx.fillStyle = state.clipColor;
    switch (draft.kind) {
      case "clipRect": {
        const a = toPx(draft.from, size);
        const b = toPx(draft.to, size);
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
        break;
      }
      case "clipPolygon": {
        const points = draft.hover
          ? [...draft.points, draft.hover]
          : draft.points;
        ctx.setLineDash([6, 4]);
        strokePath(ctx, points, size, false);
        ctx.setLineDash([]);
        for (const p of draft.points) {
          const { x, y } = toPx(p, size);
          ctx.beginPath();
          ctx.arc(x, y, 3.5, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case "clipMove": {
        // Start position solid, end position dashed, an arrow between them.
        ctx.globalAlpha = 0.35;
        tracePolygon(ctx, draft.points, size);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.stroke();
        const { x: dx, y: dy } = draft.offset;
        if (dx === 0 && dy === 0) break;
        const moved = draft.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
        ctx.setLineDash([6, 4]);
        tracePolygon(ctx, moved, size);
        ctx.stroke();
        ctx.setLineDash([]);
        const from = toPx(centroid(draft.points), size);
        const to = toPx(centroid(moved), size);
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
        const angle = Math.atan2(to.y - from.y, to.x - from.x);
        ctx.beginPath();
        ctx.moveTo(to.x, to.y);
        ctx.lineTo(
          to.x - 10 * Math.cos(angle - 0.4),
          to.y - 10 * Math.sin(angle - 0.4),
        );
        ctx.lineTo(
          to.x - 10 * Math.cos(angle + 0.4),
          to.y - 10 * Math.sin(angle + 0.4),
        );
        ctx.closePath();
        ctx.fill();
        break;
      }
      case "brush":
        strokePath(ctx, draft.points, size, false);
        break;
    }
    ctx.setLineDash([]);
  },
};
