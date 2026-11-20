import { focalFromFov } from "./geometry";
import { EXTENT, H, W, sampleAnalytic } from "./pattern";

/**
 * Renders what a phone camera would see of the target from a known spot, so
 * the detector can be checked against ground truth without a real room.
 * Test-only, but pure, so it lives next to the code it tests.
 */

export type SyntheticView = {
  /** Camera position in metres: x right, y up, z out from the screen. */
  pos: { x: number; y: number; z: number };
  /** Metres between the left and right anchor centres. */
  width: number;
  img?: [number, number];
  /** Long-side field of view, degrees. */
  fov?: number;
  /** Where the camera points, metres from the screen centre (x right, y up). */
  aim?: [number, number];
  /** Rotation about the viewing direction, radians. */
  roll?: number;
  noise?: number;
  /** Passes of a 3x3 box blur. */
  blur?: number;
  seed?: number;
};

type V3 = [number, number, number];

function norm(v: V3): V3 {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a: V3, b: V3): V3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function renderView(view: SyntheticView): {
  gray: Uint8Array;
  w: number;
  h: number;
  f: number;
} {
  const {
    pos,
    width,
    img = [1280, 720],
    fov = 66,
    aim = [0, 0],
    roll = 0,
    noise = 4,
    blur = 1,
    seed = 1,
  } = view;
  const [w, h] = img;
  const f = focalFromFov(fov, w, h);
  // World frame used by the detector: X right, Y down, Z into the screen.
  const C: V3 = [pos.x, -pos.y, -pos.z];
  const look: V3 = [aim[0], -aim[1], 0];
  const fwd = norm([look[0] - C[0], look[1] - C[1], look[2] - C[2]]);
  let right = norm(cross([0, 1, 0], fwd));
  let down = cross(fwd, right);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  [right, down] = [
    right.map((v, i) => cr * v + sr * down[i]!) as V3,
    down.map((v, i) => -sr * right[i]! + cr * v) as V3,
  ];

  const scale = width / W; // metres per pattern unit
  let s = seed >>> 0;
  const rand = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;

  const raw = new Float32Array(w * h);
  const ss = 3;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = (x + (sx + 0.5) / ss - w / 2) / f;
          const py = (y + (sy + 0.5) / ss - h / 2) / f;
          const d = [0, 1, 2].map(
            (i) => right[i]! * px + down[i]! * py + fwd[i]!,
          );
          let val = 0.25; // the room around the screen
          if (d[2]! > 1e-9) {
            const t = -C[2] / d[2]!;
            const u = (C[0] + t * d[0]!) / scale + W / 2;
            const v = (C[1] + t * d[1]!) / scale + H / 2;
            if (
              u >= EXTENT.x0 &&
              u <= EXTENT.x0 + EXTENT.w &&
              v >= EXTENT.y0 &&
              v <= EXTENT.y0 + EXTENT.h
            ) {
              val = 0.04 + 0.9 * sampleAnalytic(u, v);
            }
          }
          acc += val;
        }
      }
      raw[y * w + x] = acc / (ss * ss);
    }
  }

  let cur = raw;
  for (let pass = 0; pass < blur; pass++) {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let a = 0;
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            a += cur[yy * w + xx]!;
            c++;
          }
        }
        out[y * w + x] = a / c;
      }
    }
    cur = out;
  }
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const n = (rand() + rand() + rand() - 1.5) * 2 * noise;
    gray[i] = Math.max(0, Math.min(255, Math.round(cur[i]! * 230 + 10 + n)));
  }
  return { gray, w, h, f };
}
