import {
  cross,
  homography,
  mul3,
  orthonormalise,
  project,
  rodrigues,
  solve,
  transpose3,
  type Mat3,
  type Vec2,
  type Vec3,
} from "./geometry";
import { CELLS, CORNERS, DOT_R, H, STEP, W } from "./pattern";

/**
 * Finds the positioning target in a greyscale camera frame and works out
 * where the camera is relative to it. Pure code, so it runs in the phone
 * browser and in tests alike.
 *
 * 1. Adaptive threshold: bright features on a dark screen.
 * 2. Connected components with sub-pixel, brightness-weighted centroids.
 * 3. Anchors: a ring component with a core component at its centre.
 * 4. For each way of matching four anchors to the four corners, project the
 *    grille and check which LEDs are lit. The right match reads back the
 *    pattern. Too far away to read the grille, fall back to the anchors alone.
 * 5. Refit the homography on every matched LED.
 * 6. Pose from the homography, refined by Levenberg-Marquardt on reprojection
 *    error, trying both sides of the planar flip ambiguity.
 */

/** A pattern point (units) matched to an image point (pixels). */
export type Match = { u: number; v: number; x: number; y: number };

export type Detection = {
  corners: Match[];
  /** Pattern units to image pixels. */
  homography: Mat3;
  matches: Match[];
  /** Fraction of grille cells that read as expected (0 when `coarse`). */
  score: number;
  /** Matched from the four anchors only, assuming the phone is upright. */
  coarse: boolean;
};

type Component = {
  id: number;
  area: number;
  weight: number;
  x: number;
  y: number;
  bw: number;
  bh: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type Anchor = { x: number; y: number; size: number };

type GridRead = { score: number; matches: Match[] };

export class Detector {
  private cap = 0;
  private w = 0;
  private h = 0;
  private fg = new Uint8Array(0);
  private weight = new Float32Array(0);
  private labels = new Int32Array(0);
  private parent = new Int32Array(0);
  private ii = new Float64Array(0);
  private tiles = {
    min: new Uint8Array(0),
    max: new Uint8Array(0),
    nmin: new Uint8Array(0),
    nmax: new Uint8Array(0),
  };
  /** Anchors found in the last frame, for drawing an overlay. */
  anchors: Anchor[] = [];

  /** `gray` is w*h bytes. Returns null when the target is not in view. */
  detect(gray: Uint8Array, w: number, h: number): Detection | null {
    this.ensure(w * h);
    this.w = w;
    this.h = h;
    this.threshold(gray, w, h);
    const comps = this.components(w, h);
    this.anchors = this.findAnchors(comps);
    if (this.anchors.length < 4) return null;
    return this.matchGrid(this.anchors, comps);
  }

  private ensure(n: number) {
    if (n <= this.cap) return;
    this.cap = n;
    this.fg = new Uint8Array(n);
    this.weight = new Float32Array(n);
    this.labels = new Int32Array(n);
    this.parent = new Int32Array(Math.floor(n / 2) + 2);
  }

  private threshold(gray: Uint8Array, w: number, h: number) {
    // Integral image with a one-pixel zero border.
    const iw = w + 1;
    const need = iw * (h + 1);
    if (this.ii.length < need) this.ii = new Float64Array(need);
    const ii = this.ii;
    for (let x = 0; x <= w; x++) ii[x] = 0;
    for (let y = 0; y < h; y++) {
      let row = 0;
      const base = (y + 1) * iw;
      ii[base] = 0;
      for (let x = 0; x < w; x++) {
        row += gray[y * w + x]!;
        ii[base + x + 1] = ii[base - iw + x + 1]! + row;
      }
    }

    // Min/max over 4px tiles, then spread over each tile's 3x3 neighbourhood.
    // Where there's real contrast, split at the midpoint: that survives both
    // blur (thin dark gaps stay below half way) and sensor noise.
    const T = 4;
    const tw = Math.ceil(w / T);
    const th = Math.ceil(h / T);
    if (this.tiles.min.length < tw * th) {
      this.tiles = {
        min: new Uint8Array(tw * th),
        max: new Uint8Array(tw * th),
        nmin: new Uint8Array(tw * th),
        nmax: new Uint8Array(tw * th),
      };
    }
    const { min: tmin, max: tmax, nmin, nmax } = this.tiles;
    tmin.fill(255, 0, tw * th);
    tmax.fill(0, 0, tw * th);
    for (let y = 0; y < h; y++) {
      const trow = ((y / T) | 0) * tw;
      for (let x = 0; x < w; x++) {
        const g = gray[y * w + x]!;
        const t = trow + ((x / T) | 0);
        if (g < tmin[t]!) tmin[t] = g;
        if (g > tmax[t]!) tmax[t] = g;
      }
    }
    for (let ty = 0; ty < th; ty++) {
      for (let tx = 0; tx < tw; tx++) {
        let lo = 255;
        let hi = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = ty + dy;
          if (yy < 0 || yy >= th) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = tx + dx;
            if (xx < 0 || xx >= tw) continue;
            const t = yy * tw + xx;
            if (tmin[t]! < lo) lo = tmin[t]!;
            if (tmax[t]! > hi) hi = tmax[t]!;
          }
        }
        nmin[ty * tw + tx] = lo;
        nmax[ty * tw + tx] = hi;
      }
    }

    // Most of the frame is flat, so the median neighbourhood range is roughly
    // the noise floor. Real edges need to clear it comfortably. Flat regions
    // (dark background, or the inside of a big shape up close) fall back to
    // comparing a 3x3 average against a wide local mean.
    const hist = new Uint32Array(256);
    for (let t = 0; t < tw * th; t++) hist[nmax[t]! - nmin[t]!]!++;
    let acc = 0;
    let medRange = 0;
    while (medRange < 255 && (acc += hist[medRange]!) < (tw * th) / 2) {
      medRange++;
    }
    const minContrast = Math.max(28, medRange * 2);
    const r = Math.max(8, Math.round(Math.max(w, h) / 14));
    const C = Math.max(14, medRange * 0.5);
    const box = (x0: number, y0: number, x1: number, y1: number) =>
      (ii[y1 * iw + x1]! -
        ii[y0 * iw + x1]! -
        ii[y1 * iw + x0]! +
        ii[y0 * iw + x0]!) /
      ((x1 - x0) * (y1 - y0));
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h, y + r + 1);
      const trow = ((y / T) | 0) * tw;
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const t = trow + ((x / T) | 0);
        let d: number;
        if (nmax[t]! - nmin[t]! >= minContrast) {
          d = gray[i]! - (nmax[t]! + nmin[t]!) / 2;
        } else {
          const mean = box(Math.max(0, x - r), y0, Math.min(w, x + r + 1), y1);
          const px = box(
            Math.max(0, x - 1),
            Math.max(0, y - 1),
            Math.min(w, x + 2),
            Math.min(h, y + 2),
          );
          d = px - mean - C;
        }
        if (d > 0) {
          this.fg[i] = 1;
          this.weight[i] = d;
        } else {
          this.fg[i] = 0;
        }
      }
    }
  }

  /** Label 8-connected bright regions. Index 0 is unused (background). */
  private components(w: number, h: number): (Component | null)[] {
    const { fg, labels: L, parent } = this;
    let next = 1;
    const find = (a: number) => {
      while (parent[a] !== a) {
        parent[a] = parent[parent[a]!]!;
        a = parent[a]!;
      }
      return a;
    };
    const union = (a: number, b: number) => {
      a = find(a);
      b = find(b);
      if (a < b) parent[b] = a;
      else if (b < a) parent[a] = b;
    };

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!fg[i]) {
          L[i] = 0;
          continue;
        }
        let l = 0;
        const consider = (j: number) => {
          const lj = L[j]!;
          if (!lj) return;
          if (!l) l = lj;
          else if (lj !== l) union(l, lj);
        };
        if (x > 0) consider(i - 1);
        if (y > 0) {
          if (x > 0) consider(i - w - 1);
          consider(i - w);
          if (x < w - 1) consider(i - w + 1);
        }
        if (!l) {
          // Pathological noise: give up on this frame.
          if (next >= parent.length) return [null];
          l = next++;
          parent[l] = l;
        }
        L[i] = l;
      }
    }

    // Compact roots to 1..k and gather stats.
    const remap = new Int32Array(next);
    let k = 0;
    for (let l = 1; l < next; l++) if (find(l) === l) remap[l] = ++k;
    for (let l = 1; l < next; l++) remap[l] = remap[find(l)]!;

    const area = new Int32Array(k + 1);
    const sw = new Float64Array(k + 1);
    const sx = new Float64Array(k + 1);
    const sy = new Float64Array(k + 1);
    const minX = new Int32Array(k + 1).fill(w);
    const minY = new Int32Array(k + 1).fill(h);
    const maxX = new Int32Array(k + 1).fill(-1);
    const maxY = new Int32Array(k + 1).fill(-1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!L[i]) continue;
        const c = (L[i] = remap[L[i]!]!);
        const ww = this.weight[i]!;
        area[c]!++;
        sw[c]! += ww;
        sx[c]! += ww * (x + 0.5);
        sy[c]! += ww * (y + 0.5);
        if (x < minX[c]!) minX[c] = x;
        if (x > maxX[c]!) maxX[c] = x;
        if (y < minY[c]!) minY[c] = y;
        if (y > maxY[c]!) maxY[c] = y;
      }
    }

    const comps: (Component | null)[] = [null];
    for (let c = 1; c <= k; c++) {
      comps.push({
        id: c,
        area: area[c]!,
        weight: sw[c]!,
        x: sx[c]! / sw[c]!,
        y: sy[c]! / sw[c]!,
        bw: maxX[c]! - minX[c]! + 1,
        bh: maxY[c]! - minY[c]! + 1,
        minX: minX[c]!,
        minY: minY[c]!,
        maxX: maxX[c]!,
        maxY: maxY[c]!,
      });
    }
    return comps;
  }

  private labelAt(x: number, y: number): number {
    x = Math.floor(x);
    y = Math.floor(y);
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.labels[y * this.w + x]!;
  }

  /** A ring-shaped component with a solid component sitting in its hole. */
  private findAnchors(comps: readonly (Component | null)[]): Anchor[] {
    const anchors: Anchor[] = [];
    for (let c = 1; c < comps.length; c++) {
      const ring = comps[c]!;
      if (ring.area < 16 || ring.bw < 6 || ring.bh < 6) continue;
      const size = Math.max(ring.bw, ring.bh);
      if (Math.min(ring.bw, ring.bh) / size < 0.2) continue;
      const fill = ring.area / (ring.bw * ring.bh);
      if (fill < 0.12 || fill > 0.62) continue;
      // The ring's own centroid sits in its hole; the core should be there.
      let core: Component | null = null;
      for (let dy = -1; dy <= 1 && !core; dy++) {
        for (let dx = -1; dx <= 1 && !core; dx++) {
          const l = this.labelAt(ring.x + dx, ring.y + dy);
          if (l && l !== c) core = comps[l]!;
        }
      }
      if (!core) continue;
      if (
        core.minX <= ring.minX ||
        core.maxX >= ring.maxX ||
        core.minY <= ring.minY ||
        core.maxY >= ring.maxY
      ) {
        continue;
      }
      const ratio = Math.max(core.bw, core.bh) / size;
      if (ratio < 0.18 || ratio > 0.62) continue;
      if (core.area / (core.bw * core.bh) < 0.4) continue;
      if (Math.hypot(core.x - ring.x, core.y - ring.y) > 0.15 * size) continue;
      const tw = ring.weight + core.weight;
      anchors.push({
        x: (ring.x * ring.weight + core.x * core.weight) / tw,
        y: (ring.y * ring.weight + core.y * core.weight) / tw,
        size,
      });
    }
    return anchors;
  }

  private matchGrid(
    anchors: readonly Anchor[],
    comps: readonly (Component | null)[],
  ): Detection | null {
    const cands = anchors
      .slice()
      .sort((a, b) => b.size - a.size)
      .slice(0, 8);
    let best:
      (GridRead & { quad: Anchor[]; rot: number; homography: Mat3 }) | null =
      null;
    for (const quad of quads(cands)) {
      const sizes = quad.map((q) => q.size);
      if (Math.max(...sizes) / Math.min(...sizes) > 4) continue;
      for (let rot = 0; rot < 4; rot++) {
        const src = [0, 1, 2, 3].map((i) => CORNERS[(i + rot) % 4] as Vec2);
        const hm = homography(
          src,
          quad.map((q) => [q.x, q.y]),
        );
        if (!hm) continue;
        const res = this.readGrid(hm, comps, best ? best.score : 0.6);
        if (res && (!best || res.score > best.score)) {
          best = { ...res, quad, rot, homography: hm };
        }
      }
    }
    if (!best || best.score < 0.8) return this.anchorsOnly(cands);

    // Refit on every matched LED plus the corners, then read the grille again
    // with the better homography to pick up LEDs the first pass missed.
    const { rot } = best;
    const corners = best.quad.map((q, i) => {
      const [u, v] = CORNERS[(i + rot) % 4]!;
      return { u, v, x: q.x, y: q.y };
    });
    let hm = best.homography;
    let res: GridRead = best;
    for (let iter = 0; iter < 2; iter++) {
      const all = corners.concat(res.matches);
      const refit = homography(
        all.map((m) => [m.u, m.v]),
        all.map((m) => [m.x, m.y]),
      );
      if (!refit) break;
      hm = refit;
      const again = this.readGrid(hm, comps, 0);
      if (!again) break;
      res = again;
    }
    return {
      corners,
      homography: hm,
      matches: corners.concat(res.matches),
      score: res.score,
      coarse: false,
    };
  }

  /**
   * Too far away to read the grille, but the four anchors are still clear.
   * Without the grille the pattern can't say which corner is which, so assume
   * the phone's display is the right way up: the screen's top edge is then
   * the top edge in the image.
   */
  private anchorsOnly(cands: readonly Anchor[]): Detection | null {
    // The four that best look like a rectangle seen from a distance: similar
    // sizes, opposite edges nearly equal and parallel.
    let quad: Anchor[] | null = null;
    let bestCost = Infinity;
    for (const q of quads(cands)) {
      const sizes = q.map((e) => e.size);
      const sizeSpread = Math.max(...sizes) / Math.min(...sizes);
      if (sizeSpread > 2.5) continue;
      const e = [0, 1, 2, 3].map((i): Vec2 => {
        const a = q[i]!;
        const b = q[(i + 1) % 4]!;
        return [b.x - a.x, b.y - a.y];
      });
      const skew = Math.max(
        Math.hypot(e[0]![0] + e[2]![0], e[0]![1] + e[2]![1]) /
          Math.hypot(...e[0]!),
        Math.hypot(e[1]![0] + e[3]![0], e[1]![1] + e[3]![1]) /
          Math.hypot(...e[1]!),
      );
      if (skew > 0.25) continue;
      const cost = skew + (sizeSpread - 1);
      if (cost < bestCost) {
        bestCost = cost;
        quad = q;
      }
    }
    if (!quad) return null;
    const qd = quad;
    // Quads go clockwise. The top edge is the highest one; it must be close
    // enough to level to be sure, and the long side (16:9).
    const mid = (i: number) => (qd[i]!.y + qd[(i + 1) % 4]!.y) / 2;
    const top = [0, 1, 2, 3].reduce((t, i) => (mid(i) < mid(t) ? i : t), 0);
    const ex = qd[(top + 1) % 4]!.x - qd[top]!.x;
    const ey = qd[(top + 1) % 4]!.y - qd[top]!.y;
    if (Math.abs(Math.atan2(ey, ex)) > (40 * Math.PI) / 180) return null;
    const side = Math.hypot(
      qd[(top + 2) % 4]!.x - qd[(top + 1) % 4]!.x,
      qd[(top + 2) % 4]!.y - qd[(top + 1) % 4]!.y,
    );
    if (Math.hypot(ex, ey) < side) return null;
    const corners = [0, 1, 2, 3].map((k) => {
      const q = qd[(top + k) % 4]!;
      const [u, v] = CORNERS[k]!;
      return { u, v, x: q.x, y: q.y };
    });
    const hm = homography(
      corners.map((m) => [m.u, m.v]),
      corners.map((m) => [m.x, m.y]),
    );
    if (!hm) return null;
    return {
      corners,
      homography: hm,
      matches: corners,
      score: 0,
      coarse: true,
    };
  }

  /** Project every grille cell through `hm` and compare with what's lit. */
  private readGrid(
    hm: Mat3,
    comps: readonly (Component | null)[],
    bar: number,
  ): GridRead | null {
    let good = 0;
    let checked = 0;
    const matches: Match[] = [];
    for (const cell of CELLS) {
      const p = project(hm, cell.u, cell.v);
      const px = project(hm, cell.u + STEP, cell.v);
      const py = project(hm, cell.u, cell.v + STEP);
      if (!p || !px || !py) return null;
      const s = Math.min(
        Math.hypot(px[0] - p[0], px[1] - p[1]),
        Math.hypot(py[0] - p[0], py[1] - p[1]),
      );
      if (s < 3) return null;
      if (p[0] < 0 || p[1] < 0 || p[0] >= this.w || p[1] >= this.h) continue;

      const r = Math.max(1, Math.min(10, Math.round(s * 0.3)));
      const ledArea = ((2 * s * DOT_R) / STEP) ** 2;
      const maxArea = Math.max(9, ledArea * 3);
      const minArea = Math.max(2, ledArea * 0.2); // smaller is speckle
      let found: Component | null = null;
      let foundD = s * 0.35;
      const x0 = Math.floor(p[0]);
      const y0 = Math.floor(p[1]);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const l = this.labelAt(x0 + dx, y0 + dy);
          if (!l) continue;
          const comp = comps[l]!;
          if (comp.area > maxArea || comp.area < minArea) continue;
          const d = Math.hypot(comp.x - p[0], comp.y - p[1]);
          if (d < foundD) {
            foundD = d;
            found = comp;
          }
        }
      }

      checked++;
      if (cell.on) {
        if (found) {
          good++;
          matches.push({ u: cell.u, v: cell.v, x: found.x, y: found.y });
        }
      } else if (!found) good++;

      // Bail out early once this hypothesis can't beat the bar.
      if (checked === 24 && good / checked < Math.max(0.6, bar - 0.15)) {
        return null;
      }
    }
    if (checked < CELLS.length * 0.5) return null;
    return { score: good / checked, matches };
  }
}

/** Every set of 4 candidates that forms a convex quad, ordered clockwise. */
function* quads(cands: readonly Anchor[]): Generator<Anchor[]> {
  const n = cands.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++) {
          const q = orderQuad([cands[a]!, cands[b]!, cands[c]!, cands[d]!]);
          if (q) yield q;
        }
}

/**
 * Sort 4 points into a convex quad, clockwise on screen (y down): the same
 * winding as CORNERS, since a camera in front of the screen can't mirror it.
 */
function orderQuad(pts: Anchor[]): Anchor[] | null {
  const mx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const my = pts.reduce((s, p) => s + p.y, 0) / 4;
  const s = pts
    .slice()
    .sort(
      (a, b) => Math.atan2(a.y - my, a.x - mx) - Math.atan2(b.y - my, b.x - mx),
    );
  for (let i = 0; i < 4; i++) {
    const a = s[i]!;
    const b = s[(i + 1) % 4]!;
    const c = s[(i + 2) % 4]!;
    const turn = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (turn <= 0) return null;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Pose
// ---------------------------------------------------------------------------

/** Pinhole camera in processing pixels. */
export type Camera = { f: number; cx: number; cy: number };

/**
 * Camera position relative to the screen centre, in "target widths" (multiply
 * by the real distance between the left and right anchor centres in metres).
 * `x` is right of centre as the audience sees it, `y` above it, `z` out from
 * the screen into the room.
 */
export type Pose = {
  x: number;
  y: number;
  z: number;
  /** Reprojection error, pixels. */
  rms: number;
  /**
   * The mirrored answer fits almost as well, so left and right can't be told
   * apart yet (target small or square-on in the frame).
   */
  ambiguous: boolean;
  points: number;
};

type PlanePoint = { X: number; Y: number; x: number; y: number };

export function solvePose(matches: readonly Match[], cam: Camera): Pose | null {
  // Plane coordinates with the screen centre at the origin, 1 = target width.
  const pts: PlanePoint[] = matches.map((m) => ({
    X: (m.u - W / 2) / W,
    Y: (m.v - H / 2) / W,
    x: m.x,
    y: m.y,
  }));
  const hm = homography(
    pts.map((p) => [p.X, p.Y]),
    pts.map((p) => [p.x, p.y]),
  );
  if (!hm) return null;

  const { f, cx, cy } = cam;
  const m1: Vec3 = [
    (hm[0]! - cx * hm[6]!) / f,
    (hm[3]! - cy * hm[6]!) / f,
    hm[6]!,
  ];
  const m2: Vec3 = [
    (hm[1]! - cx * hm[7]!) / f,
    (hm[4]! - cy * hm[7]!) / f,
    hm[7]!,
  ];
  const m3: Vec3 = [
    (hm[2]! - cx * hm[8]!) / f,
    (hm[5]! - cy * hm[8]!) / f,
    hm[8]!,
  ];
  let lam = 2 / (Math.hypot(...m1) + Math.hypot(...m2));
  if (m3[2] * lam < 0) lam = -lam;
  const r1 = m1.map((v) => v * lam) as Vec3;
  const r2 = m2.map((v) => v * lam) as Vec3;
  const r3 = cross(r1, r2);
  const t = m3.map((v) => v * lam) as Vec3;
  const R = orthonormalise([
    r1[0],
    r2[0],
    r3[0],
    r1[1],
    r2[1],
    r3[1],
    r1[2],
    r2[2],
    r3[2],
  ]);

  // The planar flip: the same view under weak perspective with the camera
  // mirrored through the screen normal. Rf = Rot_v(pi) * R * diag(-1,-1,1),
  // where v points at the target.
  const tn = Math.hypot(...t);
  const v = t.map((c) => c / tn) as Vec3;
  const Rv = [
    2 * v[0] * v[0] - 1,
    2 * v[0] * v[1],
    2 * v[0] * v[2],
    2 * v[1] * v[0],
    2 * v[1] * v[1] - 1,
    2 * v[1] * v[2],
    2 * v[2] * v[0],
    2 * v[2] * v[1],
    2 * v[2] * v[2] - 1,
  ];
  const Rf = mul3(Rv, [
    -R[0]!,
    -R[1]!,
    R[2]!,
    -R[3]!,
    -R[4]!,
    R[5]!,
    -R[6]!,
    -R[7]!,
    R[8]!,
  ]);

  const a = refine(pts, R, t, cam);
  const b = refine(pts, Rf, [...t], cam);
  const [best, other] = a.rms <= b.rms ? [a, b] : [b, a];
  const C = cameraCentre(best);
  const C2 = cameraCentre(other);
  // Both starts usually land on the same answer. Different answers that fit
  // almost as well mean we can't tell which side of the room we're on.
  const apart =
    Math.hypot(C[0] - C2[0], C[1] - C2[1], C[2] - C2[2]) >
    0.05 * Math.hypot(...C);
  return {
    x: C[0],
    y: -C[1],
    z: -C[2],
    rms: best.rms,
    ambiguous: apart && other.rms < best.rms * 1.5 + 0.2,
    points: pts.length,
  };
}

type Fit = { R: Mat3; t: Vec3; rms: number };

function cameraCentre({ R, t }: Fit): Vec3 {
  const Rt = transpose3(R);
  return [
    -(Rt[0]! * t[0] + Rt[1]! * t[1] + Rt[2]! * t[2]),
    -(Rt[3]! * t[0] + Rt[4]! * t[1] + Rt[5]! * t[2]),
    -(Rt[6]! * t[0] + Rt[7]! * t[1] + Rt[8]! * t[2]),
  ];
}

function residuals(
  pts: readonly PlanePoint[],
  R: Mat3,
  t: Vec3,
  cam: Camera,
  out: Float64Array | null,
): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const X = R[0]! * p.X + R[1]! * p.Y + t[0];
    const Y = R[3]! * p.X + R[4]! * p.Y + t[1];
    const Z = R[6]! * p.X + R[7]! * p.Y + t[2];
    const ex = cam.f * (X / Z) + cam.cx - p.x;
    const ey = cam.f * (Y / Z) + cam.cy - p.y;
    if (out) {
      out[2 * i] = ex;
      out[2 * i + 1] = ey;
    }
    s += ex * ex + ey * ey;
  }
  return s;
}

/** Levenberg-Marquardt over a small rotation (left-multiplied) and translation. */
function refine(
  pts: readonly PlanePoint[],
  R: Mat3,
  t: Vec3,
  cam: Camera,
): Fit {
  const n = pts.length * 2;
  const r0 = new Float64Array(n);
  const r1 = new Float64Array(n);
  const J = Array.from({ length: 6 }, () => new Float64Array(n));
  let cost = residuals(pts, R, t, cam, r0);
  let mu = 1e-3;
  const tScale = Math.hypot(...t);
  for (let iter = 0; iter < 30; iter++) {
    for (let k = 0; k < 6; k++) {
      const eps = k < 3 ? 1e-6 : 1e-6 * tScale;
      const w: Vec3 = [0, 0, 0];
      const dt: Vec3 = [0, 0, 0];
      if (k < 3) w[k] = eps;
      else dt[k - 3] = eps;
      residuals(
        pts,
        mul3(rodrigues(w), R),
        [t[0] + dt[0], t[1] + dt[1], t[2] + dt[2]],
        cam,
        r1,
      );
      for (let i = 0; i < n; i++) J[k]![i] = (r1[i]! - r0[i]!) / eps;
    }
    const A = Array.from({ length: 6 }, () => new Float64Array(6));
    const g = new Float64Array(6);
    for (let a = 0; a < 6; a++) {
      for (let b = a; b < 6; b++) {
        let s = 0;
        for (let i = 0; i < n; i++) s += J[a]![i]! * J[b]![i]!;
        A[a]![b] = A[b]![a] = s;
      }
      let s = 0;
      for (let i = 0; i < n; i++) s += J[a]![i]! * r0[i]!;
      g[a] = -s;
    }
    let improved = false;
    for (let tries = 0; tries < 8; tries++) {
      const damped = A.map((row, i) => {
        const r = Float64Array.from(row);
        r[i]! *= 1 + mu;
        return r;
      });
      const d = solve(damped, g);
      if (!d) {
        mu *= 10;
        continue;
      }
      const Rn = mul3(rodrigues([d[0]!, d[1]!, d[2]!]), R);
      const tn: Vec3 = [t[0] + d[3]!, t[1] + d[4]!, t[2] + d[5]!];
      const c = residuals(pts, Rn, tn, cam, r1);
      if (c < cost) {
        const small = cost - c < 1e-10 * cost;
        R = Rn;
        t = tn;
        cost = c;
        r0.set(r1);
        mu = Math.max(mu / 10, 1e-9);
        improved = !small;
        break;
      }
      mu *= 10;
    }
    if (!improved) break;
  }
  return { R: orthonormalise(R), t, rms: Math.sqrt(cost / pts.length) };
}
