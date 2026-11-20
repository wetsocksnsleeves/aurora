import type { Show } from "@/lib/types";
import {
  createEditorStore,
  initialEditorState,
  type EditorStore,
} from "./store";

export function makeShow(overrides: Partial<Show> = {}): Show {
  return {
    id: "show-1",
    name: "Test show",
    venue: { shapes: [] },
    audio: { fileId: "", durationMs: 0 },
    clips: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

export function makeStore(overrides: Partial<Show> = {}): EditorStore {
  return createEditorStore(initialEditorState(makeShow(overrides)));
}

export const square = [
  { x: 0.2, y: 0.2 },
  { x: 0.4, y: 0.2 },
  { x: 0.4, y: 0.4 },
  { x: 0.2, y: 0.4 },
];
