import { focalFromFov, orthonormalise, type Mat3, type Vec2 } from "./geometry";
import { H, W } from "./pattern";

/**
 * Working out a phone camera's field of view without anyone measuring
 * anything. Browsers don't report it, and distance scales with it.
 *
 * - Perspective: a homography of a plane only fits a real camera for one
 *   focal length (Zhang's constraints). Strong when the screen is seen at an
 *   angle or up close; useless from far back and square-on, where it all
 *   looks flat.
 * - Sweep: pan the phone between two pauses. The gyro says how many degrees
 *   it turned, the camera says how far the screen slid across the image. The
 *   ratio is the focal length, at any distance, which is what far seats need.
 */

/** Typical phone main camera, long side of the frame. Used until measured. */
export const DEFAULT_FOV = 66;

/**
 * Focal length (px) implied by one pattern-to-image homography, with the
 * principal point at the image centre. NaN when the view can't tell.
 */
export function focalFromHomography(hm: Mat3, w: number, h: number): number {
  const cx = w / 2;
  const cy = h / 2;
  const a = hm[0]! - cx * hm[6]!;
  const b = hm[1]! - cx * hm[7]!;
  const c = hm[3]! - cy * hm[6]!;
  const d = hm[4]! - cy * hm[7]!;
  const e = hm[6]!;
  const g = hm[7]!;
  // h1·ω·h2 = 0 and h1·ω·h1 = h2·ω·h2, with ω = diag(1/f², 1/f², 1).
  const a1 = a * b + c * d;
  const b1 = e * g;
  const a2 = a * a + c * c - b * b - d * d;
  const b2 = e * e - g * g;
  const u = -(a1 * b1 + a2 * b2) / (a1 * a1 + a2 * a2);
  return u > 0 ? 1 / Math.sqrt(u) : NaN;
}

/** Median and a robust relative spread (scaled MAD over the median). */
export function robust(
  values: readonly number[],
): { median: number; spread: number; n: number } | null {
  const v = values.filter(Number.isFinite).sort((p, q) => p - q);
  if (!v.length) return null;
  const median = v[v.length >> 1]!;
  const dev = v.map((x) => Math.abs(x - median)).sort((p, q) => p - q);
  return {
    median,
    spread: (1.4826 * dev[dev.length >> 1]!) / median,
    n: v.length,
  };
}

// ---------------------------------------------------------------------------
// Gyro
// ---------------------------------------------------------------------------

type Quat = [number, number, number, number];

function qmul(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

type GyroSample = { t: number; q: Quat; speed: number };

/**
 * Integrates gyro rates into an orientation history. Feed it `devicemotion`
 * `rotationRate` readings with their time; it holds no browser state.
 */
export class OrientationTrack {
  private hist: GyroSample[] = [];
  private q: Quat = [1, 0, 0, 0];
  /** Time of the last reading, or null before the first. */
  lastT: number | null = null;

  /** `t` in ms; `rate` in degrees per second about the device x, y, z axes. */
  push(t: number, rate: readonly [number, number, number]): void {
    const w = rate.map((v) => (v * Math.PI) / 180);
    if (this.lastT !== null) {
      const dt = (t - this.lastT) / 1000;
      if (dt > 0 && dt < 0.2) {
        const th = Math.hypot(w[0]!, w[1]!, w[2]!) * dt;
        if (th > 0) {
          const s = Math.sin(th / 2) / (th / dt);
          this.q = qmul(this.q, [
            Math.cos(th / 2),
            w[0]! * s,
            w[1]! * s,
            w[2]! * s,
          ]);
        }
      }
    }
    this.lastT = t;
    this.hist.push({ t, q: this.q, speed: Math.hypot(...rate) });
    if (this.hist.length > 4000) this.hist.splice(0, 1000);
  }

  private at(t: number): GyroSample | null {
    const h = this.hist;
    let lo = 0;
    let hi = h.length - 1;
    if (hi < 0) return null;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (h[mid]!.t < t) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(h[lo - 1]!.t - t) < Math.abs(h[lo]!.t - t)) lo--;
    return Math.abs(h[lo]!.t - t) < 60 ? h[lo]! : null;
  }

  /** Fastest turn rate (degrees/s) between two moments, or Infinity if unknown. */
  maxSpeed(t0: number, t1: number): number {
    let m = -1;
    for (let i = this.hist.length - 1; i >= 0; i--) {
      const s = this.hist[i]!;
      if (s.t < t0) break;
      if (s.t <= t1) m = Math.max(m, s.speed);
    }
    return m < 0 ? Infinity : m;
  }

  /** Degrees turned between two moments, or NaN if not covered. */
  angle(t0: number, t1: number): number {
    const a = this.at(t0);
    const b = this.at(t1);
    if (!a || !b) return NaN;
    const dot = Math.abs(
      a.q[0] * b.q[0] + a.q[1] * b.q[1] + a.q[2] * b.q[2] + a.q[3] * b.q[3],
    );
    return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
  }
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

/** Slower than this (degrees/s) counts as a pause. */
const STILL_DPS = 6;
/** Ms either side of a frame that must also be slow. */
const STILL_WINDOW = 80;
/** Degrees between pauses. */
const MIN_TURN = 5;
/** The screen must slide this fraction of the frame between pauses. */
const MIN_SHIFT = 0.08;

/** Points spread over the screen, in pattern units, to compare two views. */
const PROBE: Vec2[] = [0, 0.5, 1].flatMap((a) =>
  [0, 0.5, 1].map((b): Vec2 => [a * W, b * H]),
);

function projectAll(hm: Mat3): Vec2[] {
  return PROBE.map(([u, v]): Vec2 => {
    const z = hm[6]! * u + hm[7]! * v + hm[8]!;
    return [
      (hm[0]! * u + hm[1]! * v + hm[2]!) / z,
      (hm[3]! * u + hm[4]! * v + hm[5]!) / z,
    ];
  });
}

function ray([x, y]: Vec2, f: number, cx: number, cy: number) {
  const v = [(x - cx) / f, (y - cy) / f, 1] as const;
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l] as const;
}

/**
 * If the focal length were f, how far (degrees) would the camera have had to
 * turn to move the screen from `pa` to `pb`? Best-fit rotation between the
 * two sets of viewing rays, from the polar factor of their cross-covariance.
 */
function turnFor(
  pa: readonly Vec2[],
  pb: readonly Vec2[],
  f: number,
  cx: number,
  cy: number,
): number {
  const B = new Array<number>(9).fill(0);
  for (let i = 0; i < pa.length; i++) {
    const ra = ray(pa[i]!, f, cx, cy);
    const rb = ray(pb[i]!, f, cx, cy);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) B[r * 3 + c]! += rb[r]! * ra[c]!;
    }
  }
  const R = orthonormalise(B);
  const c = (R[0]! + R[4]! + R[8]! - 1) / 2;
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI;
}

/** Focal length (px) that makes the image motion match the gyro's turn. */
export function focalFromTurn(
  ha: Mat3,
  hb: Mat3,
  turnDeg: number,
  w: number,
  h: number,
): number {
  const pa = projectAll(ha);
  const pb = projectAll(hb);
  const cx = w / 2;
  const cy = h / 2;
  let lo = focalFromFov(120, w, h);
  let hi = focalFromFov(20, w, h);
  // The same pixel shift is fewer degrees with a longer lens.
  if (!(
    turnFor(pa, pb, lo, cx, cy) >= turnDeg &&
    turnFor(pa, pb, hi, cx, cy) <= turnDeg
  )) {
    return NaN;
  }
  for (let i = 0; i < 40; i++) {
    const mid = Math.sqrt(lo * hi);
    if (turnFor(pa, pb, mid, cx, cy) > turnDeg) lo = mid;
    else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

type Frame = { t: number; hm: Mat3; w: number; h: number };
type Pause = { frames: Frame[]; last: number };

/**
 * Collects detected frames while the phone pans, groups them into pauses,
 * and estimates focal length from every pair of pauses that turned far
 * enough. Frame times must be on the same clock as the gyro readings.
 */
export class SweepCalibrator {
  private pending: Frame[] = [];
  private current: Pause | null = null;
  /** Pauses seen so far (most recent 12). */
  readonly pauses: Pause[] = [];

  constructor(private readonly gyro: OrientationTrack) {}

  /** `t`: capture time. `hm`: pattern to image homography for that frame. */
  addFrame(t: number, hm: Mat3, w: number, h: number): void {
    this.pending.push({ t, hm, w, h });
    this.settle();
  }

  private settle() {
    const last = this.gyro.lastT;
    while (
      this.pending.length &&
      last !== null &&
      this.pending[0]!.t + STILL_WINDOW < last
    ) {
      const fr = this.pending.shift()!;
      const still =
        this.gyro.maxSpeed(fr.t - STILL_WINDOW, fr.t + STILL_WINDOW) <
        STILL_DPS;
      if (!still) {
        this.current = null;
        continue;
      }
      if (!this.current || fr.t - this.current.last > 300) {
        this.current = { frames: [], last: fr.t };
        this.pauses.push(this.current);
        if (this.pauses.length > 12) this.pauses.shift();
      }
      this.current.frames.push(fr);
      this.current.last = fr.t;
    }
  }

  private estimates(): number[] {
    const reps = this.pauses
      .filter((p) => p.frames.length >= 2)
      .map((p) => p.frames[p.frames.length >> 1]!);
    const out: number[] = [];
    for (let i = 0; i < reps.length; i++) {
      for (let j = i + 1; j < reps.length; j++) {
        const a = reps[i]!;
        const b = reps[j]!;
        if (a.w !== b.w || a.h !== b.h) continue;
        const turn = this.gyro.angle(a.t, b.t);
        if (!(turn >= MIN_TURN)) continue;
        // How far the middle of the screen slid across the frame.
        const ca = centre(a.hm);
        const cb = centre(b.hm);
        if (
          Math.hypot(ca[0] - cb[0], ca[1] - cb[1]) <
          MIN_SHIFT * Math.max(a.w, a.h)
        ) {
          continue;
        }
        const f = focalFromTurn(a.hm, b.hm, turn, a.w, a.h);
        if (Number.isFinite(f)) out.push(f);
      }
    }
    return out;
  }

  /** Focal length once at least two pairs of pauses agree, else null. */
  result(): { f: number; pairs: number } | null {
    const est = this.estimates();
    if (est.length < 2) return null;
    const r = robust(est);
    if (!r || r.spread > 0.04) return null;
    return { f: r.median, pairs: est.length };
  }

  /** 0..1, for a progress bar. */
  get progress(): number {
    return Math.min(1, this.estimates().length / 2);
  }
}

function centre(hm: Mat3): Vec2 {
  const u = W / 2;
  const v = H / 2;
  const z = hm[6]! * u + hm[7]! * v + hm[8]!;
  return [
    (hm[0]! * u + hm[1]! * v + hm[2]!) / z,
    (hm[3]! * u + hm[4]! * v + hm[5]!) / z,
  ];
}
