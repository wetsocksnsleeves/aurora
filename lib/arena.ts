import type { Point } from "./types";

/**
 * The fixed mock arena for the 3D run-through, in metres. Pure geometry.
 *
 * Axes follow three.js: x runs across (0 at the centre line), y is up, and z
 * runs back from the stage, so the stage and screen sit at z <= 0 and the
 * audience at z >= 0. The venue's 0..1 box fills the floor: x maps to the
 * width, y to the depth (y = 0 is the screen side, SPEC 2.4) and, through
 * stepped tiers, to the rake height, so rear seats sit higher.
 */

export const ARENA_WIDTH_M = 40;
export const ARENA_DEPTH_M = 40;
export const TIER_COUNT = 8;
export const TIER_DEPTH_M = ARENA_DEPTH_M / TIER_COUNT;
/** Height gained from one tier to the next. */
export const TIER_RISE_M = 0.9;
/** Seat panels sit this far above the tier surface. */
export const SEAT_LIFT_M = 0.4;
/** How far each panel's normal leans from straight up, toward the screen. */
export const PANEL_TILT_RAD = (25 * Math.PI) / 180;

export type Vec3 = { x: number; y: number; z: number };

export type Tier = {
  index: number;
  /** Depth range from the stage, metres. */
  zFrom: number;
  zTo: number;
  /** Height of the tier's walking surface. */
  height: number;
};

export const TIERS: readonly Tier[] = Array.from(
  { length: TIER_COUNT },
  (_, index) => ({
    index,
    zFrom: index * TIER_DEPTH_M,
    zTo: (index + 1) * TIER_DEPTH_M,
    height: index * TIER_RISE_M,
  }),
);

/** The stage platform, in front of the audience's first row. */
export const STAGE = {
  width: 26,
  depth: 8,
  height: 1.2,
  /** Front edge z; it extends back to `-depth`. */
  zFront: 0,
} as const;

/** The big screen: 16:9, standing at the back of the stage. */
export const SCREEN = {
  width: 22,
  height: (22 * 9) / 16,
  z: -STAGE.depth,
  /** Height of the screen's bottom edge. */
  bottom: STAGE.height + 2,
} as const;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** The tier a venue y (0 = screen side) lands on; boundaries go to the back tier. */
export function tierAt(y: number): Tier {
  const i = Math.min(TIER_COUNT - 1, Math.floor(clamp01(y) * TIER_COUNT));
  return TIERS[i];
}

/** Floor surface height at venue y. */
export function floorHeight(y: number): number {
  return tierAt(y).height;
}

/** Where a seat's panel sits, in metres. Out-of-box points are clamped. */
export function seatPosition(p: Point): Vec3 {
  return {
    x: (clamp01(p.x) - 0.5) * ARENA_WIDTH_M,
    y: floorHeight(p.y) + SEAT_LIFT_M,
    z: clamp01(p.y) * ARENA_DEPTH_M,
  };
}

/**
 * Unit normal of a seat's panel: leaning from straight up by `PANEL_TILT_RAD`
 * toward the screen, and turned slightly in across the room to face the screen's
 * centre line.
 */
export function seatFacing(p: Point): Vec3 {
  const pos = seatPosition(p);
  const toCentre = Math.atan2(-pos.x, ARENA_DEPTH_M + STAGE.depth);
  const lean = Math.sin(PANEL_TILT_RAD);
  const nx = lean * Math.sin(toCentre);
  const nz = -lean * Math.cos(toCentre);
  return { x: nx, y: Math.cos(PANEL_TILT_RAD), z: nz };
}
