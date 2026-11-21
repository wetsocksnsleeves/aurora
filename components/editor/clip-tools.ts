import type { ClipShape, Point } from "@/lib/types";
import { brushPolygon, makeClip } from "./clips";
import {
  CLOSE_POLYGON_PX,
  MIN_RECT_PX,
  pxDistance,
  rectFromCorners,
  signedArea2,
  type Size,
} from "./geometry";
import { newId, type Draft, type EditorStore, type ToolId } from "./store";
import type { ToolHandler } from "./tools";

/**
 * Clip tools (SPEC 2.1): each drawing becomes a clip that starts at the
 * playhead, lasts `DEFAULT_CLIP_MS`, sits on the top layer and uses the
 * current colour (`makeClip`).
 */

/** Brush strokes are simplified to within this many pixels of the stroke. */
export const BRUSH_TOLERANCE_PX = 2;
/** Brush points closer than this to the previous point are skipped. */
const BRUSH_MIN_STEP_PX = 2;

function addClip(store: EditorStore, shape: ClipShape): void {
  const state = store.getState();
  const clip = makeClip(
    {
      clips: state.show.clips,
      currentTimeMs: state.currentTimeMs,
      snap: state.snap,
      durationMs: state.show.audio.durationMs,
      color: state.clipColor,
    },
    shape,
    newId("clip"),
  );
  store.dispatch({ type: "addClip", clip });
}

function setDraft(store: EditorStore, draft: Draft | null): void {
  store.dispatch({ type: "setDraft", draft });
}

/**
 * A finished outline: a shape clip right away, or for the moving-shape tool
 * the `clipMove` step that waits for the end position.
 */
function finishOutline(
  store: EditorStore,
  points: Point[],
  moving: boolean,
): void {
  if (moving) {
    setDraft(store, {
      kind: "clipMove",
      points,
      origin: null,
      offset: { x: 0, y: 0 },
    });
    return;
  }
  setDraft(store, null);
  addClip(store, { kind: "polygon", points });
}

function finishClipPolygon(store: EditorStore): void {
  const draft = store.getState().draft;
  if (draft?.kind !== "clipPolygon") return;
  if (draft.points.length < 3 || Math.abs(signedArea2(draft.points)) < 1e-9) {
    setDraft(store, null);
    return;
  }
  finishOutline(store, draft.points, draft.moving);
}

/**
 * Shared by the shape and moving-shape tools: drag to draw a rectangle, or
 * click points to draw a polygon (closed by clicking the first point,
 * double-clicking or Enter). The moving-shape tool then takes a second drag
 * for the offset the shape travels by `endMs`.
 */
function outlineTool(moving: boolean): ToolHandler {
  const tool: ToolHandler = {
    label: moving ? "Moving shape" : "Shape",
    shortcut: moving ? "m" : "s",
    cursor: "crosshair",
    hint: moving
      ? "Drag a rectangle or click polygon points, then drag to where the shape ends up. Esc cancels."
      : "Drag a rectangle, or click to add polygon points (click the first point, double-click or Enter to close). Esc cancels.",
    onPointerDown({ point, clickCount }, { store, size }) {
      const draft = store.getState().draft;
      if (draft?.kind === "clipMove") {
        setDraft(store, { ...draft, origin: point, offset: { x: 0, y: 0 } });
        return;
      }
      if (draft?.kind === "clipPolygon") {
        const closesOnFirst =
          draft.points.length >= 3 &&
          pxDistance(point, draft.points[0], size) <= CLOSE_POLYGON_PX;
        if (clickCount >= 2 || closesOnFirst) {
          finishClipPolygon(store);
          return;
        }
        setDraft(store, {
          ...draft,
          points: [...draft.points, point],
          hover: point,
        });
        return;
      }
      setDraft(store, { kind: "clipRect", from: point, to: point, moving });
    },
    onPointerMove({ point }, { store }) {
      const draft = store.getState().draft;
      if (draft?.kind === "clipRect") {
        setDraft(store, { ...draft, to: point });
      } else if (draft?.kind === "clipPolygon") {
        setDraft(store, { ...draft, hover: point });
      } else if (draft?.kind === "clipMove" && draft.origin) {
        setDraft(store, {
          ...draft,
          offset: { x: point.x - draft.origin.x, y: point.y - draft.origin.y },
        });
      }
    },
    onPointerUp(pointer, ctx) {
      const { store, size } = ctx;
      const draft = store.getState().draft;
      if (draft?.kind === "clipRect") {
        const { point } = pointer;
        if (isRectDrag(draft.from, point, size)) {
          finishOutline(store, rectFromCorners(draft.from, point), moving);
        } else {
          // A click, not a drag: start a polygon at the clicked point.
          setDraft(store, {
            kind: "clipPolygon",
            points: [draft.from],
            hover: point,
            moving,
          });
        }
        return;
      }
      if (draft?.kind === "clipMove" && draft.origin) {
        tool.onPointerMove?.(pointer, ctx);
        const done = store.getState().draft;
        if (done?.kind !== "clipMove") return;
        setDraft(store, null);
        const { x, y } = done.offset;
        addClip(
          store,
          x === 0 && y === 0
            ? { kind: "polygon", points: done.points }
            : { kind: "polygon", points: done.points, moveTo: { x, y } },
        );
      }
    },
    onKeyDown(key, { store }) {
      const draft = store.getState().draft;
      if (
        draft?.kind !== "clipRect" &&
        draft?.kind !== "clipPolygon" &&
        draft?.kind !== "clipMove"
      )
        return false;
      if (key === "Escape") {
        setDraft(store, null);
        return true;
      }
      if (draft.kind !== "clipPolygon") return false;
      if (key === "Enter") {
        finishClipPolygon(store);
        return true;
      }
      if (key === "Backspace" || key === "Delete") {
        const points = draft.points.slice(0, -1);
        setDraft(store, points.length === 0 ? null : { ...draft, points });
        return true;
      }
      return false;
    },
  };
  return tool;
}

function isRectDrag(from: Point, to: Point, size: Size): boolean {
  return (
    Math.abs(to.x - from.x) * size.width >= MIN_RECT_PX &&
    Math.abs(to.y - from.y) * size.height >= MIN_RECT_PX
  );
}

const fillTool: ToolHandler = {
  label: "Fill",
  shortcut: "f",
  cursor: "copy",
  hint: "Click the room to light every phone from the playhead.",
  onPointerDown(_pointer, { store }) {
    addClip(store, { kind: "fill" });
  },
};

const brushTool: ToolHandler = {
  label: "Brush",
  shortcut: "b",
  cursor: "crosshair",
  hint: "Draw a freehand outline. It closes into a shape when you let go.",
  onPointerDown({ point }, { store }) {
    setDraft(store, { kind: "brush", points: [point] });
  },
  onPointerMove({ point }, { store, size }) {
    const draft = store.getState().draft;
    if (draft?.kind !== "brush") return;
    const last = draft.points[draft.points.length - 1];
    if (pxDistance(point, last, size) < BRUSH_MIN_STEP_PX) return;
    setDraft(store, { ...draft, points: [...draft.points, point] });
  },
  onPointerUp(pointer, ctx) {
    const { store, size } = ctx;
    if (store.getState().draft?.kind !== "brush") return;
    brushTool.onPointerMove?.(pointer, ctx);
    const draft = store.getState().draft;
    setDraft(store, null);
    if (draft?.kind !== "brush") return;
    const epsilon = BRUSH_TOLERANCE_PX / Math.max(1, size.width, size.height);
    const points = brushPolygon(draft.points, epsilon);
    if (points) addClip(store, { kind: "polygon", points });
  },
};

export const clipToolHandlers: Record<
  Extract<ToolId, "fill" | "shape" | "moving" | "brush">,
  ToolHandler
> = {
  fill: fillTool,
  shape: outlineTool(false),
  moving: outlineTool(true),
  brush: brushTool,
};
