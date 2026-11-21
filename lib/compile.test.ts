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

describe("moving polygons", () => {
  // A 0.2-wide band starting at the left edge that slides right by 0.8 over
  // 1000 ms: its left edge is at 0.8 * t / 1000.
  const band = clip({
    startMs: 0,
    endMs: 1000,
    shape: {
      kind: "polygon",
      points: rect(0, 0, 0.2, 1),
      moveTo: { x: 0.8, y: 0 },
    },
  });
  const s = show([band], 1000);

  it("interpolates the offset linearly from startMs to endMs", () => {
    // Seat at x = 0.5 is covered while 0.3 <= 0.8 * t / 1000 <= 0.5,
    // i.e. t in [375, 625].
    expect(colorAt(s, { x: 0.5, y: 0.5 }, 360)).toBe("#000000");
    expect(colorAt(s, { x: 0.5, y: 0.5 }, 380)).toBe("#ffffff");
    expect(colorAt(s, { x: 0.5, y: 0.5 }, 620)).toBe("#ffffff");
    expect(colorAt(s, { x: 0.5, y: 0.5 }, 640)).toBe("#000000");
  });

  it("produces a wave: seats further right light up later", () => {
    const onsets = [0.1, 0.3, 0.5, 0.7, 0.9].map((x) => {
      const { events } = compileSchedule(s, { x, y: 0.5 });
      return events.find((e) => e.color === "#ffffff")?.tMs;
    });
    expect(onsets).toEqual([0, 140, 380, 640, 880]);
  });

  it("moves vertically and diagonally too", () => {
    const diag = show(
      [
        clip({
          startMs: 0,
          endMs: 1000,
          shape: {
            kind: "polygon",
            points: rect(0, 0, 0.1, 0.1),
            moveTo: { x: 0.5, y: 0.5 },
          },
        }),
      ],
      1000,
    );
    expect(colorAt(diag, { x: 0.3, y: 0.3 }, 500)).toBe("#ffffff");
    expect(colorAt(diag, { x: 0.3, y: 0.3 }, 0)).toBe("#000000");
  });

  it("treats moveTo of zero as a static polygon", () => {
    const still = show([
      clip({
        shape: {
          kind: "polygon",
          points: rect(0, 0, 0.2, 1),
          moveTo: { x: 0, y: 0 },
        },
      }),
    ]);
    expect(colorAt(still, { x: 0.1, y: 0.5 }, 900)).toBe("#ffffff");
    expect(colorAt(still, { x: 0.5, y: 0.5 }, 900)).toBe("#000000");
  });
});

describe("fades", () => {
  it("ramps up over fadeInMs and down over fadeOutMs", () => {
    const s = show([
      clip({
        startMs: 0,
        endMs: 1000,
        color: "#ff8000",
        fadeInMs: 200,
        fadeOutMs: 400,
      }),
    ]);
    expect(colorAt(s, centre, 0)).toBe("#000000");
    expect(colorAt(s, centre, 100)).toBe("#804000"); // 0.5
    expect(colorAt(s, centre, 200)).toBe("#ff8000");
    expect(colorAt(s, centre, 600)).toBe("#ff8000");
    expect(colorAt(s, centre, 800)).toBe("#804000"); // 0.5
    expect(colorAt(s, centre, 900)).toBe("#402000"); // 0.25
    expect(colorAt(s, centre, 1000)).toBe("#000000"); // clip over
  });

  it("emits one event per changed 20 ms sample during a fade", () => {
    const s = show([clip({ startMs: 0, endMs: 400, fadeInMs: 200 })], 400);
    const { events } = compileSchedule(s, centre);
    expect(events.slice(0, 11).map((e) => e.tMs)).toEqual(
      Array.from({ length: 11 }, (_, i) => i * 20),
    );
    expect(events.slice(0, 11).map((e) => e.color)).toEqual([
      "#000000",
      "#1a1a1a",
      "#333333",
      "#4d4d4d",
      "#666666",
      "#808080",
      "#999999",
      "#b3b3b3",
      "#cccccc",
      "#e6e6e6",
      "#ffffff",
    ]);
    expect(events).toHaveLength(11);
  });

  it("caps the envelope when fades overlap in a short clip", () => {
    const s = show([
      clip({ startMs: 0, endMs: 200, fadeInMs: 200, fadeOutMs: 200 }),
    ]);
    // At 100 ms both ramps are at 0.5.
    expect(colorAt(s, centre, 100)).toBe("#808080");
  });

  it("fades the top layer toward black rather than revealing lower layers", () => {
    const s = show([
      clip({ layer: 0, color: "#ff0000" }),
      clip({ layer: 1, color: "#0000ff", fadeInMs: 1000 }),
    ]);
    expect(colorAt(s, centre, 500)).toBe("#000080");
  });

  it("fades a moving polygon", () => {
    const s = show([
      clip({
        startMs: 0,
        endMs: 1000,
        fadeInMs: 500,
        shape: {
          kind: "polygon",
          points: rect(0, 0, 1, 1),
          moveTo: { x: 0, y: 0.1 },
        },
      }),
    ]);
    expect(colorAt(s, { x: 0.5, y: 0.5 }, 250)).toBe("#808080");
  });
});

describe("effects", () => {
  const pattern = (
    over: Partial<Extract<Clip["shape"], { kind: "pattern" }>>,
  ): Clip["shape"] => ({
    kind: "pattern",
    pattern: "wave",
    direction: "right",
    size: 0.2,
    stepMs: 250,
    from: 0,
    to: 1,
    ...over,
  });

  it("moves a wave across the room", () => {
    const s = show([clip({ shape: pattern({}) })]);
    // Half way through, the band is in the middle, not at the edges.
    expect(colorAt(s, { x: 0.5, y: 0.5 }, 500)).toBe("#ffffff");
    expect(colorAt(s, { x: 0.05, y: 0.5 }, 500)).toBe("#000000");
    expect(colorAt(s, { x: 0.95, y: 0.5 }, 500)).toBe("#000000");
    // Early on it is at the left.
    expect(colorAt(s, { x: 0.05, y: 0.5 }, 100)).not.toBe("#000000");
  });

  it("splits from the middle out", () => {
    const s = show([clip({ shape: pattern({ pattern: "split" }) })]);
    expect(colorAt(s, { x: 0.5, y: 0.5 }, 50)).not.toBe("#000000");
    expect(colorAt(s, { x: 0.5, y: 0.5 }, 900)).toBe("#000000");
    expect(colorAt(s, { x: 0.05, y: 0.5 }, 900)).not.toBe("#000000");
  });

  it("chases one column at a time", () => {
    const s = show([
      clip({ shape: pattern({ pattern: "chase", size: 0.25, stepMs: 250 }) }),
    ]);
    // Step 0 lights the first quarter, step 1 the second.
    expect(colorAt(s, { x: 0.1, y: 0.5 }, 0)).toBe("#ffffff");
    expect(colorAt(s, { x: 0.3, y: 0.5 }, 0)).toBe("#000000");
    expect(colorAt(s, { x: 0.3, y: 0.5 }, 260)).toBe("#ffffff");
  });

  it("sparkles about the share of seats asked for", () => {
    const s = show([
      clip({ shape: pattern({ pattern: "sparkle", size: 0.3, stepMs: 200 }) }),
    ]);
    let lit = 0;
    for (let i = 0; i < 400; i++) {
      const seat = { x: (i % 20) / 20 + 0.01, y: Math.floor(i / 20) / 20 };
      if (colorAt(s, seat, 0) !== "#000000") lit++;
    }
    expect(lit / 400).toBeGreaterThan(0.2);
    expect(lit / 400).toBeLessThan(0.4);
  });

  it("lets a clip below show through while a blink is off", () => {
    const s = show([
      clip({ color: "#ff0000", layer: 0 }),
      clip({ layer: 1, blink: { periodMs: 200, duty: 0.5, soft: false } }),
    ]);
    expect(colorAt(s, centre, 40)).toBe("#ffffff");
    expect(colorAt(s, centre, 140)).toBe("#ff0000");
  });

  it("compiles effects the same as the preview", () => {
    const s = show([
      clip({ shape: pattern({}), endMs: 1500 }),
      clip({
        layer: 1,
        startMs: 300,
        blink: { periodMs: 400, duty: 0.5, soft: true },
      }),
    ]);
    for (const seat of [centre, { x: 0.1, y: 0.9 }]) {
      const { events } = compileSchedule(s, seat);
      for (let t = 0; t < 2000; t += SAMPLE_MS) {
        const at = events.filter((e) => e.tMs <= t).at(-1)!;
        expect(at.color).toBe(colorAt(s, seat, t));
      }
    }
  });
});

describe("benchmark", () => {
  it("compiles a 3-minute show for one seat in under 10 ms", () => {
    // 3 minutes of mixed content: a fill every 2 s, a wave every 4 s across
    // the venue, and fading polygon blocks on two layers.
    const clips: Clip[] = [];
    for (let t = 0; t < 180_000; t += 2000) {
      clips.push(
        clip({ layer: 0, startMs: t, endMs: t + 1000, color: "#202020" }),
      );
    }
    for (let t = 0; t < 180_000; t += 4000) {
      clips.push(
        clip({
          layer: 1,
          startMs: t,
          endMs: t + 2000,
          color: "#00ffcc",
          shape: {
            kind: "polygon",
            points: rect(0, 0, 0.2, 1),
            moveTo: { x: 0.8, y: 0 },
          },
        }),
      );
      clips.push(
        clip({
          layer: 2,
          startMs: t + 1000,
          endMs: t + 3000,
          color: "#ff00ff",
          fadeInMs: 300,
          fadeOutMs: 300,
          shape: { kind: "polygon", points: rect(0.3, 0.3, 0.7, 0.7) },
        }),
      );
    }
    const s = show(clips, 180_000);
    const seat = { x: 0.5, y: 0.5 };

    for (let i = 0; i < 5; i++) compileSchedule(s, seat); // warm up the JIT
    const runs = 20;
    const t0 = performance.now();
    let events = 0;
    for (let i = 0; i < runs; i++)
      events = compileSchedule(s, seat).events.length;
    const avgMs = (performance.now() - t0) / runs;

    console.log(
      `compileSchedule: 3-minute show, ${clips.length} clips, ${events} events, ${avgMs.toFixed(2)} ms per compile`,
    );
    expect(events).toBeGreaterThan(100);
    // Target is 10 ms (DEVELOPMENT.md chunk 9). CI runners are slow and
    // noisy, so the hard limit there is looser; the log line shows the real number.
    expect(avgMs).toBeLessThan(process.env.CI ? 50 : 10);
  });
});
