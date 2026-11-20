import { describe, expect, it } from "vitest";
import {
  TEST_FLASH_MS,
  TEST_SHOW,
  TEST_SHOW_DURATION_MS,
  TEST_WAVE_COUNT,
  TEST_WAVE_SWEEP_MS,
  testSchedule,
} from "./test-show";

const firstWhite = (x: number) =>
  testSchedule({ x, y: 0.5 }).events.find((e) => e.color === "#ffffff")!.tMs;

describe("testSchedule", () => {
  it("starts black and alternates white and black flashes", () => {
    const { events } = testSchedule({ x: 0.5, y: 0.5 });
    expect(events[0]).toEqual({ tMs: 0, color: "#000000" });
    expect(events).toHaveLength(1 + TEST_WAVE_COUNT * 2);
    for (let i = 1; i < events.length; i += 2) {
      expect(events[i]!.color).toBe("#ffffff");
      expect(events[i + 1]!.color).toBe("#000000");
      expect(events[i + 1]!.tMs - events[i]!.tMs).toBe(TEST_FLASH_MS);
    }
  });

  it("is sorted and ends within the show", () => {
    for (const x of [0, 0.3, 1]) {
      const { events } = testSchedule({ x, y: 0.5 });
      for (let i = 1; i < events.length; i++) {
        expect(events[i]!.tMs).toBeGreaterThan(events[i - 1]!.tMs);
      }
      expect(events.at(-1)!.tMs).toBeLessThanOrEqual(TEST_SHOW_DURATION_MS);
    }
  });

  it("delays the flash in proportion to x, so a wave runs left to right", () => {
    expect(firstWhite(0)).toBe(0);
    expect(firstWhite(0.5)).toBe(TEST_WAVE_SWEEP_MS / 2);
    expect(firstWhite(1)).toBe(TEST_WAVE_SWEEP_MS);
    expect(firstWhite(0.2)).toBeLessThan(firstWhite(0.8));
  });

  it("a seat at x = 0 does not get a zero-length black event", () => {
    const { events } = testSchedule({ x: 0, y: 0.5 });
    expect(events[0]).toEqual({ tMs: 0, color: "#ffffff" });
    expect(events).toHaveLength(TEST_WAVE_COUNT * 2);
  });

  it("the test show lasts as long as the wave", () => {
    expect(TEST_SHOW.audio.durationMs).toBe(TEST_SHOW_DURATION_MS);
    expect(TEST_SHOW.venue.shapes).toHaveLength(2);
  });
});
