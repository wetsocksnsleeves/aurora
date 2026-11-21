import type { Point, PositioningConfig } from "../types";
import { clampUnit } from "../venue-geometry";

/**
 * Share of a 16:9 screen's width between the left and right anchor centres
 * when the big screen page is fullscreen (`/sessions/[code]/screen`). The
 * page leaves bands above and below the target, so this varies a little with
 * resolution: 0.653 at 1280x720, 0.657 at 1920x1080.
 */
export const TARGET_SHARE_OF_SCREEN = 0.655;

/** 16:9 screen width as a fraction of its diagonal. */
const WIDTH_PER_DIAGONAL = 16 / Math.hypot(16, 9);
const METRES_PER_INCH = 0.0254;

/** Target width (metres) on a 16:9 screen of `inches` diagonal, fullscreen. */
export function targetWidthFromInches(inches: number): number {
  return inches * METRES_PER_INCH * WIDTH_PER_DIAGONAL * TARGET_SHARE_OF_SCREEN;
}

/** The screen diagonal (inches) that gives `targetWidthM`. */
export function inchesFromTargetWidth(targetWidthM: number): number {
  return (
    targetWidthM /
    (METRES_PER_INCH * WIDTH_PER_DIAGONAL * TARGET_SHARE_OF_SCREEN)
  );
}

/**
 * Used until the host sets the screen size. The room is a large box so that
 * nobody's position is clipped: shows are fitted to the crowd itself
 * (`lib/crowd.ts`), not to the room.
 */
export const DEFAULT_POSITIONING: PositioningConfig = {
  targetWidthM: targetWidthFromInches(65),
  venueWidthM: 200,
  venueDepthM: 200,
};

/**
 * Turn a camera position into a room point. The room's top edge is the
 * screen, centred. The 0..1 box spans `venueWidthM` across and `venueDepthM`
 * back from the screen.
 *
 * `room` is the camera position in metres: `x` right of the screen centre as
 * the audience sees it, `z` out from the screen.
 */
export function roomToVenuePoint(
  room: { x: number; z: number },
  config: PositioningConfig,
): Point {
  return {
    x: clampUnit(0.5 + room.x / config.venueWidthM),
    y: clampUnit(room.z / config.venueDepthM),
  };
}
