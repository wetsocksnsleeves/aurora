import { describe, expect, it } from "vitest";
import {
  framesToMs,
  groupFlashes,
  median,
  risingEdges,
  summarisePhones,
} from "./flash-analysis";

/** A square wave: dark 10, lit 200, flashing every `period` frames. */
function wave(frames: number, period: number, onFrames: number, delay = 0) {
  return Array.from({ length: frames }, (_, i) =>
    i >= delay && (i - delay) % period < onFrames ? 200 : 10,
  );
}

describe("risingEdges", () => {
  it("finds each dark-to-lit edge", () => {
    expect(risingEdges(wave(1000, 240, 120, 30))).toEqual([
      30, 270, 510, 750, 990,
    ]);
  });

  it("puts the edge at the first frame past half brightness", () => {
    const series = [10, 10, 60, 120, 190, 200, 200, 10];
    expect(risingEdges(series)).toEqual([3]);
  });

  it("ignores a blip that never reaches full brightness", () => {
    const series = [10, 10, 130, 10, 10, 200, 200, 10];
    expect(risingEdges(series)).toEqual([5]);
  });

  it("does not count noise on a lit screen twice", () => {
    const series = [10, 200, 140, 200, 150, 200, 10, 200];
    expect(risingEdges(series)).toEqual([1, 7]);
  });

  it("skips a screen that starts lit", () => {
    expect(risingEdges([200, 200, 10, 10, 200])).toEqual([4]);
  });
});

describe("groupFlashes and summarisePhones", () => {
  it("reports each phone's lateness against the first phone per flash", () => {
    const rows = groupFlashes(
      [
        [100, 340, 580],
        [102, 341, 585],
        [100, 343, 580],
      ],
      120,
    );
    expect(rows).toEqual([
      { firstFrame: 100, lateFrames: [0, 2, 0], spreadFrames: 2 },
      { firstFrame: 340, lateFrames: [0, 1, 3], spreadFrames: 3 },
      { firstFrame: 580, lateFrames: [0, 5, 0], spreadFrames: 5 },
    ]);
    expect(summarisePhones(rows, 3)).toEqual([
      { flashes: 3, medianLateFrames: 0, maxLateFrames: 0, lastCount: 0 },
      { flashes: 3, medianLateFrames: 2, maxLateFrames: 5, lastCount: 2 },
      { flashes: 3, medianLateFrames: 0, maxLateFrames: 3, lastCount: 1 },
    ]);
  });

  it("leaves a phone missing from a flash as null", () => {
    const rows = groupFlashes([[100, 340], [101]], 120);
    expect(rows[1]).toEqual({
      firstFrame: 340,
      lateFrames: [0, null],
      spreadFrames: 0,
    });
    expect(summarisePhones(rows, 2)[1]!.flashes).toBe(1);
  });
});

describe("helpers", () => {
  it("converts frames at 240 fps to ms", () => {
    expect(framesToMs(3, 240)).toBe(12.5);
  });

  it("takes the median", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});
