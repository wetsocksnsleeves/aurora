import { describe, expect, it } from "vitest";
import { analyseAudio, fft, levelAt } from "./audio-analysis";

const SR = 22_050;

/**
 * A synthetic track at `bpm`: kicks (decaying 55 Hz sine) on beats 0 and 2
 * of each bar, snares (noise bursts) on beats 1 and 3. The first `quietMs`
 * play at a tenth of the volume.
 */
function synthTrack(opts: {
  bpm: number;
  durationMs: number;
  quietMs: number;
}) {
  const { bpm, durationMs, quietMs } = opts;
  const n = Math.round((durationMs / 1000) * SR);
  const out = new Float32Array(n);
  const beatMs = 60_000 / bpm;
  let seed = 1;
  const noise = () => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed / 0x3fffffff - 1;
  };
  const beatTimes: number[] = [];
  for (let k = 0; k * beatMs < durationMs; k++) {
    const t0 = k * beatMs;
    beatTimes.push(t0);
    const gain = t0 < quietMs ? 0.1 : 0.8;
    const start = Math.round((t0 / 1000) * SR);
    const len = Math.round(0.15 * SR);
    for (let i = 0; i < len && start + i < n; i++) {
      const env = Math.exp(-i / (0.04 * SR));
      out[start + i] +=
        k % 2 === 0
          ? gain * env * Math.sin((2 * Math.PI * 55 * i) / SR)
          : gain * 0.6 * env * noise();
    }
  }
  return { samples: out, beatTimes, beatMs };
}

describe("fft", () => {
  it("puts a pure tone in its bin", () => {
    const n = 64;
    const re = Float64Array.from({ length: n }, (_, i) =>
      Math.cos((2 * Math.PI * 5 * i) / n),
    );
    const im = new Float64Array(n);
    fft(re, im);
    const mags = Array.from(re, (r, k) => Math.hypot(r, im[k]));
    expect(mags[5]).toBeCloseTo(n / 2, 6);
    expect(mags[3]).toBeCloseTo(0, 6);
  });
});

describe("analyseAudio", () => {
  const track = synthTrack({ bpm: 120, durationMs: 24_000, quietMs: 8_000 });
  const a = analyseAudio(track.samples, SR);

  it("finds the tempo", () => {
    expect(a.bpm).toBeGreaterThan(119);
    expect(a.bpm).toBeLessThan(121);
  });

  it("places beats on the onsets", () => {
    expect(a.beats.length).toBeGreaterThan(40);
    for (const b of a.beats) {
      const nearest = Math.min(
        ...track.beatTimes.map((t) => Math.abs(t - b.tMs)),
      );
      expect(nearest).toBeLessThan(30);
    }
  });

  it("numbers beats 0..3 within bars", () => {
    for (let i = 1; i < a.beats.length; i++) {
      expect(a.beats[i].inBar).toBe((a.beats[i - 1].inBar + 1) % 4);
    }
  });

  it("detects kicks in the low band", () => {
    const kicks = track.beatTimes.filter((_, k) => k % 2 === 0 && k > 0);
    const found = kicks.filter((t) =>
      a.hits.low.some((h) => Math.abs(h.tMs - t) < 30),
    );
    expect(found.length / kicks.length).toBeGreaterThan(0.9);
  });

  it("measures quiet bars as quieter than loud ones", () => {
    const quiet = a.bars.filter((b) => b.endMs < 7_000);
    const loud = a.bars.filter((b) => b.startMs > 9_000);
    expect(Math.max(...quiet.map((b) => b.db))).toBeLessThan(-10);
    expect(Math.min(...loud.map((b) => b.db))).toBeGreaterThan(-3);
    expect(levelAt(a, 4_000)).toBeLessThan(levelAt(a, 16_000));
  });

  it("covers the whole track with bars", () => {
    expect(a.bars[0].startMs).toBe(0);
    expect(a.bars.at(-1)!.endMs).toBeCloseTo(a.durationMs, 0);
    for (let i = 1; i < a.bars.length; i++) {
      expect(a.bars[i].startMs).toBeCloseTo(a.bars[i - 1].endMs, 6);
    }
  });
});
