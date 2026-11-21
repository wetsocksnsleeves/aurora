import { describe, expect, it } from "vitest";
import type { Venue } from "./types";
import {
  clampUnit,
  nearestPointOnSegment,
  pointInPolygon,
  randomSeat,
  shapeAt,
} from "./venue-geometry";
import { wsUrlFor } from "./ws-url";

const square = [
  { x: 0.2, y: 0.2 },
  { x: 0.6, y: 0.2 },
  { x: 0.6, y: 0.6 },
  { x: 0.2, y: 0.6 },
];

const triangle = [
  { x: 0.5, y: 0.1 },
  { x: 0.9, y: 0.9 },
  { x: 0.1, y: 0.9 },
];

describe("clampUnit", () => {
  it("clamps to 0..1 and maps NaN to 0", () => {
    expect(clampUnit(-0.1)).toBe(0);
    expect(clampUnit(1.5)).toBe(1);
    expect(clampUnit(0.3)).toBe(0.3);
    expect(clampUnit(NaN)).toBe(0);
  });
});

describe("pointInPolygon", () => {
  it("handles a rectangle", () => {
    expect(pointInPolygon({ x: 0.4, y: 0.4 }, square)).toBe(true);
    expect(pointInPolygon({ x: 0.1, y: 0.4 }, square)).toBe(false);
    expect(pointInPolygon({ x: 0.4, y: 0.7 }, square)).toBe(false);
  });

  it("handles a non-rectangular polygon", () => {
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, triangle)).toBe(true);
    // Inside the bounding box but outside the slanted edge.
    expect(pointInPolygon({ x: 0.15, y: 0.2 }, triangle)).toBe(false);
  });

  it("is false for degenerate polygons", () => {
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, [])).toBe(false);
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, [{ x: 0.5, y: 0.5 }])).toBe(
      false,
    );
  });
});

describe("nearestPointOnSegment", () => {
  it("projects onto the segment and clamps to its ends", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 1, y: 0 };
    expect(nearestPointOnSegment({ x: 0.3, y: 0.5 }, a, b)).toEqual({
      x: 0.3,
      y: 0,
    });
    expect(nearestPointOnSegment({ x: -1, y: 1 }, a, b)).toEqual(a);
    expect(nearestPointOnSegment({ x: 2, y: 1 }, a, b)).toEqual(b);
    expect(nearestPointOnSegment({ x: 2, y: 1 }, a, a)).toEqual(a);
  });
});

describe("shapeAt", () => {
  it("returns the topmost shape containing the point", () => {
    const venue: Venue = {
      shapes: [
        { id: "bottom", points: square },
        { id: "top", points: triangle },
      ],
    };
    expect(shapeAt(venue, { x: 0.5, y: 0.5 })).toBe("top");
    expect(shapeAt(venue, { x: 0.25, y: 0.25 })).toBe("bottom");
    expect(shapeAt(venue, { x: 0.95, y: 0.05 })).toBeNull();
  });
});

describe("wsUrlFor", () => {
  it("uses wss behind https and ws otherwise", () => {
    expect(wsUrlFor({ protocol: "https:", host: "a.trycloudflare.com" })).toBe(
      "wss://a.trycloudflare.com/ws",
    );
    expect(wsUrlFor({ protocol: "http:", host: "localhost:3000" })).toBe(
      "ws://localhost:3000/ws",
    );
  });
});

describe("randomSeat", () => {
  const triangle: Venue = {
    shapes: [
      {
        id: "t",
        points: [
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.1 },
          { x: 0.5, y: 0.9 },
        ],
      },
    ],
  };

  it("lands inside the venue's shapes", () => {
    let seed = 1;
    const random = () =>
      ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    for (let i = 0; i < 200; i++) {
      expect(shapeAt(triangle, randomSeat(triangle, random))).toBe("t");
    }
  });

  it("uses the whole box when the venue has no shapes", () => {
    const values = [0.25, 0.75];
    const seat = randomSeat({ shapes: [] }, () => values.shift()!);
    expect(seat).toEqual({ x: 0.25, y: 0.75 });
  });
});
