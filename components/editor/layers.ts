import { clipDraftLayer, clipOverlayLayer } from "./clip-layers";
import { COLORS, tracePolygon } from "./draw";
import { toPx, type Size } from "./geometry";
import type { EditorState } from "./store";

/**
 * What a canvas layer gets each frame. The canvas redraws on every store
 * change, so a layer that reads time from `state` (chunk 12 adds
 * `currentTimeMs`) animates with the playhead for free.
 */
export type LayerContext = {
  ctx: CanvasRenderingContext2D;
  /** CSS pixels. The canvas transform already accounts for devicePixelRatio. */
  size: Size;
  state: EditorState;
};

export type CanvasLayer = {
  id: string;
  draw(layer: LayerContext): void;
};

export { COLORS, tracePolygon };

export const backgroundLayer: CanvasLayer = {
  id: "background",
  draw({ ctx, size }) {
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, size.width, size.height);
    // A 10 x 10 guide grid in venue coordinates.
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 10; i++) {
      const x = Math.round((i / 10) * size.width) + 0.5;
      const y = Math.round((i / 10) * size.height) + 0.5;
      ctx.moveTo(x, 0);
      ctx.lineTo(x, size.height);
      ctx.moveTo(0, y);
      ctx.lineTo(size.width, y);
    }
    ctx.stroke();
  },
};

export const venueLayer: CanvasLayer = {
  id: "venue",
  draw({ ctx, size, state }) {
    ctx.lineWidth = 1.5;
    for (const shape of state.show.venue.shapes) {
      tracePolygon(ctx, shape.points, size);
      ctx.fillStyle = COLORS.venueFill;
      ctx.fill();
      ctx.strokeStyle = COLORS.venueStroke;
      ctx.stroke();
    }
  },
};

export const selectionLayer: CanvasLayer = {
  id: "selection",
  draw({ ctx, size, state }) {
    const selection = state.selection;
    if (selection?.kind !== "venueShape") return;
    const shape = state.show.venue.shapes.find((s) => s.id === selection.id);
    if (!shape) return;
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLORS.selected;
    tracePolygon(ctx, shape.points, size);
    ctx.stroke();
    ctx.fillStyle = COLORS.selected;
    for (const p of shape.points) {
      const { x, y } = toPx(p, size);
      ctx.fillRect(x - 3, y - 3, 6, 6);
    }
  },
};

export const draftLayer: CanvasLayer = {
  id: "draft",
  draw({ ctx, size, state }) {
    const draft = state.draft;
    if (!draft) return;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = COLORS.draft;
    ctx.fillStyle = COLORS.draft;
    ctx.setLineDash([6, 4]);
    if (draft.kind === "rect") {
      const a = toPx(draft.from, size);
      const b = toPx(draft.to, size);
      ctx.strokeRect(a.x, a.y, b.x - a.x, b.y - a.y);
    } else if (draft.kind === "polygon") {
      const points = draft.hover
        ? [...draft.points, draft.hover]
        : draft.points;
      ctx.beginPath();
      points.forEach((p, i) => {
        const { x, y } = toPx(p, size);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
      for (const p of draft.points) {
        const { x, y } = toPx(p, size);
        ctx.beginPath();
        ctx.arc(x, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.setLineDash([]);
  },
};

/**
 * Layers bottom to top: the clip overlay (clip-layers.ts) sits on the venue,
 * under the venue selection and drafts. Chunk 14 adds its preview dots after
 * the clip overlay. The editor passes the list to `<VenueCanvas layers>`.
 */
export const DEFAULT_LAYERS: CanvasLayer[] = [
  backgroundLayer,
  venueLayer,
  clipOverlayLayer,
  selectionLayer,
  draftLayer,
  clipDraftLayer,
];
