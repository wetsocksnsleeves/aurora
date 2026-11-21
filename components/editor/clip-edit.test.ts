import { describe, expect, it } from "vitest";
import type { Clip } from "@/lib/types";
import { freeLayer, snapToTargets, splitClip } from "./clips";

const clip = (over: Partial<Clip>): Clip => ({
  id: "a",
  layer: 0,
  startMs: 0,
  endMs: 1000,
  color: "#ffffff",
  fadeInMs: 100,
  fadeOutMs: 200,
  shape: { kind: "fill" },
  ...over,
});

describe("splitClip", () => {
  it("cuts a clip in two at the playhead", () => {
    const [a, b] = splitClip(clip({}), 400, "b")!;
    expect(a).toMatchObject({ id: "a", startMs: 0, endMs: 400, fadeOutMs: 0 });
    expect(b).toMatchObject({
      id: "b",
      startMs: 400,
      endMs: 1000,
      fadeInMs: 0,
    });
    expect(a.fadeInMs).toBe(100);
    expect(b.fadeOutMs).toBe(200);
  });

  it("keeps a wave moving across the cut", () => {
    const wave = clip({
      shape: {
        kind: "pattern",
        pattern: "wave",
        direction: "right",
        size: 0.2,
        stepMs: 250,
        from: 0,
        to: 1,
      },
    });
    const [a, b] = splitClip(wave, 250, "b")!;
    expect(a.shape).toMatchObject({ from: 0, to: 0.25 });
    expect(b.shape).toMatchObject({ from: 0.25, to: 1 });
  });

  it("carries a moving shape on from where it got to", () => {
    const moving = clip({
      shape: {
        kind: "polygon",
        points: [
          { x: 0, y: 0 },
          { x: 0.1, y: 0 },
          { x: 0.1, y: 0.1 },
        ],
        moveTo: { x: 0.8, y: 0 },
      },
    });
    const [a, b] = splitClip(moving, 500, "b")!;
    expect(a.shape).toMatchObject({ moveTo: { x: 0.4, y: 0 } });
    expect(b.shape).toMatchObject({ moveTo: { x: 0.4, y: 0 } });
    if (b.shape.kind !== "polygon") throw new Error("polygon");
    expect(b.shape.points[0]).toEqual({ x: 0.4, y: 0 });
  });

  it("refuses a cut outside the clip", () => {
    expect(splitClip(clip({}), 0, "b")).toBeNull();
    expect(splitClip(clip({}), 1000, "b")).toBeNull();
  });
});

describe("freeLayer", () => {
  it("finds the lowest track with room", () => {
    const clips = [clip({}), clip({ id: "b", layer: 1, startMs: 500 })];
    expect(freeLayer(clips, 200, 400)).toBe(1);
    expect(freeLayer(clips, 600, 800)).toBe(2);
    expect(freeLayer(clips, 1000, 1200)).toBe(0);
    expect(freeLayer(clips, 600, 800, 0, "b")).toBe(1);
  });
});

describe("snapToTargets", () => {
  it("snaps to the nearest target in range", () => {
    expect(snapToTargets(1040, [1000, 2000], 50)).toBe(1000);
    expect(snapToTargets(1100, [1000, 2000], 50)).toBeNull();
  });
});
