import { describe, expect, it } from "vitest";
import {
  AUDIO_OFFSET_LIMIT_MS,
  audioDriftMs,
  audioStart,
  clampAudioOffsetMs,
  clickContextTimes,
  clickTimesForShow,
  contextTimeForShowMs,
  parseAudioOffsetMs,
  type AudioClockSample,
} from "./audio-schedule";

const base: AudioClockSample = {
  T0: 10_000,
  serverNowMs: 9_100, // 900 ms before T0
  ctxTimeS: 5,
  outputLatencyS: 0,
  manualOffsetMs: 0,
};

describe("audioStart before the show", () => {
  it("starts at ctx.currentTime + delayMs / 1000 from the top of the buffer", () => {
    const start = audioStart(base, 60)!;
    expect(start.whenS).toBeCloseTo(5.9, 9);
    expect(start.offsetS).toBe(0);
  });

  it("subtracts the reported output latency", () => {
    const start = audioStart({ ...base, outputLatencyS: 0.04 }, 60)!;
    expect(start.whenS).toBeCloseTo(5.86, 9);
    expect(start.offsetS).toBe(0);
  });

  it("treats a missing or bad output latency as 0", () => {
    expect(audioStart({ ...base, outputLatencyS: NaN }, 60)!.whenS).toBeCloseTo(
      5.9,
      9,
    );
    expect(audioStart({ ...base, outputLatencyS: -1 }, 60)!.whenS).toBeCloseTo(
      5.9,
      9,
    );
  });

  it("adds the manual offset: positive plays later, negative earlier", () => {
    expect(audioStart({ ...base, manualOffsetMs: 200 }, 60)!.whenS).toBeCloseTo(
      6.1,
      9,
    );
    expect(
      audioStart({ ...base, manualOffsetMs: -250 }, 60)!.whenS,
    ).toBeCloseTo(5.65, 9);
  });

  it("clamps the manual offset to ±500 ms", () => {
    expect(
      audioStart({ ...base, manualOffsetMs: 2_000 }, 60)!.whenS,
    ).toBeCloseTo(6.4, 9);
    expect(
      audioStart({ ...base, manualOffsetMs: -2_000 }, 60)!.whenS,
    ).toBeCloseTo(5.4, 9);
  });

  it("combines latency and offset", () => {
    const start = audioStart(
      { ...base, outputLatencyS: 0.02, manualOffsetMs: -100 },
      60,
    )!;
    expect(start.whenS).toBeCloseTo(5.9 - 0.02 - 0.1, 9);
    expect(start.offsetS).toBe(0);
  });
});

describe("audioStart mid-show (delayMs < 0)", () => {
  const late: AudioClockSample = { ...base, serverNowMs: 13_000 }; // 3 s in

  it("starts now, skipping -delayMs / 1000 into the buffer", () => {
    const start = audioStart(late, 60)!;
    expect(start.whenS).toBe(5);
    expect(start.offsetS).toBeCloseTo(3, 9);
  });

  it("skips further in by the output latency", () => {
    const start = audioStart({ ...late, outputLatencyS: 0.05 }, 60)!;
    expect(start.whenS).toBe(5);
    expect(start.offsetS).toBeCloseTo(3.05, 9);
  });

  it("applies the manual offset to the buffer position", () => {
    expect(
      audioStart({ ...late, manualOffsetMs: 300 }, 60)!.offsetS,
    ).toBeCloseTo(2.7, 9);
    expect(
      audioStart({ ...late, manualOffsetMs: -300 }, 60)!.offsetS,
    ).toBeCloseTo(3.3, 9);
  });

  it("with a lead, schedules slightly ahead and skips the same extra time", () => {
    const start = audioStart(late, 60, 0.05)!;
    expect(start.whenS).toBeCloseTo(5.05, 9);
    expect(start.offsetS).toBeCloseTo(3.05, 9);
  });

  it("uses the lead when the start time is closer than the lead", () => {
    const soon = { ...base, serverNowMs: 9_980 }; // 20 ms before T0
    const start = audioStart(soon, 60, 0.05)!;
    expect(start.whenS).toBeCloseTo(5.05, 9);
    expect(start.offsetS).toBeCloseTo(0.03, 9);
  });

  it("returns null once the track is over", () => {
    expect(audioStart({ ...base, serverNowMs: 70_000 }, 60)).toBeNull();
  });

  it("a positive manual offset can turn a late start into a scheduled one", () => {
    const start = audioStart(
      { ...base, serverNowMs: 10_100, manualOffsetMs: 300 },
      60,
    )!;
    expect(start.whenS).toBeCloseTo(5.2, 9);
    expect(start.offsetS).toBe(0);
  });
});

describe("contextTimeForShowMs and clickContextTimes", () => {
  it("maps each show time with the same maths as the track", () => {
    expect(contextTimeForShowMs(1_000, base)).toBeCloseTo(6.9, 9);
    expect(
      contextTimeForShowMs(1_000, {
        ...base,
        outputLatencyS: 0.01,
        manualOffsetMs: 50,
      }),
    ).toBeCloseTo(6.94, 9);
  });

  it("drops clicks that are already in the past", () => {
    const sample = { ...base, serverNowMs: 11_500 }; // 1.5 s in
    const times = clickContextTimes([0, 1_000, 2_000, 3_000], sample);
    expect(times).toHaveLength(2);
    expect(times[0]).toBeCloseTo(5.5, 9);
    expect(times[1]).toBeCloseTo(6.5, 9);
  });
});

describe("offset parsing", () => {
  it("clamps and rounds", () => {
    expect(clampAudioOffsetMs(123.6)).toBe(124);
    expect(clampAudioOffsetMs(9_999)).toBe(AUDIO_OFFSET_LIMIT_MS);
    expect(clampAudioOffsetMs(-9_999)).toBe(-AUDIO_OFFSET_LIMIT_MS);
    expect(clampAudioOffsetMs(NaN)).toBe(0);
  });

  it("parses stored values, defaulting to 0", () => {
    expect(parseAudioOffsetMs(null)).toBe(0);
    expect(parseAudioOffsetMs("")).toBe(0);
    expect(parseAudioOffsetMs("abc")).toBe(0);
    expect(parseAudioOffsetMs("-120")).toBe(-120);
    expect(parseAudioOffsetMs("800")).toBe(500);
  });
});

describe("audioDriftMs", () => {
  it("is 0 while the context clock keeps pace", () => {
    const origin = contextTimeForShowMs(0, base);
    // 2 s later on both clocks.
    const later = { ...base, serverNowMs: 11_100, ctxTimeS: 7 };
    expect(audioDriftMs(origin, later)).toBeCloseTo(0, 6);
  });

  it("is positive (audio late) after the context clock stalls", () => {
    const origin = contextTimeForShowMs(0, base);
    // The server clock moved 2 s but the context only 1.967 s.
    const stalled = { ...base, serverNowMs: 11_100, ctxTimeS: 6.967 };
    expect(audioDriftMs(origin, stalled)).toBeCloseTo(33, 6);
  });

  it("is negative (audio early) when the server clock estimate jumps back", () => {
    const origin = contextTimeForShowMs(0, base);
    const corrected = { ...base, serverNowMs: 11_080, ctxTimeS: 7 };
    expect(audioDriftMs(origin, corrected)).toBeCloseTo(-20, 6);
  });
});

describe("clickTimesForShow", () => {
  it("clicks once per distinct clip start, in order", () => {
    const clips = [{ startMs: 2_000 }, { startMs: 0 }, { startMs: 2_000 }];
    expect(clickTimesForShow({ clips })).toEqual([0, 2_000]);
    expect(clickTimesForShow({ clips: [] })).toEqual([]);
  });
});
