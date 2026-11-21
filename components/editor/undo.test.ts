import { describe, expect, it } from "vitest";
import type { Clip, Show } from "@/lib/types";
import { editorReducer, initialEditorState, type EditorAction } from "./store";

const show: Show = {
  id: "s",
  name: "Show",
  venue: { shapes: [] },
  audio: { fileId: "", durationMs: 30_000 },
  clips: [],
  createdAt: "",
  updatedAt: "",
};

const clip = (id: string, over: Partial<Clip> = {}): Clip => ({
  id,
  layer: 0,
  startMs: 0,
  endMs: 1000,
  color: "#ffffff",
  fadeInMs: 0,
  fadeOutMs: 0,
  shape: { kind: "fill" },
  ...over,
});

const run = (...actions: EditorAction[]) =>
  actions.reduce(editorReducer, initialEditorState(show));

describe("undo and redo", () => {
  it("steps back and forward through edits", () => {
    let s = run(
      { type: "addClips", clips: [clip("a")] },
      { type: "addClips", clips: [clip("b")], select: "b" },
    );
    expect(s.show.clips.map((c) => c.id)).toEqual(["a", "b"]);
    s = editorReducer(s, { type: "undo" });
    expect(s.show.clips.map((c) => c.id)).toEqual(["a"]);
    // The selected clip is gone, so nothing is selected.
    expect(s.selection).toBeNull();
    s = editorReducer(s, { type: "redo" });
    expect(s.show.clips.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("undoes a whole drag in one step", () => {
    let s = run({ type: "addClips", clips: [clip("a")] });
    for (const startMs of [100, 200, 300]) {
      s = editorReducer(s, {
        type: "updateClip",
        id: "a",
        patch: { startMs, endMs: startMs + 1000 },
        gesture: "drag-1",
      });
    }
    s = editorReducer(s, { type: "undo" });
    expect(s.show.clips[0]!.startMs).toBe(0);
  });

  it("drops the redo steps after a new edit", () => {
    let s = run(
      { type: "addClips", clips: [clip("a")] },
      { type: "undo" },
      { type: "addClips", clips: [clip("b")] },
    );
    expect(editorReducer(s, { type: "redo" })).toBe(s);
    s = editorReducer(s, { type: "undo" });
    expect(s.show.clips).toEqual([]);
  });

  it("marks undo as a change to save", () => {
    const s = run({ type: "addClips", clips: [clip("a")] });
    expect(editorReducer(s, { type: "undo" }).revision).toBe(s.revision + 1);
  });
});

describe("splitClip and setShowLength", () => {
  it("splits the clip and selects the second half", () => {
    const s = run(
      { type: "addClips", clips: [clip("a")] },
      { type: "splitClip", id: "a", atMs: 400, newId: "b" },
    );
    expect(s.show.clips.map((c) => [c.id, c.startMs, c.endMs])).toEqual([
      ["a", 0, 400],
      ["b", 400, 1000],
    ]);
    expect(s.selection).toEqual({ kind: "clip", id: "b" });
  });

  it("sets the length of a show without music", () => {
    const s = run({ type: "setShowLength", durationMs: 45_000 });
    expect(s.show.audio.durationMs).toBe(45_000);
  });
});
