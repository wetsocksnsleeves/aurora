import { describe, expect, it } from "vitest";
import {
  fromPx,
  hitTestShapes,
  pointInPolygon,
  rectFromCorners,
  toPx,
  translatePolygon,
} from "./geometry";
import { square } from "./test-fixtures";

const size = { width: 800, height: 500 };

describe("pixel mapping", () => {
  it("round-trips normalised points at any size", () => {
    const p = { x: 0.25, y: 0.75 };
    for (const s of [
      size,
      { width: 320, height: 200 },
      { width: 1920, height: 1200 },
    ]) {
      const back = fromPx(toPx(p, s), s);
      expect(back.x).toBeCloseTo(p.x, 12);
      expect(back.y).toBeCloseTo(p.y, 12);
    }
  });

  it("clamps points outside the canvas", () => {
    expect(fromPx({ x: -10, y: 900 }, size)).toEqual({ x: 0, y: 1 });
  });
});

describe("rectFromCorners", () => {
  it("orders corners clockwise from top-left whatever the drag direction", () => {
    expect(rectFromCorners({ x: 0.6, y: 0.8 }, { x: 0.1, y: 0.2 })).toEqual([
      { x: 0.1, y: 0.2 },
      { x: 0.6, y: 0.2 },
      { x: 0.6, y: 0.8 },
      { x: 0.1, y: 0.8 },
    ]);
  });
});

describe("pointInPolygon", () => {
  it("detects inside and outside", () => {
    expect(pointInPolygon({ x: 0.3, y: 0.3 }, square)).toBe(true);
    expect(pointInPolygon({ x: 0.5, y: 0.3 }, square)).toBe(false);
  });

  it("handles concave polygons", () => {
    const l = [
      { x: 0, y: 0 },
      { x: 0.5, y: 0 },
      { x: 0.5, y: 0.2 },
      { x: 0.2, y: 0.2 },
      { x: 0.2, y: 0.5 },
      { x: 0, y: 0.5 },
    ];
    expect(pointInPolygon({ x: 0.1, y: 0.4 }, l)).toBe(true);
    expect(pointInPolygon({ x: 0.4, y: 0.4 }, l)).toBe(false);
  });
});

describe("hitTestShapes", () => {
  const shapes = [
    { id: "below", points: square },
    {
      id: "above",
      points: square.map((p) => ({ x: p.x + 0.1, y: p.y + 0.1 })),
    },
  ];

  it("returns the topmost shape containing the point", () => {
    expect(hitTestShapes(shapes, { x: 0.35, y: 0.35 }, size)).toBe("above");
    expect(hitTestShapes(shapes, { x: 0.25, y: 0.25 }, size)).toBe("below");
    expect(hitTestShapes(shapes, { x: 0.9, y: 0.9 }, size)).toBeNull();
  });

  it("hits an outline within the pixel tolerance", () => {
    // 4 px left of the left edge of "below" (x = 0.2 → 160 px).
    expect(hitTestShapes(shapes, { x: 156 / 800, y: 0.25 }, size, 6)).toBe(
      "below",
    );
    expect(
      hitTestShapes(shapes, { x: 150 / 800, y: 0.25 }, size, 6),
    ).toBeNull();
  });
});

describe("translatePolygon", () => {
  it("moves every point", () => {
    expect(translatePolygon(square, 0.1, -0.1)[0]).toEqual({
      x: 0.30000000000000004,
      y: 0.1,
    });
  });

  it("stops at the venue edge without changing the shape", () => {
    const moved = translatePolygon(square, 5, -5);
    expect(moved).toEqual([
      { x: 0.8, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 0.2 },
      { x: 0.8, y: 0.2 },
    ]);
  });
});
