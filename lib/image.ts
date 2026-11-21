// Image clips (SPEC 3.2): which pixel of a picture sits over a seat. Pure,
// like compile.ts.

import type { ImageShape, Point } from "./types";

/** Alpha below this counts as transparent: the clip doesn't light the seat. */
const OPAQUE = 128;

export type Rgb = { r: number; g: number; b: number };

/**
 * Where the image sits on the 0..1 room: centred, filling it (cover, edges
 * cropped) or inside it (contain, the rest unlit).
 */
export function imageRect(shape: Pick<ImageShape, "w" | "h" | "fit">): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const aspect = shape.w / shape.h;
  const wide = aspect >= 1;
  let width: number;
  let height: number;
  if (shape.fit === "cover") {
    // The short side spans the room; the long side is cropped.
    width = wide ? aspect : 1;
    height = wide ? 1 : 1 / aspect;
  } else {
    // The long side spans the room; the rest is unlit.
    width = wide ? 1 : aspect;
    height = wide ? 1 / aspect : 1;
  }
  return { x: 0.5 - width / 2, y: 0.5 - height / 2, w: width, h: height };
}

/** The pixel over seat `p`, or null where the image is transparent or absent. */
export function imagePixel(shape: ImageShape, p: Point): Rgb | null {
  const rect = imageRect(shape);
  const u = (p.x - rect.x) / rect.w;
  const v = (p.y - rect.y) / rect.h;
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return null;
  const i = (Math.floor(v * shape.h) * shape.w + Math.floor(u * shape.w)) * 8;
  const hex = shape.pixels;
  if (parseInt(hex.slice(i + 6, i + 8), 16) < OPAQUE) return null;
  return {
    r: parseInt(hex.slice(i, i + 2), 16),
    g: parseInt(hex.slice(i + 2, i + 4), 16),
    b: parseInt(hex.slice(i + 4, i + 6), 16),
  };
}

/** The average colour of the opaque pixels, as #rrggbb (for the timeline). */
export function averageColor(shape: ImageShape): string {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < shape.w * shape.h * 8; i += 8) {
    const hex = shape.pixels;
    if (parseInt(hex.slice(i + 6, i + 8), 16) < OPAQUE) continue;
    r += parseInt(hex.slice(i, i + 2), 16);
    g += parseInt(hex.slice(i + 2, i + 4), 16);
    b += parseInt(hex.slice(i + 4, i + 6), 16);
    n++;
  }
  if (n === 0) return "#ffffff";
  const ch = (v: number) =>
    Math.round(v / n)
      .toString(16)
      .padStart(2, "0");
  return `#${ch(r)}${ch(g)}${ch(b)}`;
}
