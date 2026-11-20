import { describe, expect, it } from "vitest";
import { handleEditorKey } from "./keyboard";
import type { EditorStore, ToolId } from "./store";
import { makeStore } from "./test-fixtures";
import { toolHandlers, type ToolContext } from "./tools";

const size = { width: 500, height: 500 };

function setup(tool: ToolId, store: EditorStore = makeStore()) {
  store.dispatch({ type: "setTool", tool });
  const ctx: ToolContext = { store, size };
  const handler = toolHandlers[tool];
  const at = (x: number, y: number, clickCount = 1) => ({
    point: { x, y },
    clickCount,
    shiftKey: false,
  });
  return {
    store,
    clips: () => store.getState().show.clips,
    down: (x: number, y: number, clickCount = 1) =>
      handler.onPointerDown?.(at(x, y, clickCount), ctx),
    move: (x: number, y: number) => handler.onPointerMove?.(at(x, y), ctx),
    up: (x: number, y: number) => handler.onPointerUp?.(at(x, y), ctx),
    key: (key: string) =>
      handleEditorKey(
        { key, ctrlKey: false, metaKey: false, altKey: false },
        store,
        size,
      ),
  };
}

function withAudio(): EditorStore {
  const store = makeStore({ audio: { fileId: "", durationMs: 10_000 } });
  store.dispatch({ type: "seek", timeMs: 2340 });
  store.dispatch({ type: "setClipColor", color: "#ff0000" });
  return store;
}

describe("fill tool", () => {
  it("adds a fill clip at the playhead in the current colour", () => {
    const t = setup("fill", withAudio());
    t.down(0.5, 0.5);
    expect(t.clips()).toHaveLength(1);
    expect(t.clips()[0]).toMatchObject({
      shape: { kind: "fill" },
      startMs: 2300,
      endMs: 3300,
      color: "#ff0000",
      layer: 0,
    });
    expect(t.store.getState().selection).toEqual({
      kind: "clip",
      id: t.clips()[0].id,
    });
  });

  it("puts each new clip on top", () => {
    const t = setup("fill", withAudio());
    t.down(0.5, 0.5);
    t.down(0.5, 0.5);
    expect(t.clips().map((c) => c.layer)).toEqual([0, 1]);
  });
});

describe("shape tool", () => {
  it("drags a rectangle clip", () => {
    const t = setup("shape", withAudio());
    t.down(0, 0);
    t.move(0.3, 0.4);
    t.up(0.5, 1);
    expect(t.clips()).toHaveLength(1);
    expect(t.clips()[0].shape).toEqual({
      kind: "polygon",
      points: [
        { x: 0, y: 0 },
        { x: 0.5, y: 0 },
        { x: 0.5, y: 1 },
        { x: 0, y: 1 },
      ],
    });
    expect(t.store.getState().draft).toBeNull();
  });

  it("clicks a polygon clip, closed on the first point", () => {
    const t = setup("shape", withAudio());
    for (const [x, y] of [
      [0.1, 0.1],
      [0.6, 0.1],
      [0.4, 0.7],
    ]) {
      t.down(x, y);
      t.up(x, y);
    }
    expect(t.store.getState().draft).toMatchObject({
      kind: "clipPolygon",
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.6, y: 0.1 },
        { x: 0.4, y: 0.7 },
      ],
    });
    t.down(0.101, 0.101);
    expect(t.clips()).toHaveLength(1);
    expect(t.clips()[0].shape).toMatchObject({ kind: "polygon" });
    expect(t.clips()[0].shape).not.toHaveProperty("moveTo");
  });

  it("closes a polygon with Enter and cancels with Escape", () => {
    const t = setup("shape", withAudio());
    for (const [x, y] of [
      [0.1, 0.1],
      [0.6, 0.1],
      [0.4, 0.7],
    ]) {
      t.down(x, y);
      t.up(x, y);
    }
    expect(t.key("Enter")).toBe(true);
    expect(t.clips()).toHaveLength(1);
    t.down(0.1, 0.1);
    t.up(0.1, 0.1);
    expect(t.key("Escape")).toBe(true);
    expect(t.store.getState().draft).toBeNull();
    expect(t.clips()).toHaveLength(1);
  });
});

describe("moving shape tool", () => {
  it("draws a strip, then drags to set moveTo", () => {
    const t = setup("moving", withAudio());
    t.down(0, 0);
    t.up(0.1, 1);
    expect(t.clips()).toHaveLength(0);
    expect(t.store.getState().draft).toMatchObject({ kind: "clipMove" });
    t.down(0.05, 0.5);
    t.move(0.5, 0.5);
    t.up(0.85, 0.5);
    expect(t.clips()).toHaveLength(1);
    const shape = t.clips()[0].shape;
    expect(shape.kind).toBe("polygon");
    if (shape.kind !== "polygon") return;
    expect(shape.moveTo?.x).toBeCloseTo(0.8);
    expect(shape.moveTo?.y).toBeCloseTo(0);
    expect(t.store.getState().draft).toBeNull();
  });

  it("cancels with Escape before the end position is set", () => {
    const t = setup("moving", withAudio());
    t.down(0, 0);
    t.up(0.1, 1);
    t.key("Escape");
    expect(t.store.getState().draft).toBeNull();
    expect(t.clips()).toHaveLength(0);
  });
});

describe("brush tool", () => {
  it("turns a freehand loop into a simplified closed polygon", () => {
    const t = setup("brush", withAudio());
    const n = 200;
    t.down(0.7, 0.5);
    for (let i = 1; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      t.move(0.5 + 0.2 * Math.cos(a), 0.5 + 0.2 * Math.sin(a));
    }
    t.up(0.7, 0.5);
    expect(t.clips()).toHaveLength(1);
    const shape = t.clips()[0].shape;
    if (shape.kind !== "polygon") throw new Error("expected a polygon");
    expect(shape.points.length).toBeGreaterThanOrEqual(8);
    expect(shape.points.length).toBeLessThan(n / 2);
  });

  it("ignores a click without a stroke", () => {
    const t = setup("brush", withAudio());
    t.down(0.5, 0.5);
    t.up(0.5, 0.5);
    expect(t.clips()).toHaveLength(0);
    expect(t.store.getState().draft).toBeNull();
  });
});

describe("delete key", () => {
  it("removes the selected clip", () => {
    const t = setup("fill", withAudio());
    t.down(0.5, 0.5);
    expect(t.key("Delete")).toBe(true);
    expect(t.clips()).toHaveLength(0);
  });
});
