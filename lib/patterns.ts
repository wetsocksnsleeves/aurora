// Built-in effects (SPEC 3.2): how bright a pattern clip is at a seat. Pure,
// like compile.ts, which uses it for every sample.

import type { Blink, Direction, PatternShape, Point } from "./types";

/** Share of a wave band's half-width that ramps from dark to full. */
const FEATHER = 0.35;

/** 0..1 along `direction`: 0 where the effect starts, 1 where it ends. */
function along(p: Point, direction: Direction): number {
  switch (direction) {
    case "right":
      return p.x;
    case "left":
      return 1 - p.x;
    case "down":
      return p.y;
    case "up":
      return 1 - p.y;
  }
}

/** A band of width `w` centred on `c`, with soft edges. */
function band(u: number, c: number, w: number): number {
  const half = Math.max(w, 0.01) / 2;
  const d = Math.abs(u - c) / half;
  return Math.max(0, Math.min(1, (1 - d) / FEATHER));
}

/**
 * Brightness 0..1 of a pattern at seat `p`. `progress` is 0..1 through the
 * clip; `tMs` is show time, so steps (chase, sparkle) keep a steady rhythm
 * across clips.
 */
export function patternLevel(
  shape: PatternShape,
  p: Point,
  progress: number,
  tMs: number,
): number {
  const q = shape.from + (shape.to - shape.from) * progress;
  const size = Math.max(0.01, Math.min(1, shape.size));
  switch (shape.pattern) {
    case "wave": {
      // The band enters fully off one edge and leaves fully off the other.
      const c = -size / 2 + q * (1 + size);
      return band(along(p, shape.direction), c, size);
    }
    case "split": {
      // Two bands from the middle out ("right", "down") or from the edges in
      // ("left", "up"), across or front to back.
      const across = shape.direction === "left" || shape.direction === "right";
      const d = Math.abs((across ? p.x : p.y) - 0.5) * 2;
      const out = shape.direction === "right" || shape.direction === "down";
      const c = -size / 2 + q * (1 + size);
      return band(out ? d : 1 - d, c, size);
    }
    case "chase": {
      const columns = Math.max(2, Math.round(1 / size));
      const step = Math.floor(tMs / Math.max(20, shape.stepMs));
      const column = Math.min(
        columns - 1,
        Math.floor(along(p, shape.direction) * columns),
      );
      return column === step % columns ? 1 : 0;
    }
    case "sparkle": {
      const stepMs = Math.max(20, shape.stepMs);
      const step = Math.floor(tMs / stepMs);
      if (random(p, step) >= size) return 0;
      // Each twinkle starts bright and dies away within its step.
      const f = (tMs - step * stepMs) / stepMs;
      return 1 - 0.8 * f;
    }
  }
}

/** Brightness 0..1 of a blink at show time `tMs`. */
export function blinkLevel(blink: Blink, tMs: number): number {
  const period = Math.max(20, blink.periodMs);
  const f = (((tMs % period) + period) % period) / period;
  if (blink.soft) return (1 - f) ** 2.5;
  return f < blink.duty ? 1 : 0;
}

/** A repeatable 0..1 number for a seat and a step. */
function random(p: Point, step: number): number {
  let h = Math.imul(Math.round(p.x * 4096) | 0, 0x27d4eb2d);
  h ^= Math.imul(Math.round(p.y * 4096) | 0, 0x165667b1);
  h ^= Math.imul(step | 0, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca77);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae3d);
  h ^= h >>> 16;
  return (h >>> 0) / 2 ** 32;
}
