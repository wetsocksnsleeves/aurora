/**
 * The positioning target shown on the big screen (`/sessions/[code]/screen`).
 * Shared by the screen, which draws it, and the phone, which looks for it, so
 * both agree on the geometry.
 *
 * Everything is in "pattern units". The four corner anchors sit at
 * (0,0) (W,0) (W,H) (0,H). Between them is an LED-grille lattice of square
 * pixels, STEP apart. Some are lit and the rest are drawn dim like unlit LEDs.
 * The lit ones form a pattern that reads differently under each 90° rotation,
 * which lets the phone tell which corner is which however it is held.
 */

export const W = 16;
export const H = 9;

/**
 * Anchors echo the QR code's finder squares: a rounded-square ring around a
 * rounded-square core. A ring with a separate core inside is what the
 * detector looks for. Half-widths and corner radii, in units.
 */
export const ANCHOR = {
  outer: 1.0,
  outerRound: 0.36,
  inner: 0.7,
  innerRound: 0.2,
  core: 0.38,
  coreRound: 0.14,
};
export const STEP = 0.5;
/** Half-width of an LED pixel. */
export const DOT_R = 0.12;
/** LED corner radius, as a fraction of its half-width. */
const DOT_ROUND = 0.45;
/** Brightness of an unlit LED, well under the detector's threshold. */
export const UNLIT = 0.08;
/** Black border around the outer edge of the anchors. */
export const MARGIN = 0.5;

/**
 * Hole in the grille for the join QR code (centre and half-size), with a gap
 * around it and extra room underneath for its label.
 */
export const QR = { cx: W / 2, cy: H / 2, half: 2.3, clear: 0.45, label: 0.95 };

/** Where the "SCAN TO JOIN" label goes, inside the gap under the QR. */
export const QR_LABEL = { u: QR.cx, v: QR.cy + QR.half + 0.55, size: 0.26 };

export const CORNERS: readonly (readonly [number, number])[] = [
  [0, 0],
  [W, 0],
  [W, H],
  [0, H],
];

/** One grille position the phone checks. */
export type Cell = { u: number; v: number; i: number; j: number; on: boolean };

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function inQrHole(u: number, v: number): boolean {
  const du = u - QR.cx;
  const dv = v - QR.cy;
  return (
    Math.abs(du) < QR.half + QR.clear &&
    dv > -(QR.half + QR.clear) &&
    dv < QR.half + QR.label
  );
}

export const CELLS: readonly Cell[] = (() => {
  const rand = rng(0x11647);
  const cells: Cell[] = [];
  const clear = ANCHOR.outer + 0.3;
  for (let j = 0; j <= Math.round(H / STEP); j++) {
    for (let i = 0; i <= Math.round(W / STEP); i++) {
      const u = i * STEP;
      const v = j * STEP;
      const nearCorner = CORNERS.some(
        ([cu, cv]) => Math.max(Math.abs(u - cu), Math.abs(v - cv)) < clear,
      );
      if (nearCorner || inQrHole(u, v)) continue;
      cells.push({ u, v, i, j, on: rand() < 0.62 });
    }
  }
  return cells;
})();

const LIT = new Map(CELLS.map((c) => [c.j * 1000 + c.i, c.on]));

/** Size of the whole drawing, in pattern units, including margins. */
export const EXTENT = {
  x0: -ANCHOR.outer - MARGIN,
  y0: -ANCHOR.outer - MARGIN,
  w: W + 2 * (ANCHOR.outer + MARGIN),
  h: H + 2 * (ANCHOR.outer + MARGIN),
};

/**
 * Draw the target into a 2D canvas. `scale` is pixels per unit and (ox, oy)
 * is where pattern (0,0) lands. `qr` is the join QR code's module matrix.
 */
export function drawPattern(
  ctx: CanvasRenderingContext2D,
  scale: number,
  ox: number,
  oy: number,
  qr: readonly (readonly boolean[])[] | null,
): void {
  const P = (u: number, v: number): [number, number] => [
    ox + u * scale,
    oy + v * scale,
  ];
  const square = (x: number, y: number, half: number, round: number) =>
    ctx.roundRect(
      x - half * scale,
      y - half * scale,
      2 * half * scale,
      2 * half * scale,
      round * scale,
    );
  ctx.fillStyle = "#000";
  ctx.fillRect(
    ox + EXTENT.x0 * scale,
    oy + EXTENT.y0 * scale,
    EXTENT.w * scale,
    EXTENT.h * scale,
  );

  ctx.fillStyle = "#fff";
  for (const [u, v] of CORNERS) {
    const [x, y] = P(u, v);
    ctx.beginPath();
    square(x, y, ANCHOR.outer, ANCHOR.outerRound);
    square(x, y, ANCHOR.inner, ANCHOR.innerRound);
    ctx.fill("evenodd");
    ctx.beginPath();
    square(x, y, ANCHOR.core, ANCHOR.coreRound);
    ctx.fill();
  }

  const unlit = Math.round(UNLIT * 255);
  for (const lit of [false, true]) {
    ctx.fillStyle = lit ? "#fff" : `rgb(${unlit},${unlit},${unlit})`;
    ctx.beginPath();
    for (const c of CELLS) {
      if (c.on !== lit) continue;
      const [x, y] = P(c.u, c.v);
      square(x, y, DOT_R, DOT_R * DOT_ROUND);
    }
    ctx.fill();
  }

  if (qr) drawQr(ctx, scale, P, qr);
}

/** White card, square modules, and rounded finder squares to match the anchors. */
function drawQr(
  ctx: CanvasRenderingContext2D,
  scale: number,
  P: (u: number, v: number) => [number, number],
  qr: readonly (readonly boolean[])[],
): void {
  const n = qr.length;
  const box = QR.half * 2 * scale;
  const [x0, y0] = P(QR.cx - QR.half, QR.cy - QR.half);
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.roundRect(x0, y0, box, box, 0.2 * scale);
  ctx.fill();

  const quiet = 2.2;
  const cell = box / (n + quiet * 2);
  const finders: [number, number][] = [
    [0, 0],
    [0, n - 7],
    [n - 7, 0],
  ];
  const inFinder = (r: number, c: number) =>
    finders.some(([fr, fc]) => r >= fr && r < fr + 7 && c >= fc && c < fc + 7);
  ctx.fillStyle = "#000";
  ctx.beginPath();
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr[r]![c] && !inFinder(r, c)) {
        ctx.rect(
          x0 + (c + quiet) * cell,
          y0 + (r + quiet) * cell,
          cell + 0.5,
          cell + 0.5,
        );
      }
    }
  }
  ctx.fill();
  for (const [fr, fc] of finders) {
    const x = x0 + (fc + quiet) * cell;
    const y = y0 + (fr + quiet) * cell;
    ctx.beginPath();
    ctx.roundRect(x, y, 7 * cell, 7 * cell, 1.4 * cell);
    ctx.roundRect(x + cell, y + cell, 5 * cell, 5 * cell, 0.84 * cell);
    ctx.fill("evenodd");
    ctx.beginPath();
    ctx.roundRect(x + 2 * cell, y + 2 * cell, 3 * cell, 3 * cell, 0.63 * cell);
    ctx.fill();
  }
}

/**
 * Brightness 0..1 of the drawn target at (u, v), without a canvas. Used by
 * the tests to render synthetic camera views. The QR area is plain white.
 */
export function sampleAnalytic(u: number, v: number): number {
  if (Math.abs(u - QR.cx) <= QR.half && Math.abs(v - QR.cy) <= QR.half) {
    return 1;
  }
  for (const [cu, cv] of CORNERS) {
    const dx = u - cu;
    const dy = v - cv;
    if (inSquare(dx, dy, ANCHOR.outer, ANCHOR.outerRound)) {
      return !inSquare(dx, dy, ANCHOR.inner, ANCHOR.innerRound) ||
        inSquare(dx, dy, ANCHOR.core, ANCHOR.coreRound)
        ? 1
        : 0;
    }
  }
  const i = Math.round(u / STEP);
  const j = Math.round(v / STEP);
  if (inSquare(u - i * STEP, v - j * STEP, DOT_R, DOT_R * DOT_ROUND)) {
    const lit = LIT.get(j * 1000 + i);
    if (lit !== undefined) return lit ? 1 : UNLIT;
  }
  return 0;
}

/** Inside a rounded square of half-width `half` and corner radius `r`. */
function inSquare(dx: number, dy: number, half: number, r: number): boolean {
  const qx = Math.abs(dx) - (half - r);
  const qy = Math.abs(dy) - (half - r);
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
      Math.min(Math.max(qx, qy), 0) <=
    r
  );
}
