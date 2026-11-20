// Generates light show clips from an audio analysis. Pure, like compile.ts.
//
// The track is split into bars and 8-bar phrases. Each bar gets an intensity
// from its loudness, and the choreography follows it:
//
// - Quiet bars: a dim colour wash that breathes with the level, slow wide
//   sweeps every two beats, and small sparkles on hi-hat hits.
// - The bar before a drop: a 16th-note strobe that brightens to white.
// - A drop or a new loud phrase: a white flash and two bands splitting out
//   from the centre.
// - Loud bars: a dim pulse on every beat plus a pattern that changes every
//   four bars, rotating through kick flashes, sweeps, column chases, a
//   left/right strobe, and stage-to-back waves.
// - The last bar of a loud phrase: white stage-to-back sweeps on 8th notes,
//   leading into the next phrase.
//
// Brightness follows the hit strength and the track level at that moment.

import {
  levelAt,
  type AudioAnalysis,
  type Bar,
  type Hit,
} from "./audio-analysis";
import type { Clip, Point, Venue } from "./types";

const LAYER = { background: 0, kick: 1, pattern: 2, accent: 3, impact: 4 };

const WHITE = "#ffffff";

type Palette = { a: string; b: string };

const INTRO_PALETTE: Palette = { a: "#3a2bff", b: "#b026ff" };
const PALETTES: Palette[] = [
  { a: "#ff2d55", b: "#5e5ce6" },
  { a: "#00e5ff", b: "#ff00c8" },
  { a: "#ffb800", b: "#ff3b00" },
  { a: "#7cff00", b: "#00a2ff" },
  { a: "#b026ff", b: "#ff2d55" },
];

const MODES = ["pulse", "sweeps", "chase", "strobe", "tunnel"] as const;
type Mode = (typeof MODES)[number];

/** Bars quieter than this intensity get the quiet choreography. */
const LOUD = 0.45;
const PHRASE_BARS = 8;

type Box = { minX: number; maxX: number; minY: number; maxY: number };

type Direction = "right" | "left" | "down" | "up";

/** Bar intensity in 0..1: -9 dB below the track's loud bars is 0, -1 dB is 1. */
export function barIntensity(bar: Pick<Bar, "db">): number {
  return Math.max(0, Math.min(1, (bar.db + 9) / 8));
}

/** Clips for a light show that follows `analysis`, laid out over `venue`. */
export function generateLightShow(
  analysis: AudioAnalysis,
  venue: Venue,
): Clip[] {
  return new Generator(analysis, venue).run();
}

class Generator {
  private readonly clips: Clip[] = [];
  private readonly box: Box;
  private readonly beat: number;
  private readonly intensity: number[];
  private readonly drops: Set<number>;
  private readonly firstDrop: number;
  private readonly random = mulberry32(0x5eed);

  constructor(
    private readonly analysis: AudioAnalysis,
    venue: Venue,
  ) {
    this.box = venueBox(venue);
    this.beat = analysis.beatMs;
    this.intensity = analysis.bars.map(barIntensity);
    this.drops = new Set(
      this.intensity.flatMap((v, i) => {
        if (i === 0 || v < 0.85) return [];
        const before = this.intensity.slice(Math.max(0, i - 2), i);
        const mean = before.reduce((s, x) => s + x, 0) / before.length;
        return mean < 0.65 ? [i] : [];
      }),
    );
    // Phrases are counted from the first drop, since that is where the
    // track's 8-bar structure is easiest to place.
    this.firstDrop = this.drops.size ? Math.min(...this.drops) : 0;
  }

  run(): Clip[] {
    const { bars } = this.analysis;
    bars.forEach((bar, i) => {
      const loud = this.intensity[i] >= LOUD;
      const phrase = this.phraseOf(i);
      const palette = loud
        ? PALETTES[
            ((phrase % PALETTES.length) + PALETTES.length) % PALETTES.length
          ]
        : INTRO_PALETTE;

      if (this.drops.has(i + 1) && !this.drops.has(i)) {
        this.buildBar(bar);
        return;
      }
      if (!loud) {
        this.quietBar(bar, i, palette);
        return;
      }

      const phraseStart = this.isPhraseStart(i);
      const phraseEnd = this.isPhraseStart(i + 1) && i + 1 < bars.length;
      if (this.drops.has(i) || phraseStart) this.impact(bar.startMs, palette);

      this.pulse(bar, palette);
      // Two patterns per phrase, switching halfway, so 8 bars do not repeat.
      const halfPhrase =
        2 * phrase + (this.barInPhrase(i) >= PHRASE_BARS / 2 ? 1 : 0);
      const mode =
        MODES[((halfPhrase % MODES.length) + MODES.length) % MODES.length];
      const half = bar.startMs + 2 * this.beat;
      if (phraseEnd) {
        this.pattern(mode, bar.startMs, half, palette, i);
        this.fill(half, bar.endMs);
      } else {
        this.pattern(mode, bar.startMs, bar.endMs, palette, i);
      }
    });
    this.outro();
    return this.clips;
  }

  private phraseOf(barIndex: number): number {
    return Math.floor((barIndex - this.firstDrop) / PHRASE_BARS);
  }

  private barInPhrase(barIndex: number): number {
    const k = (barIndex - this.firstDrop) % PHRASE_BARS;
    return (k + PHRASE_BARS) % PHRASE_BARS;
  }

  private isPhraseStart(barIndex: number): boolean {
    return (
      barIndex > 0 &&
      this.barInPhrase(barIndex) === 0 &&
      this.intensity[barIndex] >= LOUD
    );
  }

  // ---- Bar types ----

  private quietBar(bar: Bar, index: number, palette: Palette): void {
    const len = bar.endMs - bar.startMs;
    const level = this.levelOver(bar.startMs, bar.endMs);
    // A wash that fades up and down over the bar.
    this.add({
      layer: LAYER.background,
      startMs: bar.startMs,
      endMs: bar.endMs,
      color: scale(
        palette.a,
        0.15 + 0.35 * this.intensity[index] + 0.2 * level,
      ),
      fadeInMs: len / 2,
      fadeOutMs: len / 2,
      shape: { kind: "fill" },
    });
    // A slow, wide sweep every two beats, alternating direction.
    for (let k = 0; k < 2; k++) {
      const t = bar.startMs + k * 2 * this.beat;
      if (t >= bar.endMs) break;
      this.sweep(t, 2 * this.beat, scale(palette.b, 0.35 + 0.4 * level), {
        direction: (index * 2 + k) % 2 === 0 ? "right" : "left",
        width: 0.45,
        layer: LAYER.pattern,
        fade: true,
      });
    }
    // Sparkles on the strongest hi-hats.
    for (const hit of this.hitsIn("high", bar.startMs, bar.endMs, 0.45)) {
      this.sparkle(hit.tMs, 180, scale(WHITE, 0.3 + 0.5 * hit.strength));
    }
  }

  /** 16th notes that alternate halves and brighten to white, then a sweep in. */
  private buildBar(bar: Bar): void {
    const step = this.beat / 4;
    const steps = Math.round((bar.endMs - bar.startMs) / step);
    for (let k = 0; k < steps; k++) {
      const progress = k / Math.max(1, steps - 1);
      const t = bar.startMs + k * step;
      const left = k % 2 === 0;
      this.add({
        layer: LAYER.pattern,
        startMs: t,
        endMs: t + step * 0.6,
        color: scale(WHITE, 0.15 + 0.85 * progress ** 2),
        fadeInMs: 0,
        fadeOutMs: 0,
        shape: {
          kind: "polygon",
          points:
            progress > 0.75
              ? this.fullRect()
              : this.half(left ? "left" : "right"),
        },
      });
    }
  }

  /** White flash plus two bands splitting out from the centre. */
  private impact(t: number, palette: Palette): void {
    this.add({
      layer: LAYER.impact,
      startMs: t,
      endMs: t + this.beat,
      color: WHITE,
      fadeInMs: 0,
      fadeOutMs: this.beat * 0.9,
      shape: { kind: "fill" },
    });
    const { minX, maxX } = this.box;
    const centre = (minX + maxX) / 2;
    const w = (maxX - minX) * 0.12;
    const dur = this.beat * 2;
    for (const dir of [-1, 1]) {
      const x0 = dir < 0 ? centre - w : centre;
      this.add({
        layer: LAYER.accent,
        startMs: t + this.beat * 0.5,
        endMs: t + this.beat * 0.5 + dur,
        color: palette.a,
        fadeInMs: 0,
        fadeOutMs: dur * 0.3,
        shape: {
          kind: "polygon",
          points: rect(x0, -1, x0 + w, 2),
          moveTo: { x: (dir * (maxX - minX)) / 2 + dir * w, y: 0 },
        },
      });
    }
  }

  /** A dim colour pulse on every beat, scaled by the level. */
  private pulse(bar: Bar, palette: Palette): void {
    for (const b of this.beatsIn(bar.startMs, bar.endMs)) {
      const level = levelAt(this.analysis, b.tMs);
      this.add({
        layer: LAYER.background,
        startMs: b.tMs,
        endMs: b.tMs + this.beat,
        color: scale(
          b.inBar % 2 === 0 ? palette.a : palette.b,
          0.12 + 0.2 * level,
        ),
        fadeInMs: 0,
        fadeOutMs: this.beat * 0.8,
        shape: { kind: "fill" },
      });
    }
  }

  /** White stage-to-back sweeps on 8th notes, a fill into the next phrase. */
  private fill(from: number, to: number): void {
    const step = this.beat / 2;
    for (let t = from, k = 0; t < to - step / 2; t += step, k++) {
      this.sweep(t, this.beat * 0.75, scale(WHITE, 0.5 + 0.5 * (k / 4)), {
        direction: "down",
        width: 0.25,
        layer: LAYER.accent,
      });
    }
  }

  private outro(): void {
    const lastBeat = this.analysis.beats.at(-1);
    if (!lastBeat) return;
    const start = lastBeat.tMs + this.beat;
    const end = this.analysis.durationMs;
    if (end - start < 200) return;
    this.add({
      layer: LAYER.background,
      startMs: start,
      endMs: end,
      color: scale(INTRO_PALETTE.a, 0.4),
      fadeInMs: 0,
      fadeOutMs: end - start,
      shape: { kind: "fill" },
    });
  }

  // ---- Patterns for loud bars ----

  private pattern(
    mode: Mode,
    from: number,
    to: number,
    palette: Palette,
    barIndex: number,
  ): void {
    switch (mode) {
      case "pulse":
        return this.kickFlashes(from, to, palette);
      case "sweeps":
        return this.beatSweeps(from, to, palette, barIndex);
      case "chase":
        return this.columnChase(from, to, palette, barIndex);
      case "strobe":
        return this.halfStrobe(from, to, palette);
      case "tunnel":
        return this.tunnel(from, to, palette);
    }
  }

  /** Full-crowd flash on every kick, white half-flashes on snares. */
  private kickFlashes(from: number, to: number, palette: Palette): void {
    const kicks = this.hitsIn("low", from, to, 0.35);
    kicks.forEach((hit, k) => {
      const next = kicks[k + 1]?.tMs ?? hit.tMs + this.beat;
      const dur = Math.min(next - hit.tMs, this.beat * 0.75);
      this.add({
        layer: LAYER.kick,
        startMs: hit.tMs,
        endMs: hit.tMs + dur,
        color: scale(palette.a, this.bright(hit)),
        fadeInMs: 0,
        fadeOutMs: dur,
        shape: { kind: "fill" },
      });
    });
    this.snareHalves(from, to, kicks);
  }

  /** One sweep per beat, alternating direction and colour; kicks flash underneath. */
  private beatSweeps(
    from: number,
    to: number,
    palette: Palette,
    barIndex: number,
  ): void {
    for (const b of this.beatsIn(from, to)) {
      const flip = (barIndex * 4 + b.inBar) % 2 === 0;
      this.sweep(
        b.tMs,
        this.beat,
        scale(flip ? palette.a : palette.b, 0.6 + 0.4 * b.strength),
        {
          direction: flip ? "right" : "left",
          width: 0.3,
          layer: LAYER.pattern,
        },
      );
    }
    this.dimKicks(from, to, palette.b);
  }

  /** Four columns lit in turn on 8th notes, bouncing back and forth. */
  private columnChase(
    from: number,
    to: number,
    palette: Palette,
    barIndex: number,
  ): void {
    const cols = this.columns(4);
    const order = [0, 1, 2, 3, 3, 2, 1, 0];
    const step = this.beat / 2;
    for (let t = from, k = 0; t < to - step / 2; t += step, k++) {
      const col = order[(barIndex * 8 + k) % order.length];
      this.add({
        layer: LAYER.pattern,
        startMs: t,
        endMs: t + step,
        color: scale(
          k % 2 === 0 ? palette.a : WHITE,
          0.6 + 0.4 * levelAt(this.analysis, t),
        ),
        fadeInMs: 0,
        fadeOutMs: step * 0.6,
        shape: { kind: "polygon", points: cols[col] },
      });
    }
    this.dimKicks(from, to, palette.b);
  }

  /** Left and right halves alternate on 8ths; strong kicks strobe white. */
  private halfStrobe(from: number, to: number, palette: Palette): void {
    const step = this.beat / 2;
    for (let t = from, k = 0; t < to - step / 2; t += step, k++) {
      const left = k % 2 === 0;
      this.add({
        layer: LAYER.pattern,
        startMs: t,
        endMs: t + step * 0.7,
        color: scale(
          left ? palette.a : palette.b,
          0.7 + 0.3 * levelAt(this.analysis, t),
        ),
        fadeInMs: 0,
        fadeOutMs: step * 0.3,
        shape: { kind: "polygon", points: this.half(left ? "left" : "right") },
      });
    }
    for (const hit of this.hitsIn("low", from, to, 0.7)) {
      this.add({
        layer: LAYER.accent,
        startMs: hit.tMs,
        endMs: hit.tMs + 80,
        color: WHITE,
        fadeInMs: 0,
        fadeOutMs: 0,
        shape: { kind: "fill" },
      });
    }
  }

  /** Stage-to-back waves on each beat, with snares lighting the halves. */
  private tunnel(from: number, to: number, palette: Palette): void {
    for (const b of this.beatsIn(from, to)) {
      this.sweep(
        b.tMs,
        this.beat * 1.25,
        scale(b.inBar === 0 ? WHITE : palette.a, 0.6 + 0.4 * b.strength),
        {
          direction: "down",
          width: 0.35,
          layer: LAYER.pattern,
        },
      );
    }
    const kicks = this.hitsIn("low", from, to, 0.35);
    this.dimKicks(from, to, palette.b);
    this.snareHalves(from, to, kicks);
  }

  /** Kick flashes at reduced brightness, under a pattern. */
  private dimKicks(from: number, to: number, color: string): void {
    for (const hit of this.hitsIn("low", from, to, 0.35)) {
      const dur = this.beat * 0.5;
      this.add({
        layer: LAYER.kick,
        startMs: hit.tMs,
        endMs: hit.tMs + dur,
        color: scale(color, 0.5 * this.bright(hit)),
        fadeInMs: 0,
        fadeOutMs: dur,
        shape: { kind: "fill" },
      });
    }
  }

  /** Snares that are not on a kick flash one half white, alternating sides. */
  private snareHalves(from: number, to: number, kicks: Hit[]): void {
    let side = 0;
    for (const hit of this.hitsIn("mid", from, to, 0.5)) {
      if (kicks.some((k) => Math.abs(k.tMs - hit.tMs) < 60)) continue;
      const dur = this.beat * 0.4;
      this.add({
        layer: LAYER.accent,
        startMs: hit.tMs,
        endMs: hit.tMs + dur,
        color: scale(WHITE, this.bright(hit)),
        fadeInMs: 0,
        fadeOutMs: dur,
        shape: {
          kind: "polygon",
          points: this.half(side++ % 2 === 0 ? "left" : "right"),
        },
      });
    }
  }

  // ---- Primitives ----

  private sweep(
    t: number,
    dur: number,
    color: string,
    opts: {
      direction: Direction;
      width: number;
      layer: number;
      fade?: boolean;
    },
  ): void {
    const { minX, maxX, minY, maxY } = this.box;
    const horizontal = opts.direction === "right" || opts.direction === "left";
    const span = horizontal ? maxX - minX : maxY - minY;
    const w = span * opts.width;
    let points: Point[];
    let moveTo: Point;
    switch (opts.direction) {
      case "right":
        points = rect(minX - w, -1, minX, 2);
        moveTo = { x: span + w, y: 0 };
        break;
      case "left":
        points = rect(maxX, -1, maxX + w, 2);
        moveTo = { x: -(span + w), y: 0 };
        break;
      case "down":
        points = rect(-1, minY - w, 2, minY);
        moveTo = { x: 0, y: span + w };
        break;
      case "up":
        points = rect(-1, maxY, 2, maxY + w);
        moveTo = { x: 0, y: -(span + w) };
        break;
    }
    this.add({
      layer: opts.layer,
      startMs: t,
      endMs: t + dur,
      color,
      fadeInMs: opts.fade ? dur * 0.2 : 0,
      fadeOutMs: opts.fade ? dur * 0.3 : 0,
      shape: { kind: "polygon", points, moveTo },
    });
  }

  /** A small square at a random spot in the venue. */
  private sparkle(t: number, dur: number, color: string): void {
    const { minX, maxX, minY, maxY } = this.box;
    const size = Math.min(maxX - minX, maxY - minY) * 0.15;
    const x = minX + this.random() * (maxX - minX - size);
    const y = minY + this.random() * (maxY - minY - size);
    this.add({
      layer: LAYER.accent,
      startMs: t,
      endMs: t + dur,
      color,
      fadeInMs: 0,
      fadeOutMs: dur,
      shape: { kind: "polygon", points: rect(x, y, x + size, y + size) },
    });
  }

  private half(side: "left" | "right"): Point[] {
    const mid = (this.box.minX + this.box.maxX) / 2;
    return side === "left" ? rect(-1, -1, mid, 2) : rect(mid, -1, 2, 2);
  }

  private fullRect(): Point[] {
    return rect(-1, -1, 2, 2);
  }

  private columns(n: number): Point[][] {
    const { minX, maxX } = this.box;
    const w = (maxX - minX) / n;
    return Array.from({ length: n }, (_, k) => {
      const x0 = k === 0 ? -1 : minX + k * w;
      const x1 = k === n - 1 ? 2 : minX + (k + 1) * w;
      return rect(x0, -1, x1, 2);
    });
  }

  private add(clip: Omit<Clip, "id">): void {
    const end = this.analysis.durationMs;
    const startMs = Math.max(0, Math.round(clip.startMs));
    const endMs = Math.min(Math.round(end), Math.round(clip.endMs));
    if (endMs <= startMs) return;
    this.clips.push({
      ...clip,
      id: `auto-${this.clips.length}`,
      startMs,
      endMs,
      fadeInMs: Math.round(clip.fadeInMs),
      fadeOutMs: Math.round(clip.fadeOutMs),
    });
  }

  // ---- Analysis lookups ----

  private beatsIn(from: number, to: number) {
    return this.analysis.beats.filter((b) => b.tMs >= from && b.tMs < to);
  }

  private hitsIn(
    band: "low" | "mid" | "high",
    from: number,
    to: number,
    minStrength: number,
  ): Hit[] {
    return this.analysis.hits[band].filter(
      (h) => h.tMs >= from && h.tMs < to && h.strength >= minStrength,
    );
  }

  private levelOver(from: number, to: number): number {
    let sum = 0;
    let n = 0;
    for (let t = from; t < to; t += 50, n++) sum += levelAt(this.analysis, t);
    return n ? sum / n : 0;
  }

  /** Flash brightness from the hit strength and the level at the hit. */
  private bright(hit: Hit): number {
    return Math.min(
      1,
      0.35 + 0.4 * hit.strength + 0.25 * levelAt(this.analysis, hit.tMs),
    );
  }
}

function venueBox(venue: Venue): Box {
  const pts = venue.shapes.flatMap((s) => s.points);
  if (pts.length === 0) return { minX: 0, maxX: 1, minY: 0, maxY: 1 };
  return {
    minX: Math.min(...pts.map((p) => p.x)),
    maxX: Math.max(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxY: Math.max(...pts.map((p) => p.y)),
  };
}

function rect(x0: number, y0: number, x1: number, y1: number): Point[] {
  return [
    { x: x0, y: y0 },
    { x: x1, y: y0 },
    { x: x1, y: y1 },
    { x: x0, y: y1 },
  ];
}

/** `#rrggbb` scaled towards black by `f` in 0..1. */
export function scale(hex: string, f: number): string {
  const k = Math.max(0, Math.min(1, f));
  const ch = (i: number) =>
    Math.round(parseInt(hex.slice(i, i + 2), 16) * k)
      .toString(16)
      .padStart(2, "0");
  return `#${ch(1)}${ch(3)}${ch(5)}`;
}

/** Small deterministic PRNG, so a track always produces the same show. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
