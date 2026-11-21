import type { Clip, Point, Show, Venue } from "@/lib/types";
import {
  DEFAULT_CLIP_COLOR,
  minClipMs,
  patchClip,
  splitClip,
  type ClipPatch,
} from "./clips";
import { DEFAULT_SNAP, snapTime, type SnapSettings } from "./snap";

/**
 * Editor state: one reducer, one store. Everything the editor shows is derived
 * from `EditorState`, and every change goes through `editorReducer`, so it can
 * be tested without a browser.
 *
 * Extending: add members to `ToolId`, `Selection`, `Draft` and
 * `EditorAction`, handle them in `editorReducer`, and register tools in
 * `tools.ts` and canvas layers in `layers.ts`. Clip helpers (timing, drags,
 * interpolation) live in `clips.ts`, clip tools in `clip-tools.ts`.
 */

export type ToolId =
  | "select"
  | "rect"
  | "polygon"
  // Clip tools (chunk 13).
  | "fill"
  | "shape"
  | "moving"
  | "brush";

export type Selection =
  { kind: "venueShape"; id: string } | { kind: "clip"; id: string } | null;

/** An in-progress drawing or drag. Rendered by the draft layer. */
export type Draft =
  | { kind: "rect"; from: Point; to: Point }
  | { kind: "polygon"; points: Point[]; hover: Point | null }
  | { kind: "moveShape"; id: string; origin: Point; original: Point[] }
  // Clip tools. `moving` drafts go on to a `clipMove` step once the shape is drawn.
  | { kind: "clipRect"; from: Point; to: Point; moving: boolean }
  | {
      kind: "clipPolygon";
      points: Point[];
      hover: Point | null;
      moving: boolean;
    }
  /** A drawn moving shape waiting for its end position: drag sets `offset`. */
  | { kind: "clipMove"; points: Point[]; origin: Point | null; offset: Point }
  | { kind: "brush"; points: Point[] };

export type SaveStatus = "idle" | "saving" | "saved" | "error";

/**
 * What the venue canvas shows for the playhead: translucent clip shapes, or
 * simulated seat dots coloured as phones would be (chunk 14).
 */
export type PreviewMode = "clips" | "dots";

/** Loading state of the waveform/audio engine, separate from `show.audio`. */
export type AudioStatus = "none" | "uploading" | "loading" | "ready" | "error";

/** Timeline zoom limits in pixels per second of audio. */
export const MIN_ZOOM_PX_PER_SEC = 5;
export const MAX_ZOOM_PX_PER_SEC = 1000;
export const DEFAULT_ZOOM_PX_PER_SEC = 20;

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
  /** Colour for newly drawn clips. */
  clipColor: string;
  previewMode: PreviewMode;

  // Timeline (chunk 12). The audio engine (Timeline.tsx) reports time with
  // `tick` and follows `seek`, `setPlaying` and `setZoom`. Anything that
  // animates with the playhead (clip overlay, preview) reads `currentTimeMs`.
  /** Playhead position in show time. */
  currentTimeMs: number;
  playing: boolean;
  /** Bumped by `seek`, so the audio engine can tell a seek request from its own ticks. */
  seekSeq: number;
  zoomPxPerSec: number;
  snap: SnapSettings;
  audioStatus: AudioStatus;
  audioError: string | null;

  // Undo (room editor). Earlier versions of `show`, newest last, and the
  // versions undone since the last edit, next first.
  past: Show[];
  future: Show[];
  /** The gesture of the last recorded edit: one drag is one undo step. */
  gesture: string | null;
};

/** Undo steps kept. */
export const MAX_UNDO = 100;

export type EditorAction =
  | { type: "renameShow"; name: string }
  | { type: "setTool"; tool: ToolId }
  | { type: "select"; selection: Selection }
  | { type: "setDraft"; draft: Draft | null }
  | { type: "addVenueShape"; shape: Venue["shapes"][number] }
  | { type: "setVenueShapePoints"; id: string; points: Point[] }
  | { type: "deleteVenueShape"; id: string }
  | { type: "setClipColor"; color: string }
  | { type: "setPreviewMode"; mode: PreviewMode }
  /** Appends a clip and selects it. */
  | { type: "addClip"; clip: Clip }
  /**
   * Changes a clip; times and fades are repaired (see `patchClip`). Edits
   * with the same `gesture` (one drag) undo as one step.
   */
  | { type: "updateClip"; id: string; patch: ClipPatch; gesture?: string }
  /** Appends clips (paste, effects) and selects `select`. */
  | { type: "addClips"; clips: Clip[]; select?: string }
  /** Replaces every clip, e.g. with a show made from the music. */
  | { type: "replaceClips"; clips: Clip[] }
  /** Cuts a clip in two at `atMs`; the second half gets `newId`. */
  | { type: "splitClip"; id: string; atMs: number; newId: string }
  /** Length of a show without music. */
  | { type: "setShowLength"; durationMs: number }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "deleteClip"; id: string }
  /**
   * One layer up or down. The clip also moves to the end (up) or start (down)
   * of the list, so it wins (or loses) against clips on the same layer.
   */
  | { type: "moveClipLayer"; id: string; direction: 1 | -1 }
  /** Delete whatever `selection` points at. */
  | { type: "deleteSelection" }
  | { type: "saveStarted" }
  /** `revision` is the revision that was sent, `show` is the server's reply. */
  | { type: "saveSucceeded"; revision: number; show: Show }
  | { type: "saveFailed"; error: string }
  /** From the audio engine while playing or after it moved the playhead. */
  | { type: "tick"; timeMs: number }
  /** Move the playhead. Clamped to the audio duration; not snapped (use `snapTime`). */
  | { type: "seek"; timeMs: number }
  | { type: "setPlaying"; playing: boolean }
  | { type: "setZoom"; pxPerSec: number }
  | { type: "setSnap"; snap: Partial<SnapSettings> }
  | { type: "setAudioStatus"; status: AudioStatus; error?: string }
  /** A new or re-measured audio file for the show. */
  | { type: "setShowAudio"; audio: Show["audio"] };

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
    clipColor: DEFAULT_CLIP_COLOR,
    previewMode: "clips",
    currentTimeMs: 0,
    playing: false,
    seekSeq: 0,
    zoomPxPerSec: DEFAULT_ZOOM_PX_PER_SEC,
    snap: DEFAULT_SNAP,
    audioStatus: show.audio.fileId ? "loading" : "none",
    audioError: null,
    past: [],
    future: [],
    gesture: null,
  };
}

/** Clamp to [0, duration]; no upper bound while the duration is unknown. */
export function clampToShow(state: EditorState, timeMs: number): number {
  return snapTime(
    timeMs,
    { ...DEFAULT_SNAP, mode: "off" },
    state.show.audio.durationMs,
  );
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

function withClips(state: EditorState, clips: Clip[]): EditorState {
  return withShow(state, { ...state.show, clips });
}

/**
 * Applies `action`, recording the show as it was for undo when the action
 * edited it. Measuring the audio (`setShowAudio`) isn't an edit.
 */
export function editorReducer(
  state: EditorState,
  action: EditorAction,
): EditorState {
  const next = reduce(state, action);
  if (
    next.revision === state.revision ||
    action.type === "setShowAudio" ||
    action.type === "undo" ||
    action.type === "redo"
  ) {
    return next;
  }
  const gesture = "gesture" in action ? (action.gesture ?? null) : null;
  const sameGesture = gesture !== null && gesture === state.gesture;
  return {
    ...next,
    past: sameGesture
      ? state.past
      : [...state.past, state.show].slice(-MAX_UNDO),
    future: [],
    gesture,
  };
}

/** `show` restored from history, keeping the current music. */
function restore(state: EditorState, show: Show): EditorState {
  const restored = { ...show, audio: state.show.audio };
  const selection = state.selection;
  const keep =
    selection?.kind !== "clip" ||
    restored.clips.some((c) => c.id === selection.id);
  return {
    ...state,
    show: restored,
    revision: state.revision + 1,
    selection: keep ? selection : null,
    gesture: null,
  };
}

function reduce(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "undo": {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return {
        ...restore(state, previous),
        past: state.past.slice(0, -1),
        future: [state.show, ...state.future],
      };
    }

    case "redo": {
      const next = state.future[0];
      if (!next) return state;
      return {
        ...restore(state, next),
        past: [...state.past, state.show],
        future: state.future.slice(1),
      };
    }

    case "addClips":
      if (action.clips.length === 0) return state;
      return {
        ...withClips(state, [...state.show.clips, ...action.clips]),
        selection: action.select
          ? { kind: "clip", id: action.select }
          : state.selection,
      };

    case "replaceClips":
      return { ...withClips(state, action.clips), selection: null };

    case "splitClip": {
      const clips = state.show.clips;
      const index = clips.findIndex((c) => c.id === action.id);
      if (index === -1) return state;
      const halves = splitClip(clips[index], action.atMs, action.newId);
      if (!halves) return state;
      return {
        ...withClips(state, [
          ...clips.slice(0, index),
          ...halves,
          ...clips.slice(index + 1),
        ]),
        selection: { kind: "clip", id: action.newId },
      };
    }

    case "setShowLength": {
      const audio = state.show.audio;
      const durationMs = Math.max(1000, Math.round(action.durationMs));
      if (audio.fileId || audio.durationMs === durationMs) return state;
      const next = withShow(state, {
        ...state.show,
        audio: { ...audio, durationMs },
      });
      return { ...next, currentTimeMs: clampToShow(next, state.currentTimeMs) };
    }

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

    case "setClipColor":
      return action.color === state.clipColor
        ? state
        : { ...state, clipColor: action.color };

    case "setPreviewMode":
      return action.mode === state.previewMode
        ? state
        : { ...state, previewMode: action.mode };

    case "addClip":
      return {
        ...withClips(state, [...state.show.clips, action.clip]),
        selection: { kind: "clip", id: action.clip.id },
      };

    case "updateClip": {
      const clips = state.show.clips;
      const index = clips.findIndex((c) => c.id === action.id);
      if (index === -1) return state;
      const clip = patchClip(clips[index], action.patch, minClipMs(state.snap));
      const old = clips[index];
      const same = (Object.keys(clip) as (keyof Clip)[]).every(
        (k) => clip[k] === old[k],
      );
      if (same) return state;
      return withClips(
        state,
        clips.map((c, i) => (i === index ? clip : c)),
      );
    }

    case "deleteClip": {
      const clips = state.show.clips;
      if (!clips.some((c) => c.id === action.id)) return state;
      const next = withClips(
        state,
        clips.filter((c) => c.id !== action.id),
      );
      const selected =
        state.selection?.kind === "clip" && state.selection.id === action.id;
      return selected ? { ...next, selection: null } : next;
    }

    case "moveClipLayer": {
      const clip = state.show.clips.find((c) => c.id === action.id);
      if (!clip) return state;
      const moved = { ...clip, layer: clip.layer + action.direction };
      const rest = state.show.clips.filter((c) => c.id !== action.id);
      return withClips(
        state,
        action.direction === 1 ? [...rest, moved] : [moved, ...rest],
      );
    }

    case "deleteSelection": {
      const selection = state.selection;
      if (!selection) return state;
      switch (selection.kind) {
        case "venueShape":
          return reduce(state, {
            type: "deleteVenueShape",
            id: selection.id,
          });
        case "clip":
          return reduce(state, { type: "deleteClip", id: selection.id });
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

    case "tick": {
      const timeMs = clampToShow(state, action.timeMs);
      return timeMs === state.currentTimeMs
        ? state
        : { ...state, currentTimeMs: timeMs };
    }

    case "seek":
      return {
        ...state,
        currentTimeMs: clampToShow(state, action.timeMs),
        seekSeq: state.seekSeq + 1,
      };

    case "setPlaying":
      if (action.playing === state.playing) return state;
      // Wait for the music to load. A show without music plays on a clock
      // (`usePlayback`).
      if (
        action.playing &&
        state.audioStatus !== "ready" &&
        state.audioStatus !== "none"
      ) {
        return state;
      }
      return { ...state, playing: action.playing };

    case "setZoom": {
      const pxPerSec = Math.min(
        MAX_ZOOM_PX_PER_SEC,
        Math.max(MIN_ZOOM_PX_PER_SEC, action.pxPerSec),
      );
      return pxPerSec === state.zoomPxPerSec
        ? state
        : { ...state, zoomPxPerSec: pxPerSec };
    }

    case "setSnap":
      return { ...state, snap: { ...state.snap, ...action.snap } };

    case "setAudioStatus":
      return {
        ...state,
        audioStatus: action.status,
        audioError:
          action.status === "error"
            ? (action.error ?? "audio failed to load")
            : null,
        playing: action.status === "ready" ? state.playing : false,
      };

    case "setShowAudio": {
      const { fileId, durationMs } = state.show.audio;
      if (
        fileId === action.audio.fileId &&
        durationMs === action.audio.durationMs
      )
        return state;
      const next = withShow(state, { ...state.show, audio: action.audio });
      const newFile = fileId !== action.audio.fileId;
      return {
        ...next,
        currentTimeMs: newFile ? 0 : clampToShow(next, state.currentTimeMs),
        seekSeq: newFile ? state.seekSeq + 1 : state.seekSeq,
        playing: newFile ? false : state.playing,
      };
    }
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
