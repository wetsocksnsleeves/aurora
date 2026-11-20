// Audio analysis for generating a light show from a track. Pure: takes mono
// PCM samples and returns frame features, a beat grid and per-bar energy.
// Decoding is the caller's job (ffmpeg in scripts/, Web Audio in a browser).

/** Analysis frame size and hop, in samples. 1024/512 at 22.05 kHz is 46/23 ms. */
export const FRAME = 1024;
export const HOP = 512;

/** Frequency bands, in Hz. Low carries the kick, high carries hats and claps. */
const BANDS = {
  low: [30, 150],
  mid: [150, 2000],
  high: [2000, 11000],
} as const;
export type Band = keyof typeof BANDS;

const MIN_BPM = 70;
const MAX_BPM = 190;
/** Prior on tempo: log-normal around this BPM, as in librosa's beat tracker. */
const PRIOR_BPM = 125;
/** How strongly the beat tracker sticks to the tempo. librosa uses 100. */
const TIGHTNESS = 100;

export type Beat = {
  tMs: number;
  /** 0..3 position in the bar; 0 is the downbeat. */
  inBar: number;
  /** Onset strength at the beat, 0..1 relative to the track's loud beats. */
  strength: number;
  /** Low-band (kick) onset strength at the beat, 0..1. */
  kick: number;
};

export type Bar = {
  startMs: number;
  endMs: number;
  /** Mean RMS level over the bar in dB relative to the track's loud bars (p95), so mostly <= 0. */
  db: number;
  /** 0..1 rank of `db` among all bars. */
  rank: number;
};

/** A strong onset in one band: a kick (low), snare or clap (mid), hat (high). */
export type Hit = { tMs: number; strength: number };

export type AudioAnalysis = {
  durationMs: number;
  bpm: number;
  beatMs: number;
  beats: Beat[];
  bars: Bar[];
  /** Strong onsets per band, at least a 16th note apart. */
  hits: Record<Band, Hit[]>;
  /** Frame-rate envelopes, for callers that want amplitude at any time. */
  frameMs: number;
  /** Time of frame 0's centre; frame f is at `f * frameMs + centreMs`. */
  centreMs: number;
  /** RMS per frame, 0..1 relative to the track's loud frames (p95). */
  level: Float32Array;
};

/** Analyse mono PCM samples in -1..1. */
export function analyseAudio(
  samples: Float32Array,
  sampleRate: number,
): AudioAnalysis {
  const durationMs = (samples.length / sampleRate) * 1000;
  const frameMs = (HOP / sampleRate) * 1000;
  // Frames are not centred, so frame f is heard at the middle of its window.
  const centreMs = (FRAME / 2 / sampleRate) * 1000;
  const timeOf = (f: number) => f * frameMs + centreMs;
  const { rms, flux } = frameFeatures(samples, sampleRate);
  const n = rms.length;

  const onset = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    onset[i] = flux.low[i] + flux.mid[i] + flux.high[i];
  }
  normaliseInPlace(onset, 0.98);
  const kick = normaliseInPlace(Float32Array.from(flux.low), 0.98);
  const level = normaliseInPlace(Float32Array.from(rms), 0.95);

  const periodFrames = estimatePeriod(onset, frameMs);
  const beatFrames = trackBeats(onset, periodFrames);
  const bpm = 60_000 / (periodFrames * frameMs);
  const beatMs = periodFrames * frameMs;

  const downbeatPhase = pickDownbeatPhase(beatFrames, kick);
  const beats: Beat[] = beatFrames.map((f, i) => ({
    tMs: timeOf(f),
    inBar: (((i - downbeatPhase) % 4) + 4) % 4,
    strength: peakNear(onset, f, 2),
    kick: peakNear(kick, f, 2),
  }));

  const bars = barsFromBeats(beats, beatMs, durationMs, rms, frameMs);
  const hits = {
    low: bandHits(flux.low, beatMs / 4, timeOf),
    mid: bandHits(flux.mid, beatMs / 4, timeOf),
    high: bandHits(flux.high, beatMs / 4, timeOf),
  };

  return {
    durationMs,
    bpm,
    beatMs,
    beats,
    bars,
    hits,
    frameMs,
    centreMs,
    level,
  };
}

/** Level (0..1) at `tMs`, from the frame envelope. */
export function levelAt(analysis: AudioAnalysis, tMs: number): number {
  const i = Math.round((tMs - analysis.centreMs) / analysis.frameMs);
  return analysis.level[Math.max(0, Math.min(analysis.level.length - 1, i))];
}

type BandFlux = Record<Band, Float32Array>;

export function frameFeatures(
  samples: Float32Array,
  sampleRate: number,
): { rms: Float32Array; flux: BandFlux } {
  const n = Math.max(1, Math.floor((samples.length - FRAME) / HOP) + 1);
  const rms = new Float32Array(n);
  const flux: BandFlux = {
    low: new Float32Array(n),
    mid: new Float32Array(n),
    high: new Float32Array(n),
  };
  const window = new Float32Array(FRAME);
  for (let i = 0; i < FRAME; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FRAME);
  }
  const binHz = sampleRate / FRAME;
  const bandBins = Object.fromEntries(
    Object.entries(BANDS).map(([name, [lo, hi]]) => [
      name,
      [
        Math.max(1, Math.floor(lo / binHz)),
        Math.min(FRAME / 2, Math.ceil(hi / binHz)),
      ],
    ]),
  ) as Record<Band, [number, number]>;

  const re = new Float64Array(FRAME);
  const im = new Float64Array(FRAME);
  const half = FRAME / 2;
  let prev = new Float64Array(half + 1);
  let cur = new Float64Array(half + 1);

  for (let f = 0; f < n; f++) {
    const offset = f * HOP;
    let sumSq = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = samples[offset + i] ?? 0;
      sumSq += s * s;
      re[i] = s * window[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(sumSq / FRAME);
    fft(re, im);
    for (let k = 0; k <= half; k++) {
      // Log compression makes quiet and loud passages comparable.
      cur[k] = Math.log1p(1000 * Math.hypot(re[k], im[k]));
    }
    for (const band of Object.keys(BANDS) as Band[]) {
      const [lo, hi] = bandBins[band];
      let sum = 0;
      for (let k = lo; k < hi; k++) sum += Math.max(0, cur[k] - prev[k]);
      flux[band][f] = f === 0 ? 0 : sum / (hi - lo);
    }
    [prev, cur] = [cur, prev];
  }
  return { rms, flux };
}

/** In-place iterative radix-2 FFT. Length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cRe = 1;
      let cIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tRe = re[b] * cRe - im[b] * cIm;
        const tIm = re[b] * cIm + im[b] * cRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nRe = cRe * wRe - cIm * wIm;
        cIm = cRe * wIm + cIm * wRe;
        cRe = nRe;
      }
    }
  }
}

/** Divide by the `q` quantile and clamp to 0..1. Returns the same array. */
function normaliseInPlace(xs: Float32Array, q: number): Float32Array {
  const ref = quantile(xs, q) || 1;
  for (let i = 0; i < xs.length; i++) xs[i] = Math.min(1, xs[i] / ref);
  return xs;
}

export function quantile(xs: ArrayLike<number>, q: number): number {
  if (xs.length === 0) return 0;
  const sorted = Float64Array.from(xs).sort();
  const pos = Math.min(sorted.length - 1, Math.max(0, q * (sorted.length - 1)));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Beat period in frames (fractional), from the autocorrelation of the onset
 * envelope weighted by a tempo prior. Refined to sub-frame precision.
 */
function estimatePeriod(onset: Float32Array, frameMs: number): number {
  const n = onset.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += onset[i];
  mean /= n;
  const x = Float64Array.from(onset, (v) => v - mean);

  const minLag = Math.floor(60_000 / MAX_BPM / frameMs);
  const maxLag = Math.ceil(60_000 / MIN_BPM / frameMs);
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let sum = 0;
    for (let i = lag; i < n; i++) sum += x[i] * x[i - lag];
    ac[lag] = sum / (n - lag);
  }

  let best = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = 60_000 / (lag * frameMs);
    const prior = Math.exp((-0.5 * Math.log2(bpm / PRIOR_BPM) ** 2) / 0.5 ** 2);
    // Add the double-period peak so a strong bar-level pulse supports its beat.
    const score = prior * (ac[lag] + 0.5 * (ac[2 * lag] ?? 0));
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // Parabolic interpolation around the peak.
  const a = ac[best - 1];
  const b = ac[best];
  const c = ac[best + 1];
  const denom = a - 2 * b + c;
  const delta = denom === 0 ? 0 : (0.5 * (a - c)) / denom;
  return best + Math.max(-0.5, Math.min(0.5, delta));
}

/**
 * Dynamic-programming beat tracker (Ellis 2007): picks beat frames that land
 * on strong onsets while keeping the spacing close to `period`.
 */
function trackBeats(onset: Float32Array, period: number): number[] {
  const n = onset.length;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(period / 2);
  const hi = Math.round(period * 2);
  for (let t = 0; t < n; t++) {
    let bestPrev = -1;
    let bestVal = 0;
    for (let p = t - hi; p <= t - lo; p++) {
      if (p < 0) continue;
      const v = score[p] - TIGHTNESS * Math.log((t - p) / period) ** 2;
      if (bestPrev < 0 || v > bestVal) {
        bestVal = v;
        bestPrev = p;
      }
    }
    score[t] = onset[t] + (bestPrev >= 0 ? Math.max(0, bestVal) : 0);
    back[t] = bestPrev >= 0 && bestVal > 0 ? bestPrev : -1;
  }
  // End on the best-scoring frame in the last period.
  let end = n - 1;
  for (let t = Math.max(0, n - Math.ceil(period)); t < n; t++) {
    if (score[t] > score[end]) end = t;
  }
  const beats: number[] = [];
  for (let t = end; t >= 0; t = back[t]) beats.push(t);
  beats.reverse();

  // Trim leading and trailing beats in silence.
  const quiet = 0.08;
  while (beats.length && peakNear(onset, beats[0], 2) < quiet) beats.shift();
  while (beats.length && peakNear(onset, beats[beats.length - 1], 2) < quiet) {
    beats.pop();
  }
  return beats;
}

function peakNear(xs: Float32Array, i: number, radius: number): number {
  let max = 0;
  for (let j = Math.max(0, i - radius); j <= i + radius && j < xs.length; j++) {
    max = Math.max(max, xs[j]);
  }
  return max;
}

/** The beat index offset (0..3) whose beats carry the most kick energy. */
function pickDownbeatPhase(beatFrames: number[], kick: Float32Array): number {
  const sums = [0, 0, 0, 0];
  beatFrames.forEach((f, i) => (sums[i % 4] += peakNear(kick, f, 2)));
  return sums.indexOf(Math.max(...sums));
}

function barsFromBeats(
  beats: Beat[],
  beatMs: number,
  durationMs: number,
  rms: Float32Array,
  frameMs: number,
): Bar[] {
  const starts: number[] = [];
  const first = beats.find((b) => b.inBar === 0);
  if (!first) return [];
  // Bars before the first downbeat, extrapolated back from the grid.
  for (let t = first.tMs - 4 * beatMs; t > -4 * beatMs; t -= 4 * beatMs) {
    starts.unshift(Math.max(0, t));
  }
  for (const b of beats) if (b.inBar === 0) starts.push(b.tMs);
  const last = starts[starts.length - 1];
  for (let t = last + 4 * beatMs; t < durationMs; t += 4 * beatMs) {
    starts.push(t);
  }

  const bars = starts.map((startMs, i) => {
    const endMs = Math.min(durationMs, starts[i + 1] ?? durationMs);
    const a = Math.floor(startMs / frameMs);
    const b = Math.max(a + 1, Math.floor(endMs / frameMs));
    let sumSq = 0;
    let count = 0;
    for (let f = a; f < b && f < rms.length; f++) {
      sumSq += rms[f] * rms[f];
      count++;
    }
    const level = Math.sqrt(sumSq / Math.max(1, count));
    return { startMs, endMs, level };
  });

  const ref = quantile(
    bars.map((b) => b.level),
    0.95,
  );
  const dbs = bars.map((b) => 20 * Math.log10(Math.max(1e-6, b.level / ref)));
  const sorted = [...dbs].sort((x, y) => x - y);
  return bars
    .map((b, i) => ({
      startMs: b.startMs,
      endMs: b.endMs,
      db: dbs[i],
      rank: bars.length > 1 ? sorted.indexOf(dbs[i]) / (bars.length - 1) : 1,
    }))
    .filter((b) => b.endMs > b.startMs);
}

/**
 * Local maxima of one band's onset envelope above its 90th percentile, kept
 * at least `minGapMs` apart (the stronger wins). Strength is relative to the
 * band's 99.5th percentile.
 */
function bandHits(
  xs: Float32Array,
  minGapMs: number,
  timeOf: (f: number) => number,
): Hit[] {
  const threshold = quantile(xs, 0.9);
  const ref = quantile(xs, 0.995) || 1;
  const kept: Hit[] = [];
  for (let i = 2; i < xs.length - 2; i++) {
    const v = xs[i];
    if (v < threshold) continue;
    if (v < xs[i - 1] || v < xs[i - 2] || v <= xs[i + 1] || v <= xs[i + 2]) {
      continue;
    }
    const hit = { tMs: timeOf(i), strength: Math.min(1, v / ref) };
    const prev = kept[kept.length - 1];
    if (prev && hit.tMs - prev.tMs < minGapMs) {
      if (hit.strength > prev.strength) kept[kept.length - 1] = hit;
    } else {
      kept.push(hit);
    }
  }
  return kept;
}
