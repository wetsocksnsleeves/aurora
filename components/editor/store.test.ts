import { describe, expect, it, vi } from "vitest";
import { editorReducer, initialEditorState, isDirty, newId } from "./store";
import { makeShow, makeStore, square } from "./test-fixtures";

describe("editorReducer", () => {
  it("starts clean with the select tool", () => {
    const state = initialEditorState(makeShow());
    expect(isDirty(state)).toBe(false);
    expect(state.tool).toBe("select");
    expect(state.selection).toBeNull();
  });

  it("adds a venue shape, selects it and marks the show dirty", () => {
    const state = editorReducer(initialEditorState(makeShow()), {
      type: "addVenueShape",
      shape: { id: "a", points: square },
    });
    expect(state.show.venue.shapes).toEqual([{ id: "a", points: square }]);
    expect(state.selection).toEqual({ kind: "venueShape", id: "a" });
    expect(isDirty(state)).toBe(true);
  });

  it("replaces a shape's points", () => {
    const start = initialEditorState(
      makeShow({ venue: { shapes: [{ id: "a", points: square }] } }),
    );
    const moved = square.map((p) => ({ x: p.x + 0.1, y: p.y }));
    const state = editorReducer(start, {
      type: "setVenueShapePoints",
      id: "a",
      points: moved,
    });
    expect(state.show.venue.shapes[0].points).toEqual(moved);
    expect(
      editorReducer(start, {
        type: "setVenueShapePoints",
        id: "zzz",
        points: moved,
      }),
    ).toBe(start);
  });

  it("deletes the selected shape and clears the selection", () => {
    let state = initialEditorState(makeShow());
    state = editorReducer(state, {
      type: "addVenueShape",
      shape: { id: "a", points: square },
    });
    state = editorReducer(state, {
      type: "addVenueShape",
      shape: { id: "b", points: square },
    });
    state = editorReducer(state, {
      type: "select",
      selection: { kind: "venueShape", id: "a" },
    });
    state = editorReducer(state, { type: "deleteSelection" });
    expect(state.show.venue.shapes.map((s) => s.id)).toEqual(["b"]);
    expect(state.selection).toBeNull();
    expect(editorReducer(state, { type: "deleteSelection" })).toBe(state);
  });

  it("clears the draft when the tool changes", () => {
    let state = initialEditorState(makeShow());
    state = editorReducer(state, {
      type: "setDraft",
      draft: { kind: "polygon", points: [{ x: 0, y: 0 }], hover: null },
    });
    state = editorReducer(state, { type: "setTool", tool: "rect" });
    expect(state.draft).toBeNull();
    expect(state.tool).toBe("rect");
    expect(isDirty(state)).toBe(false);
  });

  it("renames the show", () => {
    const state = editorReducer(initialEditorState(makeShow()), {
      type: "renameShow",
      name: "Finale",
    });
    expect(state.show.name).toBe("Finale");
    expect(isDirty(state)).toBe(true);
  });

  it("stays dirty after a save if the show changed while saving", () => {
    let state = initialEditorState(makeShow());
    state = editorReducer(state, { type: "renameShow", name: "One" });
    const sent = state.revision;
    state = editorReducer(state, { type: "saveStarted" });
    expect(state.saveStatus).toBe("saving");
    state = editorReducer(state, { type: "renameShow", name: "Two" });
    const serverShow = makeShow({
      name: "One",
      updatedAt: "2026-02-02T00:00:00.000Z",
    });
    state = editorReducer(state, {
      type: "saveSucceeded",
      revision: sent,
      show: serverShow,
    });
    expect(state.saveStatus).toBe("saved");
    expect(state.show.name).toBe("Two");
    expect(state.show.updatedAt).toBe("2026-02-02T00:00:00.000Z");
    expect(isDirty(state)).toBe(true);
  });

  it("is clean after a save with no further edits", () => {
    let state = editorReducer(initialEditorState(makeShow()), {
      type: "renameShow",
      name: "X",
    });
    const sent = state.revision;
    state = editorReducer(state, { type: "saveStarted" });
    state = editorReducer(state, {
      type: "saveSucceeded",
      revision: sent,
      show: makeShow(),
    });
    expect(isDirty(state)).toBe(false);
  });

  it("records a failed save", () => {
    const state = editorReducer(initialEditorState(makeShow()), {
      type: "saveFailed",
      error: "boom",
    });
    expect(state.saveStatus).toBe("error");
    expect(state.saveError).toBe("boom");
  });
});

describe("createEditorStore", () => {
  it("notifies subscribers on change only", () => {
    const store = makeStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.dispatch({ type: "select", selection: null }); // new object, still a change
    store.dispatch({ type: "deleteSelection" }); // no-op: same state
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.dispatch({ type: "renameShow", name: "Z" });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("newId", () => {
  it("prefixes and varies", () => {
    expect(newId("shape")).toMatch(/^shape-[0-9a-z]{8}$/);
    expect(newId("shape")).not.toBe(newId("shape"));
  });
});
