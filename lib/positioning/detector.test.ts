import { describe, expect, it } from "vitest";
import { Detector, solvePose } from "./detector";
import { renderView, type SyntheticView } from "./synthetic";

type Scene = [label: string, view: SyntheticView];

// Synthetic camera views with known positions. Real phones add an unknown
// field of view on top (see lens.test.ts); these pin down the geometry.
const SCENES: Scene[] = [
  [
    "front row centre",
    { width: 3, pos: { x: 0, y: -1, z: 4 }, aim: [0.2, 0.1] },
  ],
  ["mid left", { width: 3, pos: { x: -4, y: -0.5, z: 10 }, roll: 0.3 }],
  [
    "back right",
    { width: 3, pos: { x: 6, y: -1, z: 15 }, aim: [-0.3, 0.2], roll: -0.2 },
  ],
  [
    "portrait phone",
    { width: 3, pos: { x: -2, y: -1, z: 8 }, roll: Math.PI / 2 },
  ],
  ["upside down", { width: 3, pos: { x: 3, y: 0, z: 9 }, roll: Math.PI }],
  [
    "laptop on a desk",
    { width: 0.3, pos: { x: 0.1, y: 0.05, z: 0.6 }, roll: 0.1 },
  ],
  [
    "blurry and noisy",
    { width: 3, pos: { x: -3, y: -1, z: 14 }, noise: 14, blur: 3, roll: 0.4 },
  ],
];

describe("Detector + solvePose", () => {
  it.each(SCENES)("finds the camera: %s", (_label, view) => {
    const { gray, w, h, f } = renderView(view);
    const found = new Detector().detect(gray, w, h);
    expect(found).not.toBeNull();
    const pose = solvePose(found!.matches, { f, cx: w / 2, cy: h / 2 });
    expect(pose).not.toBeNull();
    const { pos, width } = view;
    const err = Math.hypot(
      pose!.x * width - pos.x,
      pose!.y * width - pos.y,
      pose!.z * width - pos.z,
    );
    expect(err / Math.hypot(pos.x, pos.y, pos.z)).toBeLessThan(0.05);
  });

  it("reads the grille, not just the anchors, at mid range", () => {
    const view = { width: 3, pos: { x: 2, y: -1, z: 8 } };
    const { gray, w, h } = renderView(view);
    const found = new Detector().detect(gray, w, h);
    expect(found?.coarse).toBe(false);
    expect(found?.score).toBeGreaterThan(0.9);
    expect(found?.matches.length).toBeGreaterThan(200);
  });

  it("falls back to the anchors alone when the grille is too small to read", () => {
    const view = { width: 3, pos: { x: 7, y: -1, z: 28 } };
    const { gray, w, h, f } = renderView(view);
    const found = new Detector().detect(gray, w, h);
    expect(found?.coarse).toBe(true);
    const pose = solvePose(found!.matches, { f, cx: w / 2, cy: h / 2 });
    expect(Math.abs(pose!.z * 3 - 28) / 28).toBeLessThan(0.05);
  });

  it("returns null when the screen is out of view", () => {
    const { gray, w, h } = renderView({
      width: 3,
      pos: { x: 0, y: 0, z: 5 },
      aim: [40, 0],
    });
    expect(new Detector().detect(gray, w, h)).toBeNull();
  });
});
