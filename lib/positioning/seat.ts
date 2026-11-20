import type { Point, PositioningConfig } from "../types";
import { clampUnit } from "../venue-geometry";

/** Used until the host sets the real sizes on the host screen. */
export const DEFAULT_POSITIONING: PositioningConfig = {
  targetWidthM: 3,
  venueWidthM: 20,
  venueDepthM: 20,
};

/**
 * Turn a camera position into a venue point. The venue drawing's top edge is
 * the stage (as the seat picker says), with the big screen centred on it.
 * The drawing's 0..1 box spans `venueWidthM` across and `venueDepthM` back
 * from the screen.
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
