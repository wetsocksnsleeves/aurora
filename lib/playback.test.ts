import { describe, expect, it } from "vitest";
import type { ScheduleEvent } from "./types";
import {
  DARK,
  ScheduleCursor,
  eventIndexAt,
  playbackFrame,
  type PlaybackInput,
} from "./playback";

const events: ScheduleEvent[] = [
  { tMs: 0, color: "#000000" },
  { tMs: 100, color: "#ff0000" },
  { tMs: 200, color: "#00ff00" },
  { tMs: 300, color: "#0000ff" },
  { tMs: 1_000, color: "#ffffff" },
];

/** Reference lookup: a linear scan. */
function expected(showMs: number): string {
  let color = DARK;
  for (const e of events) if (e.tMs <= showMs) color = e.color;
  return color;
}

describe("eventIndexAt", () => {
  it("finds the last event at or before the time", () => {
    expect(eventIndexAt(events, -1)).toBe(-1);
    expect(eventIndexAt(events, 0)).toBe(0);
    expect(eventIndexAt(events, 99.9)).toBe(0);
    expect(eventIndexAt(events, 100)).toBe(1);
    expect(eventIndexAt(events, 999)).toBe(3);
    expect(eventIndexAt(events, 50_000)).toBe(4);
    expect(eventIndexAt([], 10)).toBe(-1);
  });
});

describe("ScheduleCursor", () => {
  it("steps forward frame by frame", () => {
    const cursor = new ScheduleCursor(events);
    for (let t = -50; t < 1_200; t += 16.7) {
      expect(cursor.colorAt(t)).toBe(expected(t));
    }
    expect(cursor.position).toBe(4);
  });

  it("is black before the first event", () => {
    const late = new ScheduleCursor([{ tMs: 500, color: "#ff0000" }]);
    expect(late.colorAt(0)).toBe(DARK);
    expect(late.colorAt(500)).toBe("#ff0000");
  });

  it("seeks backwards", () => {
    const cursor = new ScheduleCursor(events);
    expect(cursor.colorAt(1_100)).toBe("#ffffff");
    expect(cursor.colorAt(150)).toBe("#ff0000");
    expect(cursor.position).toBe(1);
    expect(cursor.colorAt(-10)).toBe(DARK);
    expect(cursor.position).toBe(-1);
    expect(cursor.colorAt(250)).toBe("#00ff00");
  });

  it("seeks far forward (a late joiner) without a frame-by-frame walk", () => {
    const many: ScheduleEvent[] = Array.from({ length: 10_000 }, (_, i) => ({
      tMs: i * 20,
      color: i % 2 ? "#ffffff" : "#000000",
    }));
    const cursor = new ScheduleCursor(many);
    expect(cursor.colorAt(10)).toBe("#000000");
    expect(cursor.colorAt(150_005)).toBe(many[7_500]!.color);
    expect(cursor.position).toBe(7_500);
    expect(cursor.colorAt(150_025)).toBe(many[7_501]!.color);
    expect(cursor.position).toBe(7_501);
  });

  it("matches a linear scan for random seeks", () => {
    const cursor = new ScheduleCursor(events);
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 500; i++) {
      const t = rand() * 1_400 - 100;
      expect(cursor.colorAt(t)).toBe(expected(t));
    }
  });
});

describe("playbackFrame", () => {
  const base: PlaybackInput = {
    clockReady: true,
    T0: 10_000,
    schedule: { events, durationMs: 2_000 },
    serverNow: 10_150,
  };
  const frame = (patch: Partial<PlaybackInput>) =>
    playbackFrame({ ...base, ...patch }, new ScheduleCursor(events));

  it("paints the schedule colour at serverNow - T0", () => {
    expect(frame({})).toEqual({ kind: "color", color: "#ff0000", showMs: 150 });
  });

  it("is dark without a ready clock, a T0 or a schedule, and before T0", () => {
    expect(frame({ clockReady: false })).toEqual({ kind: "dark" });
    expect(frame({ T0: null })).toEqual({ kind: "dark" });
    expect(frame({ schedule: null })).toEqual({ kind: "dark" });
    expect(frame({ serverNow: 9_999 })).toEqual({ kind: "dark" });
    expect(playbackFrame(base, null)).toEqual({ kind: "dark" });
  });

  it("is over at durationMs", () => {
    expect(frame({ serverNow: 11_999 }).kind).toBe("color");
    expect(frame({ serverNow: 12_000 })).toEqual({ kind: "over" });
  });
});
