import { describe, expect, it } from "vitest";
import { colorAt, compileSchedule, pointInPolygon } from "@/lib/compile";
import type { Clip, Point } from "@/lib/types";
import {
  activeClips,
  brushPolygon,
  clipOffsetAt,
  clipPolygonAt,
  dragClipTiming,
  laneRows,
  makeClip,
  newClipTiming,
  simplifyPath,
  topLayer,
} from "./clips";
import { DEFAULT_SNAP, type SnapSettings } from "./snap";
import { editorReducer, initialEditorState, isDirty } from "./store";
import { makeShow, square } from "./test-fixtures";

function clip(overrides: Partial<Clip> = {}): Clip {
  return {
    id: "c1",
    layer: 0,
    startMs: 1000,
    endMs: 2000,
    color: "#ff0000",
    fadeInMs: 0,
    fadeOutMs: 0,
    shape: { kind: "polygon", points: square },
    ...overrides,
  };
}

const snap100: SnapSettings = DEFAULT_SNAP;
const snapOff: SnapSettings = { ...DEFAULT_SNAP, mode: "off" };

describe("new clips", () => {
  it("start at the snapped playhead and last one second", () => {
    expect(newClipTiming(1234, snap100, 10_000)).toEqual({
      startMs: 1200,
      endMs: 2200,
    });
    expect(newClipTiming(1234, snapOff, 10_000)).toEqual({
      startMs: 1234,
      endMs: 2234,
    });
  });

  it("shift left to fit before the end of the audio", () => {
    expect(newClipTiming(9_950, snap100, 10_000)).toEqual({
      startMs: 9_000,
      endMs: 10_000,
    });
  });

  it("are not clamped while the duration is unknown", () => {
    expect(newClipTiming(0, snap100, 0)).toEqual({ startMs: 0, endMs: 1000 });
  });

  it("go on the top layer in the current colour", () => {
    const existing = [clip({ layer: 3 }), clip({ id: "c2", layer: 1 })];
    expect(topLayer([])).toBe(0);
    expect(topLayer(existing)).toBe(4);
    const made = makeClip(
      {
        clips: existing,
        currentTimeMs: 500,
        snap: snap100,
        durationMs: 10_000,
        color: "#00ff00",
      },
      { kind: "fill" },
      "new",
    );
    expect(made).toEqual({
      id: "new",
      layer: 4,
      startMs: 500,
      endMs: 1500,
      color: "#00ff00",
      fadeInMs: 0,
      fadeOutMs: 0,
      shape: { kind: "fill" },
    });
  });
});

describe("clip reducer actions", () => {
  const start = () =>
    initialEditorState(makeShow({ audio: { fileId: "", durationMs: 10_000 } }));

  it("adds a clip, selects it and marks the show dirty", () => {
    const state = editorReducer(start(), { type: "addClip", clip: clip() });
    expect(state.show.clips).toEqual([clip()]);
    expect(state.selection).toEqual({ kind: "clip", id: "c1" });
    expect(isDirty(state)).toBe(true);
  });

  it("updates colour, fades and times", () => {
    let state = editorReducer(start(), { type: "addClip", clip: clip() });
    state = editorReducer(state, {
      type: "updateClip",
      id: "c1",
      patch: { color: "#123456", fadeInMs: 200, fadeOutMs: 300 },
    });
    expect(state.show.clips[0]).toMatchObject({
      color: "#123456",
      fadeInMs: 200,
      fadeOutMs: 300,
    });
    state = editorReducer(state, {
      type: "updateClip",
      id: "c1",
      patch: { startMs: 500, endMs: 4000 },
    });
    expect(state.show.clips[0]).toMatchObject({ startMs: 500, endMs: 4000 });
  });

  it("repairs invalid edits", () => {
    let state = editorReducer(start(), { type: "addClip", clip: clip() });
    // End before start: the end moves to one grid step after the start.
    state = editorReducer(state, {
      type: "updateClip",
      id: "c1",
      patch: { endMs: 500 },
    });
    expect(state.show.clips[0]).toMatchObject({ startMs: 1000, endMs: 1100 });
    // Start after end: the start moves to one step before the end.
    state = editorReducer(state, {
      type: "updateClip",
      id: "c1",
      patch: { startMs: 5000 },
    });
    expect(state.show.clips[0]).toMatchObject({ startMs: 1000, endMs: 1100 });
    state = editorReducer(state, {
      type: "updateClip",
      id: "c1",
      patch: { startMs: -50, fadeInMs: -1, fadeOutMs: Number.NaN },
    });
    expect(state.show.clips[0]).toMatchObject({
      startMs: 0,
      fadeInMs: 0,
      fadeOutMs: 0,
    });
  });

  it("ignores no-op updates and unknown ids", () => {
    const state = editorReducer(start(), { type: "addClip", clip: clip() });
    expect(
      editorReducer(state, {
        type: "updateClip",
        id: "c1",
        patch: { color: "#ff0000" },
      }),
    ).toBe(state);
    expect(
      editorReducer(state, { type: "updateClip", id: "x", patch: {} }),
    ).toBe(state);
  });

  it("deletes the selected clip with deleteSelection", () => {
    let state = editorReducer(start(), { type: "addClip", clip: clip() });
    state = editorReducer(state, { type: "deleteSelection" });
    expect(state.show.clips).toEqual([]);
    expect(state.selection).toBeNull();
  });

  it("moves a clip up and down a layer, winning ties when moved up", () => {
    let state = start();
    state = editorReducer(state, { type: "addClip", clip: clip({ id: "a" }) });
    state = editorReducer(state, {
      type: "addClip",
      clip: clip({ id: "b", layer: 1, color: "#0000ff" }),
    });
    const inside = { x: 0.3, y: 0.3 };
    expect(colorAt(state.show, inside, 1500)).toBe("#0000ff");

    state = editorReducer(state, {
      type: "moveClipLayer",
      id: "a",
      direction: 1,
    });
    expect(state.show.clips.map((c) => [c.id, c.layer])).toEqual([
      ["b", 1],
      ["a", 1],
    ]);
    // Same layer, but "a" is later in the list, so it draws on top.
    expect(colorAt(state.show, inside, 1500)).toBe("#ff0000");

    state = editorReducer(state, {
      type: "moveClipLayer",
      id: "a",
      direction: -1,
    });
    expect(state.show.clips.map((c) => [c.id, c.layer])).toEqual([
      ["a", 0],
      ["b", 1],
    ]);
    expect(colorAt(state.show, inside, 1500)).toBe("#0000ff");
  });

  it("sets the colour for new clips", () => {
    const state = editorReducer(start(), {
      type: "setClipColor",
      color: "#abcdef",
    });
    expect(state.clipColor).toBe("#abcdef");
    expect(isDirty(state)).toBe(false);
  });
});

describe("timeline drags", () => {
  const original = { startMs: 1000, endMs: 2000 };

  it("moves a clip on the grid, keeping its length", () => {
    expect(dragClipTiming(original, "move", 1234, snap100, 10_000)).toEqual({
      startMs: 2200,
      endMs: 3200,
    });
  });

  it("keeps a moved clip inside the audio", () => {
    expect(dragClipTiming(original, "move", -5000, snap100, 10_000)).toEqual({
      startMs: 0,
      endMs: 1000,
    });
    expect(dragClipTiming(original, "move", 50_000, snap100, 10_000)).toEqual({
      startMs: 9000,
      endMs: 10_000,
    });
  });

  it("moves the start and end handles, snapped", () => {
    expect(dragClipTiming(original, "start", -260, snap100, 10_000)).toEqual({
      startMs: 700,
      endMs: 2000,
    });
    expect(dragClipTiming(original, "end", 440, snap100, 10_000)).toEqual({
      startMs: 1000,
      endMs: 2400,
    });
  });

  it("never makes a clip shorter than one grid step", () => {
    expect(dragClipTiming(original, "start", 5000, snap100, 10_000)).toEqual({
      startMs: 1900,
      endMs: 2000,
    });
    expect(dragClipTiming(original, "end", -5000, snap100, 10_000)).toEqual({
      startMs: 1000,
      endMs: 1100,
    });
  });
});

describe("lane rows", () => {
  it("stacks overlapping clips by layer and reuses rows otherwise", () => {
    const clips = [
      clip({ id: "top", layer: 5, startMs: 0, endMs: 1000 }),
      clip({ id: "bottom", layer: 1, startMs: 500, endMs: 1500 }),
      clip({ id: "later", layer: 9, startMs: 3000, endMs: 4000 }),
      clip({ id: "middle", layer: 3, startMs: 200, endMs: 800 }),
    ];
    const { rows, count } = laneRows(clips);
    expect(rows.get("bottom")).toBe(0);
    expect(rows.get("middle")).toBe(1);
    expect(rows.get("top")).toBe(2);
    expect(rows.get("later")).toBe(0);
    expect(count).toBe(3);
  });
});

describe("brush simplification", () => {
  it("drops points that lie on a straight line", () => {
    const line = Array.from({ length: 11 }, (_, i) => ({ x: i / 10, y: 0.5 }));
    expect(simplifyPath(line, 0.001)).toEqual([line[0], line[10]]);
  });

  it("keeps corners", () => {
    const path: Point[] = [];
    for (let i = 0; i <= 10; i++) path.push({ x: 0.1 + i * 0.05, y: 0.1 });
    for (let i = 1; i <= 10; i++) path.push({ x: 0.6, y: 0.1 + i * 0.05 });
    expect(simplifyPath(path, 0.001)).toEqual([
      { x: 0.1, y: 0.1 },
      { x: 0.6, y: 0.1 },
      { x: 0.6, y: 0.6 },
    ]);
  });

  it("closes a noisy circle into a small polygon that covers its centre", () => {
    const stroke: Point[] = [];
    for (let i = 0; i <= 400; i++) {
      const a = (i / 400) * Math.PI * 2;
      const r = 0.2 + (i % 2 ? 0.0005 : -0.0005);
      stroke.push({ x: 0.5 + r * Math.cos(a), y: 0.5 + r * Math.sin(a) });
    }
    const polygon = brushPolygon(stroke, 0.004)!;
    expect(polygon.length).toBeGreaterThanOrEqual(8);
    expect(polygon.length).toBeLessThan(60);
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, polygon)).toBe(true);
    expect(pointInPolygon({ x: 0.75, y: 0.5 }, polygon)).toBe(false);
  });

  it("caps the number of points", () => {
    const stroke: Point[] = [];
    for (let i = 0; i < 3000; i++) {
      const a = (i / 3000) * Math.PI * 2;
      const r = 0.3 + 0.05 * Math.sin(i * 1.7);
      stroke.push({ x: 0.5 + r * Math.cos(a), y: 0.5 + r * Math.sin(a) });
    }
    const polygon = brushPolygon(stroke, 1e-6, 50)!;
    expect(polygon.length).toBeLessThanOrEqual(50);
    expect(polygon.length).toBeGreaterThanOrEqual(3);
  });

  it("rejects strokes that enclose nothing", () => {
    expect(brushPolygon([{ x: 0.1, y: 0.1 }], 0.001)).toBeNull();
    expect(
      brushPolygon(
        [
          { x: 0.1, y: 0.1 },
          { x: 0.5, y: 0.5 },
          { x: 0.9, y: 0.9 },
        ],
        0.001,
      ),
    ).toBeNull();
  });
});

describe("moving-shape interpolation", () => {
  // A strip on the left that sweeps right by 0.8 over 2 s.
  const strip = [
    { x: 0, y: 0 },
    { x: 0.1, y: 0 },
    { x: 0.1, y: 1 },
    { x: 0, y: 1 },
  ];
  const wave = clip({
    startMs: 1000,
    endMs: 3000,
    color: "#ffffff",
    shape: { kind: "polygon", points: strip, moveTo: { x: 0.8, y: 0 } },
  });
  const venue = {
    shapes: [
      {
        id: "v",
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
      },
    ],
  };
  const show = makeShow({
    venue,
    audio: { fileId: "", durationMs: 4000 },
    clips: [wave],
  });

  it("offsets by moveTo times progress", () => {
    expect(clipOffsetAt(wave, 1000)).toEqual({ x: 0, y: 0 });
    expect(clipOffsetAt(wave, 2000)).toEqual({ x: 0.4, y: 0 });
    expect(clipPolygonAt(wave, 2500)![0].x).toBeCloseTo(0.6);
  });

  it("matches what lib/compile.ts lights at every sample", () => {
    for (let t = 1000; t < 3000; t += 20) {
      const polygon = clipPolygonAt(wave, t)!;
      const left = polygon[0].x;
      // Just inside the overlay's strip, and well outside it.
      const inside = { x: left + 0.05, y: 0.5 };
      const outside = { x: left + 0.3, y: 0.5 };
      expect(colorAt(show, inside, t)).toBe("#ffffff");
      if (outside.x < 1) expect(colorAt(show, outside, t)).toBe("#000000");
    }
  });

  it("agrees with the compiled schedule", () => {
    const seat = { x: 0.5, y: 0.5 };
    const { events } = compileSchedule(show, seat);
    const on = events.find((e) => e.color === "#ffffff")!;
    const off = events.find((e) => e.tMs > on.tMs)!;
    // The overlay's strip covers x = 0.5 from progress 0.4/0.8 to 0.5/0.8.
    const onAt = (t: number) => pointInPolygon(seat, clipPolygonAt(wave, t)!);
    expect(onAt(on.tMs)).toBe(true);
    expect(onAt(on.tMs - 20)).toBe(false);
    expect(onAt(off.tMs - 20)).toBe(true);
    expect(onAt(off.tMs)).toBe(false);
  });

  it("draws active clips bottom to top like the compiler", () => {
    const clips = [
      clip({ id: "hi", layer: 2 }),
      clip({ id: "lo", layer: 0 }),
      clip({ id: "tie", layer: 2 }),
      clip({ id: "gone", startMs: 0, endMs: 500 }),
    ];
    expect(activeClips(clips, 1500).map((c) => c.id)).toEqual([
      "lo",
      "hi",
      "tie",
    ]);
  });
});
