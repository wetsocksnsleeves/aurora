import { describe, expect, it } from "vitest";
import { handleEditorKey } from "./keyboard";
import type { EditorStore, ToolId } from "./store";
import { makeStore, square } from "./test-fixtures";
import { toolHandlers, type ToolContext } from "./tools";

const size = { width: 800, height: 500 };

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

describe("rectangle tool", () => {
  it("draws a rectangle from a drag", () => {
    const t = setup("rect");
    t.down(0.1, 0.1);
    t.move(0.3, 0.2);
    expect(t.store.getState().draft).toMatchObject({
      kind: "rect",
      to: { x: 0.3, y: 0.2 },
    });
    t.up(0.5, 0.4);
    const { shapes } = t.store.getState().show.venue;
    expect(shapes).toHaveLength(1);
    expect(shapes[0].points).toEqual([
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.1 },
      { x: 0.5, y: 0.4 },
      { x: 0.1, y: 0.4 },
    ]);
    expect(t.store.getState().draft).toBeNull();
  });

  it("ignores a click without a drag", () => {
    const t = setup("rect");
    t.down(0.1, 0.1);
    t.up(0.101, 0.101);
    expect(t.store.getState().show.venue.shapes).toHaveLength(0);
  });
});

describe("polygon tool", () => {
  it("closes on a click near the first point", () => {
    const t = setup("polygon");
    t.down(0.1, 0.1);
    t.down(0.5, 0.1);
    t.down(0.5, 0.5);
    t.down(0.1 + 5 / 800, 0.1); // 5 px from the first point
    const { shapes } = t.store.getState().show.venue;
    expect(shapes).toHaveLength(1);
    expect(shapes[0].points).toEqual([
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.1 },
      { x: 0.5, y: 0.5 },
    ]);
  });

  it("closes on a double click without adding a duplicate point", () => {
    const t = setup("polygon");
    t.down(0.1, 0.1);
    t.down(0.5, 0.1);
    t.down(0.5, 0.5);
    t.down(0.5, 0.5, 2);
    expect(t.store.getState().show.venue.shapes[0].points).toHaveLength(3);
  });

  it("closes with Enter, removes points with Backspace and cancels with Escape", () => {
    const t = setup("polygon");
    t.down(0.1, 0.1);
    t.down(0.5, 0.1);
    t.down(0.9, 0.9);
    t.down(0.5, 0.5);
    expect(t.key("Backspace")).toBe(true);
    expect(t.key("Enter")).toBe(true);
    expect(t.store.getState().show.venue.shapes[0].points).toEqual([
      { x: 0.1, y: 0.1 },
      { x: 0.5, y: 0.1 },
      { x: 0.9, y: 0.9 },
    ]);

    t.down(0.1, 0.1);
    t.down(0.2, 0.2);
    t.key("Escape");
    expect(t.store.getState().draft).toBeNull();
    expect(t.store.getState().show.venue.shapes).toHaveLength(1);
  });

  it("drops polygons with fewer than three points or no area", () => {
    const t = setup("polygon");
    t.down(0.1, 0.1);
    t.down(0.2, 0.2);
    t.key("Enter");
    t.down(0.1, 0.1);
    t.down(0.2, 0.2);
    t.down(0.3, 0.3);
    t.key("Enter");
    expect(t.store.getState().show.venue.shapes).toHaveLength(0);
  });
});

describe("select tool", () => {
  function withSquare() {
    const store = makeStore({
      venue: { shapes: [{ id: "a", points: square }] },
    });
    return setup("select", store);
  }

  it("selects a shape and drags it", () => {
    const t = withSquare();
    t.down(0.3, 0.3);
    expect(t.store.getState().selection).toEqual({
      kind: "venueShape",
      id: "a",
    });
    t.move(0.35, 0.4);
    t.move(0.4, 0.5);
    t.up(0.4, 0.5);
    const points = t.store.getState().show.venue.shapes[0].points;
    expect(points[0].x).toBeCloseTo(0.3);
    expect(points[0].y).toBeCloseTo(0.4);
    t.down(0.35, 0.45);
    t.up(0.45, 0.45); // released without a move event in between
    expect(t.store.getState().show.venue.shapes[0].points[0].x).toBeCloseTo(
      0.4,
    );
    expect(t.store.getState().draft).toBeNull();
  });

  it("clears the selection on empty space", () => {
    const t = withSquare();
    t.down(0.3, 0.3);
    t.up(0.3, 0.3);
    t.down(0.9, 0.9);
    expect(t.store.getState().selection).toBeNull();
  });

  it("deletes the selection with Delete", () => {
    const t = withSquare();
    t.down(0.3, 0.3);
    t.up(0.3, 0.3);
    expect(t.key("Delete")).toBe(true);
    expect(t.store.getState().show.venue.shapes).toHaveLength(0);
  });
});

describe("keyboard shortcuts", () => {
  it("switches tools by letter", () => {
    const t = setup("select");
    t.key("r");
    expect(t.store.getState().tool).toBe("rect");
    t.key("P");
    expect(t.store.getState().tool).toBe("polygon");
    t.key("v");
    expect(t.store.getState().tool).toBe("select");
  });

  it("leaves modified keys alone", () => {
    const t = setup("select");
    const handled = handleEditorKey(
      { key: "r", ctrlKey: true, metaKey: false, altKey: false },
      t.store,
      size,
    );
    expect(handled).toBe(false);
    expect(t.store.getState().tool).toBe("select");
  });
});
