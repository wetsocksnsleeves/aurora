import { describe, expect, it } from "vitest";
import {
  inchesFromTargetWidth,
  roomToVenuePoint,
  targetWidthFromInches,
} from "./seat";

const config = { targetWidthM: 3, venueWidthM: 20, venueDepthM: 30 };

describe("roomToVenuePoint", () => {
  it("puts the screen at the top centre of the venue", () => {
    expect(roomToVenuePoint({ x: 0, z: 0 }, config)).toEqual({ x: 0.5, y: 0 });
  });

  it("scales metres to the venue box", () => {
    expect(roomToVenuePoint({ x: -5, z: 15 }, config)).toEqual({
      x: 0.25,
      y: 0.5,
    });
  });

  it("clamps positions outside the box to its edge", () => {
    expect(roomToVenuePoint({ x: 50, z: 45 }, config)).toEqual({ x: 1, y: 1 });
  });
});

describe("screen size in inches", () => {
  it("gives the target width on a fullscreen 16:9 screen", () => {
    // A 65" TV is 1.439 m wide; the target spans about 65.5% of it.
    expect(targetWidthFromInches(65)).toBeCloseTo(0.943, 3);
  });

  it("round-trips", () => {
    expect(inchesFromTargetWidth(targetWidthFromInches(100))).toBeCloseTo(
      100,
      9,
    );
  });
});
