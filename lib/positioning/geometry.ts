/**
 * Small linear-algebra helpers for the positioning code. 3x3 matrices are
 * row-major arrays of 9 numbers; a homography maps (u, v, 1) to image pixels.
 */

export type Mat3 = number[];
export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export function project(hm: Mat3, u: number, v: number): Vec2 | null {
  const z = hm[6]! * u + hm[7]! * v + hm[8]!;
  if (Math.abs(z) < 1e-12) return null;
  return [
    (hm[0]! * u + hm[1]! * v + hm[2]!) / z,
    (hm[3]! * u + hm[4]! * v + hm[5]!) / z,
  ];
}

function normaliser(pts: readonly Vec2[]) {
  let mx = 0;
  let my = 0;
  for (const [x, y] of pts) {
    mx += x;
    my += y;
  }
  mx /= pts.length;
  my /= pts.length;
  let d = 0;
  for (const [x, y] of pts) d += Math.hypot(x - mx, y - my);
  const s = Math.SQRT2 / (d / pts.length || 1);
  return { s, mx, my };
}

/** Least-squares homography mapping src[i] to dst[i] (normalised DLT, h33 = 1). */
export function homography(
  src: readonly Vec2[],
  dst: readonly Vec2[],
): Mat3 | null {
  const ns = normaliser(src);
  const nd = normaliser(dst);
  const A = Array.from({ length: 8 }, () => new Float64Array(8));
  const b = new Float64Array(8);
  const add = (r: readonly number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      if (!r[i]) continue;
      for (let j = 0; j < 8; j++) A[i]![j]! += r[i]! * r[j]!;
      b[i]! += r[i]! * rhs;
    }
  };
  for (let k = 0; k < src.length; k++) {
    const x = (src[k]![0] - ns.mx) * ns.s;
    const y = (src[k]![1] - ns.my) * ns.s;
    const X = (dst[k]![0] - nd.mx) * nd.s;
    const Y = (dst[k]![1] - nd.my) * nd.s;
    add([x, y, 1, 0, 0, 0, -X * x, -X * y], X);
    add([0, 0, 0, x, y, 1, -Y * x, -Y * y], Y);
  }
  const h = solve(A, b);
  if (!h) return null;
  const Hn = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!, 1];
  const Ts = [ns.s, 0, -ns.s * ns.mx, 0, ns.s, -ns.s * ns.my, 0, 0, 1];
  const TdInv = [1 / nd.s, 0, nd.mx, 0, 1 / nd.s, nd.my, 0, 0, 1];
  return mul3(TdInv, mul3(Hn, Ts));
}

/** Solve A x = b by Gaussian elimination with partial pivoting. */
export function solve(
  A: readonly ArrayLike<number>[],
  b: ArrayLike<number>,
): Float64Array | null {
  const n = b.length;
  const M = A.map((r, i) => [...Array.from(r), b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    }
    if (Math.abs(M[p]![c]!) < 1e-12) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = c + 1; r < n; r++) {
      const f = M[r]![c]! / M[c]![c]!;
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let k = r + 1; k < n; k++) s -= M[r]![k]! * x[k]!;
    x[r] = s / M[r]![r]!;
  }
  return x;
}

export function mul3(a: readonly number[], b: readonly number[]): Mat3 {
  const o: number[] = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      o[r * 3 + c] =
        a[r * 3]! * b[c]! +
        a[r * 3 + 1]! * b[3 + c]! +
        a[r * 3 + 2]! * b[6 + c]!;
    }
  }
  return o;
}

export function inv3(m: readonly number[]): Mat3 | null {
  const [a, b, c, d, e, f, g, h, i] = m as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-15) return null;
  return [
    A / det,
    -(b * i - c * h) / det,
    (b * f - c * e) / det,
    B / det,
    (a * i - c * g) / det,
    -(a * f - c * d) / det,
    C / det,
    -(a * h - b * g) / det,
    (a * e - b * d) / det,
  ];
}

export function transpose3(m: readonly number[]): Mat3 {
  return [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Nearest rotation matrix (polar decomposition by Newton iteration). */
export function orthonormalise(R: readonly number[]): Mat3 {
  let M = R.slice();
  for (let k = 0; k < 20; k++) {
    const inv = inv3(M);
    if (!inv) break;
    const it = transpose3(inv);
    M = M.map((v, i) => 0.5 * (v + it[i]!));
  }
  return M;
}

/** Rotation matrix for a rotation vector (axis times angle in radians). */
export function rodrigues(w: Vec3): Mat3 {
  const th = Math.hypot(w[0], w[1], w[2]);
  if (th < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const [x, y, z] = [w[0] / th, w[1] / th, w[2] / th];
  const c = Math.cos(th);
  const s = Math.sin(th);
  const C = 1 - c;
  return [
    c + x * x * C,
    x * y * C - z * s,
    x * z * C + y * s,
    y * x * C + z * s,
    c + y * y * C,
    y * z * C - x * s,
    z * x * C - y * s,
    z * y * C + x * s,
    c + z * z * C,
  ];
}

/** Long-side field of view (degrees) to focal length in pixels. */
export function focalFromFov(fovDeg: number, w: number, h: number): number {
  return Math.max(w, h) / 2 / Math.tan((fovDeg * Math.PI) / 360);
}

/** Focal length in pixels to long-side field of view (degrees). */
export function fovFromFocal(f: number, w: number, h: number): number {
  return (2 * Math.atan(Math.max(w, h) / 2 / f) * 180) / Math.PI;
}
