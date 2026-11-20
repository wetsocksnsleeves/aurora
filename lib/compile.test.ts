import { describe, expect, it } from "vitest";
import {
  SAMPLE_MS,
  colorAt,
  compileSchedule,
  pointInPolygon,
  snapSeatToVenue,
} from "./compile";
import type { Clip, Point, Show } from "./types";

const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

let clipSeq = 0;
function clip(overrides: Partial<Clip>): Clip {
  return {
    id: `c${clipSeq++}`,
    layer: 0,
    startMs: 0,
    endMs: 1000,
    color: "#ffffff",
    fadeInMs: 0,
    fadeOutMs: 0,
    shape: { kind: "fill" },
    ...overrides,
  };
}

function show(clips: Clip[], durationMs = 2000): Show {
  return {
    id: "s1",
    name: "test",
    venue: { shapes: [{ id: "floor", points: rect(0, 0, 1, 1) }] },
    audio: { fileId: "a1", durationMs },
    clips,
    createdAt: "2026-11-20T00:00:00.000Z",
    updatedAt: "2026-11-20T00:00:00.000Z",
  };
}

const centre = { x: 0.5, y: 0.5 };

describe("compileSchedule", () => {
  it("returns a single black event for an empty show", () => {
    expect(compileSchedule(show([], 1000), centre)).toEqual({
      events: [{ tMs: 0, color: "#000000" }],
      durationMs: 1000,
    });
  });

  it("lights every seat with a fill clip for its time range", () => {
    const s = show([clip({ startMs: 100, endMs: 500, color: "#ff0000" })]);
    for (const seat of [centre, { x: 0, y: 0 }, { x: 0.99, y: 0.01 }]) {
      expect(compileSchedule(s, seat).events).toEqual([
        { tMs: 0, color: "#000000" },
        { tMs: 100, color: "#ff0000" },
        { tMs: 500, color: "#000000" },
      ]);
    }
  });

  it("rounds clip edges up to the next 20 ms sample", () => {
    const s = show([clip({ startMs: 105, endMs: 487 })]);
    expect(compileSchedule(s, centre).events).toEqual([
      { tMs: 0, color: "#000000" },
      { tMs: 120, color: "#ffffff" },
      { tMs: 500, color: "#000000" },
    ]);
  });

  it("lights only seats inside a static polygon", () => {
    const s = show([
      clip({
        startMs: 0,
        endMs: 1000,
        shape: { kind: "polygon", points: rect(0, 0, 0.5, 1) },
      }),
    ]);
    expect(compileSchedule(s, { x: 0.25, y: 0.5 }).events).toEqual([
      { tMs: 0, color: "#ffffff" },
      { tMs: 1000, color: "#000000" },
    ]);
    expect(compileSchedule(s, { x: 0.75, y: 0.5 }).events).toEqual([
      { tMs: 0, color: "#000000" },
    ]);
  });

  it("handles a concave polygon", () => {
    // An L shape: the notch at the top right is outside.
    const l: Point[] = [
      { x: 0, y: 0 },
      { x: 0.4, y: 0 },
      { x: 0.4, y: 0.6 },
      { x: 1, y: 0.6 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];
    const s = show([clip({ shape: { kind: "polygon", points: l } })]);
    expect(colorAt(s, { x: 0.2, y: 0.2 }, 0)).toBe("#ffffff");
    expect(colorAt(s, { x: 0.8, y: 0.8 }, 0)).toBe("#ffffff");
    expect(colorAt(s, { x: 0.8, y: 0.2 }, 0)).toBe("#000000");
  });

  it("lets the highest layer win where clips overlap", () => {
    const s = show([
      clip({ layer: 2, startMs: 200, endMs: 400, color: "#0000ff" }),
      clip({ layer: 0, startMs: 0, endMs: 1000, color: "#ff0000" }),
      clip({ layer: 1, startMs: 300, endMs: 600, color: "#00ff00" }),
    ]);
    expect(compileSchedule(s, centre).events).toEqual([
      { tMs: 0, color: "#ff0000" },
      { tMs: 200, color: "#0000ff" },
      { tMs: 400, color: "#00ff00" },
      { tMs: 600, color: "#ff0000" },
      { tMs: 1000, color: "#000000" },
    ]);
  });

  it("falls through to a lower layer where the top polygon misses", () => {
    const s = show([
      clip({ layer: 0, color: "#ff0000" }),
      clip({
        layer: 1,
        color: "#0000ff",
        shape: { kind: "polygon", points: rect(0, 0, 0.5, 1) },
      }),
    ]);
    expect(colorAt(s, { x: 0.25, y: 0.5 }, 500)).toBe("#0000ff");
    expect(colorAt(s, { x: 0.75, y: 0.5 }, 500)).toBe("#ff0000");
  });

  it("draws the later clip on top when layers are equal", () => {
    const s = show([clip({ color: "#ff0000" }), clip({ color: "#00ff00" })]);
    expect(colorAt(s, centre, 0)).toBe("#00ff00");
  });

  it("counts a seat exactly on a polygon edge or vertex as inside", () => {
    const s = show([
      clip({ shape: { kind: "polygon", points: rect(0.2, 0.2, 0.6, 0.6) } }),
    ]);
    for (const seat of [
      { x: 0.2, y: 0.4 }, // left edge
      { x: 0.6, y: 0.4 }, // right edge
      { x: 0.4, y: 0.2 }, // top edge
      { x: 0.4, y: 0.6 }, // bottom edge
      { x: 0.6, y: 0.6 }, // vertex
    ]) {
      expect(colorAt(s, seat, 0)).toBe("#ffffff");
    }
    expect(colorAt(s, { x: 0.61, y: 0.4 }, 0)).toBe("#000000");
  });

  it("snaps a seat outside the venue onto the nearest edge", () => {
    // Clip covers the whole venue; a seat just off the right side snaps onto
    // the venue edge and is lit.
    const s = show([
      clip({ shape: { kind: "polygon", points: rect(0, 0, 1, 1) } }),
    ]);
    const outside = { x: 1.2, y: 0.5 };
    expect(colorAt(s, outside, 0)).toBe("#ffffff");
    expect(compileSchedule(s, outside).events[0]).toEqual({
      tMs: 0,
      color: "#ffffff",
    });
  });

  it("uses the audio duration, or the last clip end if later", () => {
    expect(compileSchedule(show([], 3000), centre).durationMs).toBe(3000);
    const s = show([clip({ startMs: 0, endMs: 4000 })], 3000);
    const sched = compileSchedule(s, centre);
    expect(sched.durationMs).toBe(4000);
    expect(sched.events.at(-1)?.tMs).toBeLessThan(4000);
  });

  it("normalises colours to lowercase #rrggbb", () => {
    const s = show([clip({ color: "#F0A" })]);
    expect(colorAt(s, centre, 0)).toBe("#ff00aa");
  });

  it("matches colorAt at every sample", () => {
    const s = show([
      clip({ layer: 0, startMs: 0, endMs: 900, color: "#ff0000" }),
      clip({
        layer: 1,
        startMs: 300,
        endMs: 700,
        color: "#00ff00",
        shape: { kind: "polygon", points: rect(0, 0, 0.6, 0.6) },
      }),
    ]);
    const seat = { x: 0.3, y: 0.3 };
    const { events, durationMs } = compileSchedule(s, seat);
    let i = 0;
    for (let t = 0; t < durationMs; t += SAMPLE_MS) {
      while (i + 1 < events.length && events[i + 1].tMs <= t) i++;
      expect(events[i].color).toBe(colorAt(s, seat, t));
    }
  });

  it("emits strictly increasing, deduplicated events", () => {
    const s = show([
      clip({ startMs: 0, endMs: 500 }),
      clip({ startMs: 500, endMs: 1000 }),
    ]);
    const { events } = compileSchedule(s, centre);
    expect(events).toEqual([
      { tMs: 0, color: "#ffffff" },
      { tMs: 1000, color: "#000000" },
    ]);
  });
});

describe("pointInPolygon", () => {
  const square = rect(0, 0, 1, 1);

  it("tests inside and outside", () => {
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, square)).toBe(true);
    expect(pointInPolygon({ x: 1.5, y: 0.5 }, square)).toBe(false);
    expect(pointInPolygon({ x: -0.1, y: 0.5 }, square)).toBe(false);
  });

  it("treats degenerate polygons as empty except on their edges", () => {
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, [])).toBe(false);
    const line = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, line)).toBe(true);
    expect(pointInPolygon({ x: 0.5, y: 0.4 }, line)).toBe(false);
  });
});

describe("snapSeatToVenue", () => {
  const venue = {
    shapes: [
      { id: "a", points: rect(0, 0, 0.4, 1) },
      { id: "b", points: rect(0.6, 0, 1, 1) },
    ],
  };

  it("leaves a seat inside a shape unchanged", () => {
    const p = { x: 0.2, y: 0.3 };
    expect(snapSeatToVenue(venue, p)).toBe(p);
    expect(snapSeatToVenue(venue, { x: 0.4, y: 0.5 })).toEqual({
      x: 0.4,
      y: 0.5,
    });
  });

  it("snaps a seat in the aisle to the nearer shape edge", () => {
    expect(snapSeatToVenue(venue, { x: 0.45, y: 0.5 })).toEqual({
      x: 0.4,
      y: 0.5,
    });
    expect(snapSeatToVenue(venue, { x: 0.58, y: 0.5 })).toEqual({
      x: 0.6,
      y: 0.5,
    });
  });

  it("snaps a seat past a corner onto the corner", () => {
    expect(snapSeatToVenue(venue, { x: 1.1, y: -0.1 })).toEqual({
      x: 1,
      y: 0,
    });
  });

  it("leaves the seat unchanged when the venue has no shapes", () => {
    const p = { x: 2, y: 2 };
    expect(snapSeatToVenue({ shapes: [] }, p)).toBe(p);
  });
});
