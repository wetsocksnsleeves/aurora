import type { Point } from "@/lib/types";
import { clipToolHandlers } from "./clip-tools";
import {
  CLOSE_POLYGON_PX,
  MIN_RECT_PX,
  hitTestShapes,
  pxDistance,
  rectFromCorners,
  signedArea2,
  translatePolygon,
  type Size,
} from "./geometry";
import { newId, type EditorStore, type ToolId } from "./store";

/** A pointer event translated into venue coordinates. */
export type ToolPointer = {
  /** Normalised 0..1, clamped to the venue. */
  point: Point;
  /** Click count from the DOM event: 2 on the second click of a double click. */
  clickCount: number;
  shiftKey: boolean;
};

export type ToolContext = {
  store: EditorStore;
  /** Current canvas size in CSS pixels, for pixel tolerances. */
  size: Size;
};

/**
 * A canvas tool. The canvas forwards pointer and key events to the active
 * tool. Handlers read and write the store only, so they can be tested without
 * a DOM. `onKeyDown` returns true when it handled the key.
 */
export type ToolHandler = {
  label: string;
  /** Keyboard shortcut that selects the tool. */
  shortcut: string;
  cursor: string;
  hint: string;
  onPointerDown?(pointer: ToolPointer, ctx: ToolContext): void;
  onPointerMove?(pointer: ToolPointer, ctx: ToolContext): void;
  onPointerUp?(pointer: ToolPointer, ctx: ToolContext): void;
  onKeyDown?(key: string, ctx: ToolContext): boolean;
};

export { CLOSE_POLYGON_PX, MIN_RECT_PX };

const selectTool: ToolHandler = {
  label: "Select",
  shortcut: "v",
  cursor: "default",
  hint: "Click a shape to select it, drag to move it. Delete removes it.",
  onPointerDown({ point }, { store, size }) {
    const { shapes } = store.getState().show.venue;
    const id = hitTestShapes(shapes, point, size);
    if (!id) {
      store.dispatch({ type: "select", selection: null });
      return;
    }
    const shape = shapes.find((s) => s.id === id);
    store.dispatch({ type: "select", selection: { kind: "venueShape", id } });
    if (shape) {
      store.dispatch({
        type: "setDraft",
        draft: { kind: "moveShape", id, origin: point, original: shape.points },
      });
    }
  },
  onPointerMove({ point }, { store }) {
    const draft = store.getState().draft;
    if (draft?.kind !== "moveShape") return;
    store.dispatch({
      type: "setVenueShapePoints",
      id: draft.id,
      points: translatePolygon(
        draft.original,
        point.x - draft.origin.x,
        point.y - draft.origin.y,
      ),
    });
  },
  onPointerUp(pointer, ctx) {
    if (ctx.store.getState().draft?.kind !== "moveShape") return;
    selectTool.onPointerMove?.(pointer, ctx);
    ctx.store.dispatch({ type: "setDraft", draft: null });
  },
};

const rectTool: ToolHandler = {
  label: "Rectangle",
  shortcut: "r",
  cursor: "crosshair",
  hint: "Drag to draw a rectangle.",
  onPointerDown({ point }, { store }) {
    store.dispatch({
      type: "setDraft",
      draft: { kind: "rect", from: point, to: point },
    });
  },
  onPointerMove({ point }, { store }) {
    const draft = store.getState().draft;
    if (draft?.kind !== "rect") return;
    store.dispatch({ type: "setDraft", draft: { ...draft, to: point } });
  },
  onPointerUp({ point }, { store, size }) {
    const draft = store.getState().draft;
    if (draft?.kind !== "rect") return;
    store.dispatch({ type: "setDraft", draft: null });
    const width = Math.abs(point.x - draft.from.x) * size.width;
    const height = Math.abs(point.y - draft.from.y) * size.height;
    if (width < MIN_RECT_PX || height < MIN_RECT_PX) return;
    store.dispatch({
      type: "addVenueShape",
      shape: { id: newId("shape"), points: rectFromCorners(draft.from, point) },
    });
  },
};

function finishPolygon(ctx: ToolContext): void {
  const draft = ctx.store.getState().draft;
  if (draft?.kind !== "polygon") return;
  ctx.store.dispatch({ type: "setDraft", draft: null });
  // Ignore polygons that enclose nothing.
  if (draft.points.length < 3 || Math.abs(signedArea2(draft.points)) < 1e-9)
    return;
  ctx.store.dispatch({
    type: "addVenueShape",
    shape: { id: newId("shape"), points: draft.points },
  });
}

const polygonTool: ToolHandler = {
  label: "Polygon",
  shortcut: "p",
  cursor: "crosshair",
  hint: "Click to add points. Click the first point, double-click or press Enter to close. Esc cancels.",
  onPointerDown({ point, clickCount }, ctx) {
    const draft = ctx.store.getState().draft;
    if (draft?.kind !== "polygon") {
      ctx.store.dispatch({
        type: "setDraft",
        draft: { kind: "polygon", points: [point], hover: point },
      });
      return;
    }
    // The second click of a double click lands on the point the first click
    // just added, so it closes the polygon instead of adding a duplicate.
    const closesOnFirst =
      draft.points.length >= 3 &&
      pxDistance(point, draft.points[0], ctx.size) <= CLOSE_POLYGON_PX;
    if (clickCount >= 2 || closesOnFirst) {
      finishPolygon(ctx);
      return;
    }
    ctx.store.dispatch({
      type: "setDraft",
      draft: { ...draft, points: [...draft.points, point], hover: point },
    });
  },
  onPointerMove({ point }, { store }) {
    const draft = store.getState().draft;
    if (draft?.kind !== "polygon") return;
    store.dispatch({ type: "setDraft", draft: { ...draft, hover: point } });
  },
  onKeyDown(key, ctx) {
    const draft = ctx.store.getState().draft;
    if (draft?.kind !== "polygon") return false;
    if (key === "Enter") {
      finishPolygon(ctx);
      return true;
    }
    if (key === "Escape") {
      ctx.store.dispatch({ type: "setDraft", draft: null });
      return true;
    }
    if (key === "Backspace" || key === "Delete") {
      const points = draft.points.slice(0, -1);
      ctx.store.dispatch({
        type: "setDraft",
        draft: points.length === 0 ? null : { ...draft, points },
      });
      return true;
    }
    return false;
  },
};

/** Tools by id. The toolbar lists every entry in `TOOL_ORDER`. */
export const toolHandlers: Record<ToolId, ToolHandler> = {
  select: selectTool,
  rect: rectTool,
  polygon: polygonTool,
  ...clipToolHandlers,
};

/** Tools that edit the venue outline. */
export const VENUE_TOOLS: ToolId[] = ["select", "rect", "polygon"];
/** Tools that draw clips at the playhead (chunk 13). */
export const CLIP_TOOLS: ToolId[] = ["fill", "shape", "moving", "brush"];
export const TOOL_ORDER: ToolId[] = [...VENUE_TOOLS, ...CLIP_TOOLS];
