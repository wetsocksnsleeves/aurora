import { describe, expect, it } from "vitest";
import { SAMPLE_MS, compileSchedule, pointInPolygon } from "@/lib/compile";
import { liveDotColor } from "@/lib/host-map";
import type { Clip, Point, Schedule, Show } from "@/lib/types";
import { previewColors, previewDots, sampleTimeAt } from "./preview";
import { editorReducer, initialEditorState } from "./store";
import { makeShow } from "./test-fixtures";

const rect = (x0: number, y0: number, x1: number, y1: number): Point[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

function clip(overrides: Partial<Clip> & Pick<Clip, "id">): Clip {
  return {
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

/** A show with every clip kind: wave, split block, flash with fades, a brush shape, layer ties. */
const show: Show = makeShow({
  venue: {
    shapes: [
      { id: "stalls", points: rect(0.05, 0.1, 0.95, 0.55) },
      {
        id: "balcony",
        points: [
          { x: 0.1, y: 0.6 },
          { x: 0.9, y: 0.6 },
          { x: 0.7, y: 0.95 },
          { x: 0.3, y: 0.95 },
        ],
      },
    ],
  },
  audio: { fileId: "", durationMs: 10_000 },
  clips: [
    clip({
      id: "wave",
      startMs: 1000,
      endMs: 5000,
      shape: {
        kind: "polygon",
        points: rect(0, 0, 0.1, 1),
        moveTo: { x: 0.85, y: 0 },
      },
    }),
    clip({
      id: "left",
      layer: 1,
      startMs: 5000,
      endMs: 6000,
      color: "#ff0000",
      shape: { kind: "polygon", points: rect(0, 0, 0.5, 1) },
    }),
    clip({
      id: "right",
      layer: 1,
      startMs: 5000,
      endMs: 6000,
      color: "#0000ff",
      shape: { kind: "polygon", points: rect(0.5, 0, 1, 1) },
    }),
    clip({
      id: "flash",
      layer: 2,
      startMs: 5500,
      endMs: 7000,
      color: "#ffcc00",
      fadeInMs: 300,
      fadeOutMs: 700,
    }),
    clip({
      id: "tie",
      layer: 2,
      startMs: 6000,
      endMs: 6500,
      color: "#00ff00",
      shape: {
        kind: "polygon",
        points: [
          { x: 0.5, y: 0.2 },
          { x: 0.8, y: 0.5 },
          { x: 0.5, y: 0.8 },
          { x: 0.2, y: 0.5 },
        ],
      },
    }),
  ],
});

function colorFromSchedule(schedule: Schedule, tMs: number): string {
  let color = "#000000";
  for (const e of schedule.events) {
    if (e.tMs > tMs) break;
    color = e.color;
  }
  return color;
}

describe("preview dots", () => {
  it("fills a full-venue grid", () => {
    const full = { shapes: [{ id: "all", points: rect(0, 0, 1, 1) }] };
    expect(previewDots(full)).toHaveLength(1600);
    expect(previewDots(full, 10)[0]).toEqual({ x: 0.05, y: 0.05 });
  });

  it("keeps only dots inside a venue shape", () => {
    const dots = previewDots(show.venue);
    expect(dots.length).toBeGreaterThan(800);
    expect(dots.length).toBeLessThan(1600);
    for (const d of dots) {
      expect(show.venue.shapes.some((s) => pointInPolygon(d, s.points))).toBe(
        true,
      );
    }
  });

  it("is empty without a venue", () => {
    expect(previewDots({ shapes: [] })).toEqual([]);
  });
});

describe("preview colours", () => {
  it("equal the compiled schedule's colour at any time", () => {
    const dots = previewDots(show.venue, 12);
    const schedules = dots.map((d) => compileSchedule(show, d));
    // Sample times plus off-grid times, across every clip and the edges.
    const times: number[] = [];
    for (let t = 0; t <= 10_100; t += 37) times.push(t);
    times.push(999, 1000, 1001, 4999, 5000, 5519, 5520, 6999, 7000, 9999);
    for (const t of times) {
      const colors = previewColors(show, dots, t);
      dots.forEach((_, i) => {
        expect(colors[i], `dot ${i} at ${t} ms`).toBe(
          colorFromSchedule(schedules[i], t),
        );
      });
    }
  });

  it("match the host map's playing colours at every sample", () => {
    const dots = previewDots(show.venue, 12);
    const participants = dots.map((d, i) => ({
      id: `p${i}`,
      x: d.x,
      y: d.y,
      state: "playing" as const,
      rttMs: 20,
      degraded: false,
    }));
    for (let t = 0; t < 10_000; t += SAMPLE_MS * 7) {
      const hostColor = liveDotColor(show, t);
      expect(previewColors(show, dots, t)).toEqual(participants.map(hostColor));
    }
  });

  it("shows the wave, the split block and the flash", () => {
    const left = { x: 0.25, y: 0.3 };
    const right = { x: 0.75, y: 0.3 };
    const at = (p: Point, t: number) => previewColors(show, [p], t)[0];
    expect(at(left, 5200)).toBe("#ff0000");
    expect(at(right, 5200)).toBe("#0000ff");
    // The flash on layer 2 covers the split block at full brightness.
    expect(at(left, 6600)).not.toBe("#ff0000");
    // The wave reaches x = 0.5 about halfway through.
    expect(at({ x: 0.5, y: 0.3 }, 1000)).toBe("#000000");
    expect(at({ x: 0.5, y: 0.3 }, 3000)).toBe("#ffffff");
  });

  it("reuses the output array", () => {
    const out: string[] = ["stale", "stale", "stale"];
    const result = previewColors(show, [{ x: 0.5, y: 0.3 }], 3000, out);
    expect(result).toBe(out);
    expect(out).toEqual(["#ffffff"]);
  });
});

describe("sampleTimeAt", () => {
  it("rounds down to the compiler's 20 ms samples", () => {
    expect(sampleTimeAt(show, 0)).toBe(0);
    expect(sampleTimeAt(show, 19.9)).toBe(0);
    expect(sampleTimeAt(show, 1234)).toBe(1220);
  });

  it("holds the last sample past the end of the show", () => {
    expect(sampleTimeAt(show, 10_000)).toBe(9980);
    expect(sampleTimeAt(show, 50_000)).toBe(9980);
    expect(sampleTimeAt(show, -5)).toBe(0);
  });
});

describe("preview mode", () => {
  it("toggles between the clip overlay and seat dots", () => {
    let state = initialEditorState(makeShow());
    expect(state.previewMode).toBe("clips");
    state = editorReducer(state, { type: "setPreviewMode", mode: "dots" });
    expect(state.previewMode).toBe("dots");
    expect(editorReducer(state, { type: "setPreviewMode", mode: "dots" })).toBe(
      state,
    );
  });
});
