import { describe, expect, it } from "vitest";
import { MAX_CLIPS, parseShowPatch } from "@/server/show-validation";
import type { AudioAnalysis, Bar, Beat, Hit } from "./audio-analysis";
import { colorAt } from "./compile";
import { generateLightShow, scale } from "./light-show-generator";
import { TEST_VENUE } from "./test-show";
import type { Show } from "./types";

const BEAT = 500;
const BAR = 4 * BEAT;

/**
 * 4 quiet bars, then 16 loud bars at 120 BPM, with a kick on every beat and
 * a snare on every off-beat 8th of the loud part.
 */
function fakeAnalysis(): AudioAnalysis {
  const quietBars = 4;
  const barCount = 20;
  const durationMs = barCount * BAR;
  const beats: Beat[] = Array.from({ length: barCount * 4 }, (_, k) => ({
    tMs: k * BEAT,
    inBar: k % 4,
    strength: 0.8,
    kick: 0.8,
  }));
  const bars: Bar[] = Array.from({ length: barCount }, (_, i) => ({
    startMs: i * BAR,
    endMs: (i + 1) * BAR,
    db: i < quietBars ? -8 : 0,
    rank: i < quietBars ? 0 : 1,
  }));
  const loud = (t: number) => t >= quietBars * BAR;
  const kicks: Hit[] = beats.map((b) => ({ tMs: b.tMs, strength: 0.9 }));
  const snares: Hit[] = beats
    .filter((b) => loud(b.tMs))
    .map((b) => ({ tMs: b.tMs + BEAT / 2, strength: 0.8 }));
  const frameMs = 20;
  const level = Float32Array.from(
    { length: Math.ceil(durationMs / frameMs) },
    (_, f) => (loud(f * frameMs) ? 1 : 0.1),
  );
  return {
    durationMs,
    bpm: 120,
    beatMs: BEAT,
    beats,
    bars,
    hits: { low: kicks, mid: snares, high: [] },
    frameMs,
    centreMs: 0,
    level,
  };
}

function showOf(analysis: AudioAnalysis): Show {
  return {
    id: "gen",
    name: "Generated",
    venue: TEST_VENUE,
    audio: { fileId: "", durationMs: analysis.durationMs },
    clips: generateLightShow(analysis, TEST_VENUE),
    createdAt: "",
    updatedAt: "",
  };
}

function brightness(hex: string): number {
  return [1, 3, 5].reduce((s, i) => s + parseInt(hex.slice(i, i + 2), 16), 0);
}

describe("generateLightShow", () => {
  const analysis = fakeAnalysis();
  const show = showOf(analysis);

  it("produces clips the server accepts", () => {
    expect(show.clips.length).toBeGreaterThan(0);
    expect(show.clips.length).toBeLessThanOrEqual(MAX_CLIPS);
    const parsed = parseShowPatch({ clips: show.clips });
    expect(parsed.ok ? "ok" : parsed.error).toBe("ok");
    for (const c of show.clips) {
      expect(c.endMs).toBeLessThanOrEqual(analysis.durationMs);
    }
    expect(new Set(show.clips.map((c) => c.id)).size).toBe(show.clips.length);
  });

  it("is deterministic", () => {
    expect(showOf(analysis).clips).toEqual(show.clips);
  });

  it("flashes the whole crowd white on the drop", () => {
    const drop = 4 * BAR;
    const flash = show.clips.find(
      (c) =>
        c.startMs === drop && c.color === "#ffffff" && c.shape.kind === "fill",
    );
    expect(flash).toBeDefined();
    for (const seat of [
      { x: 0.1, y: 0.3 },
      { x: 0.9, y: 0.8 },
    ]) {
      expect(colorAt(show, seat, drop + 20)).toMatch(/^#f[0-9a-f]f[0-9a-f]f/);
    }
  });

  it("builds up in the bar before the drop", () => {
    const build = show.clips.filter(
      (c) => c.startMs >= 3 * BAR && c.startMs < 4 * BAR,
    );
    expect(build.length).toBeGreaterThanOrEqual(16);
    const first = brightness(build[0].color);
    const last = brightness(build[build.length - 1].color);
    expect(last).toBeGreaterThan(first);
  });

  it("is brighter in loud bars than quiet ones", () => {
    const mean = (from: number, to: number) => {
      let sum = 0;
      let n = 0;
      for (let t = from; t < to; t += 20) {
        for (const seat of [
          { x: 0.1, y: 0.3 },
          { x: 0.5, y: 0.5 },
          { x: 0.9, y: 0.8 },
        ]) {
          sum += brightness(colorAt(show, seat, t));
          n++;
        }
      }
      return sum / n;
    };
    expect(mean(5 * BAR, 20 * BAR)).toBeGreaterThan(1.5 * mean(0, 3 * BAR));
  });

  it("moves: a seat on the left lights before a seat on the right in a sweep", () => {
    const sweep = show.clips.find(
      (c) =>
        c.shape.kind === "polygon" &&
        (c.shape.moveTo?.x ?? 0) > 0 &&
        // Starts off the left edge (the drop's centre split starts mid-venue).
        c.shape.points[1].x <= 0.05 &&
        c.startMs >= 4 * BAR,
    );
    expect(sweep).toBeDefined();
    const firstLit = (x: number) => {
      for (let t = sweep!.startMs; t < sweep!.endMs; t += 5) {
        if (
          brightness(colorAt({ ...show, clips: [sweep!] }, { x, y: 0.5 }, t)) >
          0
        ) {
          return t;
        }
      }
      return Infinity;
    };
    expect(firstLit(0.1)).toBeLessThan(firstLit(0.9));
  });
});

describe("scale", () => {
  it("scales each channel", () => {
    expect(scale("#ff8000", 0.5)).toBe("#804000");
    expect(scale("#ffffff", 2)).toBe("#ffffff");
    expect(scale("#ffffff", -1)).toBe("#000000");
  });
});
