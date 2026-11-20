import { describe, expect, it } from "vitest";
import {
  focalFromFov,
  homography,
  mul3,
  type Mat3,
  type Vec2,
} from "./geometry";
import {
  OrientationTrack,
  SweepCalibrator,
  focalFromHomography,
  robust,
} from "./lens";
import { CELLS, CORNERS, H, W } from "./pattern";

const IMG: [number, number] = [1280, 720];
const TRUE_FOV = 71; // deliberately not the 66° default
const F = focalFromFov(TRUE_FOV, ...IMG);
const PTS = CORNERS.map(([u, v]) => ({ u, v })).concat(
  CELLS.filter((c) => c.on),
);

function rng(seed: number) {
  let s = seed;
  const rnd = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  return () =>
    Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
}

const T = (m: Mat3): Mat3 => [
  m[0]!,
  m[3]!,
  m[6]!,
  m[1]!,
  m[4]!,
  m[7]!,
  m[2]!,
  m[5]!,
  m[8]!,
];
const rotX = (a: number): Mat3 => [
  1,
  0,
  0,
  0,
  Math.cos(a),
  -Math.sin(a),
  0,
  Math.sin(a),
  Math.cos(a),
];
const rotY = (a: number): Mat3 => [
  Math.cos(a),
  0,
  Math.sin(a),
  0,
  1,
  0,
  -Math.sin(a),
  0,
  Math.cos(a),
];

/** World-to-camera rotation looking at the screen centre from `pos` (metres). */
function baseView(pos: { x: number; y: number; z: number }) {
  const C = [pos.x, -pos.y, -pos.z];
  const n = (v: number[]) => v.map((c) => c / Math.hypot(...v));
  const fwd = n(C.map((c) => -c));
  const right = n([fwd[2]!, 0, -fwd[0]!]); // (0,1,0) x fwd
  const down = [
    fwd[1]! * right[2]! - fwd[2]! * right[1]!,
    fwd[2]! * right[0]! - fwd[0]! * right[2]!,
    fwd[0]! * right[1]! - fwd[1]! * right[0]!,
  ];
  return { C, R: [...right, ...down, ...fwd] as Mat3 };
}

/** A noisy pattern-to-image homography, as the detector would measure it. */
function shoot(
  R: Mat3,
  C: number[],
  width: number,
  gauss: () => number,
  noise = 0.3,
): Mat3 {
  const s = width / W;
  const src: Vec2[] = [];
  const dst: Vec2[] = [];
  for (const { u, v } of PTS) {
    const P = [(u - W / 2) * s - C[0]!, (v - H / 2) * s - C[1]!, -C[2]!];
    const X = R[0]! * P[0]! + R[1]! * P[1]! + R[2]! * P[2]!;
    const Y = R[3]! * P[0]! + R[4]! * P[1]! + R[5]! * P[2]!;
    const Z = R[6]! * P[0]! + R[7]! * P[1]! + R[8]! * P[2]!;
    src.push([u, v]);
    dst.push([
      (F * X) / Z + IMG[0] / 2 + gauss() * noise,
      (F * Y) / Z + IMG[1] / 2 + gauss() * noise,
    ]);
  }
  return homography(src, dst)!;
}

function rotvec(M: Mat3): [number, number, number] {
  const c = Math.max(-1, Math.min(1, (M[0]! + M[4]! + M[8]! - 1) / 2));
  const th = Math.acos(c);
  if (th < 1e-9) return [0, 0, 0];
  const k = th / (2 * Math.sin(th));
  return [(M[7]! - M[5]!) * k, (M[2]! - M[6]!) * k, (M[3]! - M[1]!) * k];
}

describe("focalFromHomography", () => {
  it("measures the lens from an angled front-row view", () => {
    const gauss = rng(5);
    const { C, R } = baseView({ x: 3, y: -1, z: 5 });
    const r = robust(
      Array.from({ length: 15 }, () =>
        focalFromHomography(shoot(R, C, 5, gauss), ...IMG),
      ),
    )!;
    expect(Math.abs(r.median / F - 1)).toBeLessThan(0.01);
    expect(r.spread).toBeLessThan(0.03);
  });

  it("flags a far, square-on view as unreliable", () => {
    const gauss = rng(6);
    const { C, R } = baseView({ x: 0.5, y: -1, z: 25 });
    const r = robust(
      Array.from({ length: 15 }, () =>
        focalFromHomography(shoot(R, C, 5, gauss), ...IMG),
      ),
    );
    expect(r === null || r.spread > 0.03).toBe(true);
  });
});

/** Pan left and right with pauses at each end, like a person following the prompt. */
function sweepPose(t: number): Mat3 {
  const hold = 0.45;
  const move = 0.9;
  const k = t % (2 * (hold + move));
  const ease = (x: number) => (1 - Math.cos(Math.PI * x)) / 2;
  let p: number;
  if (k < hold) p = 0;
  else if (k < hold + move) p = ease((k - hold) / move);
  else if (k < 2 * hold + move) p = 1;
  else p = 1 - ease((k - 2 * hold - move) / move);
  return mul3(
    rotY(((-7 + 14 * p) * Math.PI) / 180),
    rotX(((1.5 - 3 * p) * Math.PI) / 180),
  );
}

describe("SweepCalibrator", () => {
  it.each([
    ["back centre", { x: 0.5, y: -1, z: 25 }, 0],
    ["back centre, frame times 40 ms late", { x: 0.5, y: -1, z: 25 }, 40],
    ["mid centre", { x: 1, y: -1, z: 12 }, 25],
  ] as const)(
    "measures the lens from a sweep: %s",
    (_label, pos, latencyMs) => {
      const gauss = rng(7);
      const { C, R } = baseView(pos);
      const gyro = new OrientationTrack();
      const sweep = new SweepCalibrator(gyro);
      const bias = [0.1, -0.08, 0.05];
      let result: ReturnType<SweepCalibrator["result"]> = null;
      for (let ms = 0; ms < 8000 && !result; ms += 10) {
        const t = ms / 1000;
        // Body-frame rate in camera axes, converted to device axes (y up, z out).
        const d = rotvec(mul3(T(sweepPose(t)), sweepPose(t + 0.01))).map(
          (v) => (v / 0.01) * (180 / Math.PI),
        );
        gyro.push(ms, [
          d[0]! + bias[0]! + gauss() * 0.3,
          -d[1]! + bias[1]! + gauss() * 0.3,
          -d[2]! + bias[2]! + gauss() * 0.3,
        ]);
        if (ms % 30 === 0) {
          sweep.addFrame(
            ms + latencyMs,
            shoot(mul3(T(sweepPose(t)), R), C, 5, gauss),
            ...IMG,
          );
          result = sweep.result();
        }
      }
      expect(result).not.toBeNull();
      expect(Math.abs(result!.f / F - 1)).toBeLessThan(0.03);
    },
  );

  it("gives no answer while the phone is held still", () => {
    const gauss = rng(8);
    const { C, R } = baseView({ x: 0.5, y: -1, z: 25 });
    const gyro = new OrientationTrack();
    const sweep = new SweepCalibrator(gyro);
    for (let ms = 0; ms < 5000; ms += 10) {
      gyro.push(ms, [gauss() * 0.3, gauss() * 0.3, gauss() * 0.3]);
      if (ms % 30 === 0) sweep.addFrame(ms, shoot(R, C, 5, gauss), ...IMG);
    }
    expect(sweep.result()).toBeNull();
  });
});
