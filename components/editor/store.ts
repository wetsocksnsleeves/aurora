import type { Point, Show, Venue } from "@/lib/types";

/**
 * Editor state: one reducer, one store. Everything the editor shows is derived
 * from `EditorState`, and every change goes through `editorReducer`, so it can
 * be tested without a browser.
 *
 * Extending (chunks 13 and 14): add members to `ToolId`, `Selection`, `Draft`
 * and `EditorAction`, handle them in `editorReducer`, and register tools in
 * `tools.ts` and canvas layers in `layers.ts`.
 */

export type ToolId = "select" | "rect" | "polygon";

export type Selection = { kind: "venueShape"; id: string } | null;

/** An in-progress drawing or drag. Rendered by the draft layer. */
export type Draft =
  | { kind: "rect"; from: Point; to: Point }
  | { kind: "polygon"; points: Point[]; hover: Point | null }
  | { kind: "moveShape"; id: string; origin: Point; original: Point[] };

export type SaveStatus = "idle" | "saving" | "saved" | "error";

export type EditorState = {
  /** The working copy of the show. Saved through the API as a whole. */
  show: Show;
  /** Bumped by every action that changes `show`. */
  revision: number;
  /** The revision last written to the server. `revision !== savedRevision` means unsaved changes. */
  savedRevision: number;
  saveStatus: SaveStatus;
  saveError: string | null;
  tool: ToolId;
  selection: Selection;
  draft: Draft | null;
};

export type EditorAction =
  | { type: "renameShow"; name: string }
  | { type: "setTool"; tool: ToolId }
  | { type: "select"; selection: Selection }
  | { type: "setDraft"; draft: Draft | null }
  | { type: "addVenueShape"; shape: Venue["shapes"][number] }
  | { type: "setVenueShapePoints"; id: string; points: Point[] }
  | { type: "deleteVenueShape"; id: string }
  /** Delete whatever `selection` points at. */
  | { type: "deleteSelection" }
  | { type: "saveStarted" }
  /** `revision` is the revision that was sent, `show` is the server's reply. */
  | { type: "saveSucceeded"; revision: number; show: Show }
  | { type: "saveFailed"; error: string };

export function initialEditorState(show: Show): EditorState {
  return {
    show,
    revision: 0,
    savedRevision: 0,
    saveStatus: "idle",
    saveError: null,
    tool: "select",
    selection: null,
    draft: null,
  };
}

export function isDirty(state: EditorState): boolean {
  return state.revision !== state.savedRevision;
}

function withShow(state: EditorState, show: Show): EditorState {
  return { ...state, show, revision: state.revision + 1 };
}

function withVenue(state: EditorState, shapes: Venue["shapes"]): EditorState {
  return withShow(state, {
    ...state.show,
    venue: { ...state.show.venue, shapes },
  });
}

export function editorReducer(
  state: EditorState,
  action: EditorAction,
): EditorState {
  switch (action.type) {
    case "renameShow":
      if (action.name === state.show.name) return state;
      return withShow(state, { ...state.show, name: action.name });

    case "setTool":
      return { ...state, tool: action.tool, draft: null };

    case "select":
      return { ...state, selection: action.selection };

    case "setDraft":
      return { ...state, draft: action.draft };

    case "addVenueShape":
      return {
        ...withVenue(state, [...state.show.venue.shapes, action.shape]),
        selection: { kind: "venueShape", id: action.shape.id },
      };

    case "setVenueShapePoints": {
      const shapes = state.show.venue.shapes;
      if (!shapes.some((s) => s.id === action.id)) return state;
      return withVenue(
        state,
        shapes.map((s) =>
          s.id === action.id ? { ...s, points: action.points } : s,
        ),
      );
    }

    case "deleteVenueShape": {
      const shapes = state.show.venue.shapes;
      if (!shapes.some((s) => s.id === action.id)) return state;
      const next = withVenue(
        state,
        shapes.filter((s) => s.id !== action.id),
      );
      const selected =
        state.selection?.kind === "venueShape" &&
        state.selection.id === action.id;
      return selected ? { ...next, selection: null } : next;
    }

    case "deleteSelection": {
      const selection = state.selection;
      if (!selection) return state;
      switch (selection.kind) {
        case "venueShape":
          return editorReducer(state, {
            type: "deleteVenueShape",
            id: selection.id,
          });
      }
      return state;
    }

    case "saveStarted":
      return { ...state, saveStatus: "saving", saveError: null };

    case "saveSucceeded":
      // Keep local edits made while the request was in flight: only adopt the
      // server's timestamps, and only mark clean up to the revision sent.
      return {
        ...state,
        show: {
          ...state.show,
          createdAt: action.show.createdAt,
          updatedAt: action.show.updatedAt,
        },
        savedRevision: Math.max(state.savedRevision, action.revision),
        saveStatus: "saved",
        saveError: null,
      };

    case "saveFailed":
      return { ...state, saveStatus: "error", saveError: action.error };
  }
}

export type Listener = () => void;

export type EditorStore = {
  getState(): EditorState;
  dispatch(action: EditorAction): void;
  /** Called after every state change. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void;
};

/**
 * A minimal external store around `editorReducer`. React components read it
 * through `useEditorSelector` (store-context.tsx); canvas layers and the audio
 * engine subscribe directly, so per-frame updates do not re-render React.
 */
export function createEditorStore(initial: EditorState): EditorStore {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    getState: () => state,
    dispatch(action) {
      const next = editorReducer(state, action);
      if (next === state) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** A random id for new shapes and clips. Works on plain-HTTP LAN origins too. */
export function newId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${random}`;
}
