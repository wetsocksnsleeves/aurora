import { describe, expect, it } from "vitest";
import {
  DEFAULT_SNAP,
  formatTime,
  snapStepMs,
  snapTime,
  stepTime,
  timelineTicks,
  type SnapSettings,
} from "./snap";

const snap = (s: Partial<SnapSettings>): SnapSettings => ({
  ...DEFAULT_SNAP,
  ...s,
});
const off = snap({ mode: "off" });
const ms100 = snap({ mode: "100ms" });
const ms50 = snap({ mode: "50ms" });
const beat120 = snap({ mode: "beat", bpm: 120, subdivision: 4 });

describe("snapStepMs", () => {
  it("gives the grid spacing for each mode", () => {
    expect(snapStepMs(off)).toBeNull();
    expect(snapStepMs(ms100)).toBe(100);
    expect(snapStepMs(ms50)).toBe(50);
    expect(snapStepMs(beat120)).toBe(125); // 500 ms per beat / 4
    expect(
      snapStepMs(snap({ mode: "beat", bpm: 90, subdivision: 1 })),
    ).toBeCloseTo(666.667, 3);
  });

  it("does not snap in beat mode without a usable BPM", () => {
    expect(snapStepMs(snap({ mode: "beat", bpm: null }))).toBeNull();
    expect(snapStepMs(snap({ mode: "beat", bpm: 0 }))).toBeNull();
    expect(snapStepMs(snap({ mode: "beat", bpm: Number.NaN }))).toBeNull();
  });
});

describe("snapTime", () => {
  it("rounds to the nearest 100 ms or 50 ms", () => {
    expect(snapTime(1234, ms100)).toBe(1200);
    expect(snapTime(1250, ms100)).toBe(1300);
    expect(snapTime(1234, ms50)).toBe(1250);
    expect(snapTime(1224, ms50)).toBe(1200);
  });

  it("snaps to beat subdivisions", () => {
    expect(snapTime(1060, beat120)).toBe(1000);
    expect(snapTime(1070, beat120)).toBe(1125);
    expect(
      snapTime(1070, snap({ mode: "beat", bpm: 120, subdivision: 1 })),
    ).toBe(1000);
  });

  it("shifts the beat grid by the first-beat offset", () => {
    const offset = snap({
      mode: "beat",
      bpm: 120,
      subdivision: 1,
      beatOffsetMs: 230,
    });
    expect(snapTime(700, offset)).toBe(730);
    expect(snapTime(1000, offset)).toBe(1230);
  });

  it("keeps fractional beat grids free of float noise", () => {
    const odd = snap({ mode: "beat", bpm: 130, subdivision: 4 });
    const step = 60_000 / 130 / 4;
    const t = snapTime(step * 37 + 3, odd);
    expect(t).toBe(Math.round(step * 37 * 1000) / 1000);
    expect(snapTime(t, odd)).toBe(t);
  });

  it("only clamps when snapping is off", () => {
    expect(snapTime(1234.5, off)).toBe(1234.5);
    expect(snapTime(-5, off)).toBe(0);
  });

  it("clamps to the duration", () => {
    expect(snapTime(9_999, ms100, 5_000)).toBe(5_000);
    expect(snapTime(-120, ms100, 5_000)).toBe(0);
    // A duration of 0 means unknown: no upper bound.
    expect(snapTime(9_999, ms100, 0)).toBe(10_000);
  });
});

describe("stepTime", () => {
  it("moves to the next and previous grid point", () => {
    expect(stepTime(1200, 1, ms100)).toBe(1300);
    expect(stepTime(1200, -1, ms100)).toBe(1100);
    expect(stepTime(1234, 1, ms100)).toBe(1300);
    expect(stepTime(1234, -1, ms100)).toBe(1200);
    expect(stepTime(1000, 1, beat120)).toBe(1125);
  });

  it("moves 100 ms when snapping is off and stays in range", () => {
    expect(stepTime(1234, 1, off)).toBe(1300);
    expect(stepTime(50, -1, ms100)).toBe(0);
    expect(stepTime(4_950, 1, ms100, 5_000)).toBe(5_000);
  });
});

describe("timelineTicks", () => {
  it("uses the snap step when ticks are far enough apart", () => {
    // 100 px/s: 100 ms = 10 px.
    expect(timelineTicks(ms100, 100).tickMs).toBe(100);
  });

  it("skips grid points when zoomed out", () => {
    // 20 px/s: 100 ms = 2 px, so 500 ms = 10 px.
    const ticks = timelineTicks(ms100, 20);
    expect(ticks.tickMs).toBe(500);
    expect(ticks.tickMs * ticks.labelEvery * 0.02).toBeGreaterThanOrEqual(70);
  });

  it("keeps beat ticks on beats and bars", () => {
    // 125 ms step at 20 px/s is 2.5 px; x4 = one beat = 10 px.
    const ticks = timelineTicks(beat120, 20);
    expect(ticks.tickMs).toBe(500);
    expect(ticks.labelEvery).toBe(8);
  });

  it("starts beat ticks at the first-beat offset", () => {
    const ticks = timelineTicks(
      snap({ mode: "beat", bpm: 120, subdivision: 1, beatOffsetMs: 1230 }),
      100,
    );
    expect(ticks.originMs).toBe(230);
  });
});

describe("formatTime", () => {
  it("formats m:ss.mmm", () => {
    expect(formatTime(0)).toBe("0:00.000");
    expect(formatTime(61_005)).toBe("1:01.005");
    expect(formatTime(180_000)).toBe("3:00.000");
  });
});
