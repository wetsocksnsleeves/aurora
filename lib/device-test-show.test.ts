import { describe, expect, it } from "vitest";
import { compileSchedule, showDurationMs } from "./compile";
import {
  DEVICE_TEST_DURATION_MS,
  DEVICE_TEST_FLASH_COUNT,
  DEVICE_TEST_FLASH_MS,
  DEVICE_TEST_SHOW,
  deviceTestFlashMs,
} from "./device-test-show";

describe("DEVICE_TEST_SHOW", () => {
  it("runs 60 one-second flashes after a one-second lead-in", () => {
    expect(DEVICE_TEST_SHOW.clips).toHaveLength(60);
    expect(showDurationMs(DEVICE_TEST_SHOW)).toBe(61_000);
    expect(DEVICE_TEST_DURATION_MS).toBe(61_000);
    expect(deviceTestFlashMs(0)).toBe(1_000);
    expect(deviceTestFlashMs(59)).toBe(60_000);
  });

  it("compiles to the same hard black/white edges for every seat", () => {
    const expected = [{ tMs: 0, color: "#000000" }];
    for (let i = 0; i < DEVICE_TEST_FLASH_COUNT; i++) {
      expected.push({ tMs: deviceTestFlashMs(i), color: "#ffffff" });
      expected.push({
        tMs: deviceTestFlashMs(i) + DEVICE_TEST_FLASH_MS,
        color: "#000000",
      });
    }
    for (const seat of [
      { x: 0.1, y: 0.2 },
      { x: 0.5, y: 0.5 },
      { x: 0.9, y: 0.85 },
    ]) {
      const schedule = compileSchedule(DEVICE_TEST_SHOW, seat);
      expect(schedule.events).toEqual(expected);
      expect(schedule.durationMs).toBe(DEVICE_TEST_DURATION_MS);
    }
  });
});
