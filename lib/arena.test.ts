import { describe, expect, it } from "vitest";
import {
  ARENA_DEPTH_M,
  ARENA_WIDTH_M,
  SCREEN,
  SEAT_LIFT_M,
  STAGE,
  TIERS,
  TIER_COUNT,
  TIER_RISE_M,
  floorHeight,
  seatFacing,
  seatPosition,
  tierAt,
} from "./arena";

describe("arena", () => {
  it("maps the corners of the venue box", () => {
    expect(seatPosition({ x: 0, y: 0 })).toEqual({
      x: -ARENA_WIDTH_M / 2,
      y: SEAT_LIFT_M,
      z: 0,
    });
    const back = seatPosition({ x: 1, y: 1 });
    expect(back.x).toBe(ARENA_WIDTH_M / 2);
    expect(back.z).toBe(ARENA_DEPTH_M);
    expect(back.y).toBeCloseTo((TIER_COUNT - 1) * TIER_RISE_M + SEAT_LIFT_M);
    expect(seatPosition({ x: 0.5, y: 0.5 }).x).toBe(0);
  });

  it("clamps points outside the box", () => {
    expect(seatPosition({ x: -2, y: 5 })).toEqual(seatPosition({ x: 0, y: 1 }));
  });

  it("rises with depth, never falls", () => {
    let last = -Infinity;
    for (let i = 0; i <= 200; i++) {
      const h = seatPosition({ x: 0.5, y: i / 200 }).y;
      expect(h).toBeGreaterThanOrEqual(last);
      last = h;
    }
    expect(seatPosition({ x: 0.5, y: 0.95 }).y).toBeGreaterThan(
      seatPosition({ x: 0.5, y: 0.05 }).y,
    );
  });

  it("steps at tier boundaries and keeps the seat's tier whole", () => {
    expect(TIERS).toHaveLength(TIER_COUNT);
    for (const t of TIERS) {
      expect(tierAt(t.zFrom / ARENA_DEPTH_M + 1e-9).index).toBe(t.index);
      expect(floorHeight(t.zTo / ARENA_DEPTH_M - 1e-9)).toBe(t.height);
    }
    // A boundary belongs to the tier behind it.
    expect(tierAt(1 / TIER_COUNT).index).toBe(1);
    expect(tierAt(1).index).toBe(TIER_COUNT - 1);
    expect(tierAt(0).index).toBe(0);
  });

  it("puts the stage and screen in front of the audience", () => {
    expect(SCREEN.z).toBeLessThan(0);
    expect(SCREEN.width / SCREEN.height).toBeCloseTo(16 / 9);
    expect(SCREEN.bottom).toBeGreaterThanOrEqual(STAGE.height);
  });

  it("tilts panels toward the screen", () => {
    for (const p of [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
    ]) {
      const n = seatFacing(p);
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1);
      expect(n.y).toBeGreaterThan(0);
      expect(n.z).toBeLessThan(0);
    }
    expect(seatFacing({ x: 0.5, y: 0.5 }).x).toBeCloseTo(0);
    // Left seats turn right, toward the centre line.
    expect(seatFacing({ x: 0, y: 0.5 }).x).toBeGreaterThan(0);
    expect(seatFacing({ x: 1, y: 0.5 }).x).toBeLessThan(0);
  });
});
