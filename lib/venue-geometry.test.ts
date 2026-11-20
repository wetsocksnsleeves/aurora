import { describe, expect, it } from "vitest";
import { TEST_VENUE } from "./test-show";
import type { Venue } from "./types";
import {
  clampUnit,
  clientToVenuePoint,
  nearestPointOnSegment,
  pickSeat,
  pointInPolygon,
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

describe("clientToVenuePoint", () => {
  const rect = { left: 100, top: 50, width: 200, height: 400 };

  it("normalises a point inside the box to 0..1 per axis", () => {
    expect(clientToVenuePoint(200, 250, rect)).toEqual({ x: 0.5, y: 0.5 });
    expect(clientToVenuePoint(100, 50, rect)).toEqual({ x: 0, y: 0 });
    expect(clientToVenuePoint(300, 450, rect)).toEqual({ x: 1, y: 1 });
  });

  it("returns null outside the box or for an empty box", () => {
    expect(clientToVenuePoint(99, 250, rect)).toBeNull();
    expect(clientToVenuePoint(200, 451, rect)).toBeNull();
    expect(clientToVenuePoint(0, 0, { ...rect, width: 0 })).toBeNull();
  });
});

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

describe("pickSeat", () => {
  it("keeps a tap inside a shape", () => {
    expect(pickSeat(TEST_VENUE, { x: 0.25, y: 0.5 })).toEqual({
      x: 0.25,
      y: 0.5,
    });
    expect(pickSeat(TEST_VENUE, { x: 0.75, y: 0.3 })).toEqual({
      x: 0.75,
      y: 0.3,
    });
  });

  it("snaps a tap just outside a shape to the nearest edge", () => {
    const seat = pickSeat(TEST_VENUE, { x: 0.47, y: 0.5 });
    expect(seat).not.toBeNull();
    expect(seat!.x).toBeCloseTo(0.45);
    expect(seat!.y).toBeCloseTo(0.5);
  });

  it("ignores a tap far from every shape", () => {
    // The centre aisle is 0.1 wide, so its middle is 0.05 from each block.
    expect(pickSeat(TEST_VENUE, { x: 0.5, y: 0.5 }, 0.04)).toBeNull();
    // The stage area at the top.
    expect(pickSeat(TEST_VENUE, { x: 0.5, y: 0.05 })).toBeNull();
  });

  it("accepts and clamps any point when the venue has no shapes", () => {
    expect(pickSeat({ shapes: [] }, { x: 1.2, y: -0.1 })).toEqual({
      x: 1,
      y: 0,
    });
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
