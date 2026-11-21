import { describe, expect, it } from "vitest";
import { compileSchedule, colorAt } from "./compile";
import { averageColor, imagePixel, imageRect } from "./image";
import type { Clip, ImageShape, Show } from "./types";

/** A 2 x 1 picture: red on the left, transparent on the right. */
const halfRed: ImageShape = {
  kind: "image",
  w: 2,
  h: 1,
  pixels: "ff0000ff" + "00000000",
  fit: "contain",
};

describe("imageRect", () => {
  it("fits a wide picture across the room, or fills the room with it", () => {
    expect(imageRect({ w: 2, h: 1, fit: "contain" })).toEqual({
      x: 0,
      y: 0.25,
      w: 1,
      h: 0.5,
    });
    expect(imageRect({ w: 2, h: 1, fit: "cover" })).toEqual({
      x: -0.5,
      y: 0,
      w: 2,
      h: 1,
    });
  });

  it("does the same for a tall picture", () => {
    expect(imageRect({ w: 1, h: 2, fit: "contain" })).toEqual({
      x: 0.25,
      y: 0,
      w: 0.5,
      h: 1,
    });
  });
});

describe("imagePixel", () => {
  it("reads the pixel over a seat, and nothing where it's clear or absent", () => {
    expect(imagePixel(halfRed, { x: 0.2, y: 0.5 })).toEqual({
      r: 255,
      g: 0,
      b: 0,
    });
    // Transparent half.
    expect(imagePixel(halfRed, { x: 0.8, y: 0.5 })).toBeNull();
    // Above the letterboxed picture.
    expect(imagePixel(halfRed, { x: 0.2, y: 0.1 })).toBeNull();
  });

  it("averages the opaque pixels for the timeline colour", () => {
    expect(averageColor(halfRed)).toBe("#ff0000");
  });
});

describe("image clips in a show", () => {
  const clip = (over: Partial<Clip>): Clip => ({
    id: "c",
    layer: 0,
    startMs: 0,
    endMs: 1000,
    color: "#ffffff",
    fadeInMs: 0,
    fadeOutMs: 0,
    shape: { kind: "fill" },
    ...over,
  });
  const show: Show = {
    id: "s",
    name: "s",
    venue: { shapes: [] },
    audio: { fileId: "", durationMs: 1000 },
    clips: [
      clip({ id: "under", color: "#0000ff" }),
      clip({ id: "image", layer: 1, shape: halfRed }),
    ],
    createdAt: "",
    updatedAt: "",
  };

  it("shows the picture's colours, and the clip below where it's clear", () => {
    expect(colorAt(show, { x: 0.2, y: 0.5 }, 100)).toBe("#ff0000");
    expect(colorAt(show, { x: 0.8, y: 0.5 }, 100)).toBe("#0000ff");
  });

  it("compiles the same as the preview", () => {
    for (const seat of [
      { x: 0.2, y: 0.5 },
      { x: 0.8, y: 0.5 },
    ]) {
      const [first] = compileSchedule(show, seat).events;
      expect(first!.color).toBe(colorAt(show, seat, 0));
    }
  });
});
