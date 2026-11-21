import { TEST_VENUE } from "./test-show";
import type { Clip, Show } from "./types";

/**
 * Built-in show: the word "TANDA" in blue, as wide as the venue square,
 * moves down and up and turns back each time it touches the top or bottom
 * edge. Each letter is drawn from a 5x7 pixel font; every block of lit
 * pixels is one polygon clip per crossing. No audio.
 */

/** `showId` to send in `host` for this show. */
export const TANDA_SHOW_ID = "tanda-bounce";

export const TANDA_TEXT = "TANDA";
export const TANDA_COLOR = "#0066ff";

/** 5x7 glyphs, `#` lit. Only the letters `TANDA_TEXT` needs. */
const FONT: Record<string, readonly string[]> = {
  T: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  A: [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  N: ["#...#", "#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#"],
  D: ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."],
};

const GLYPH_ROWS = 7;

/** The whole word as rows of `#` and `.`, one blank column between letters. */
export function tandaBitmap(text: string = TANDA_TEXT): string[] {
  const glyphs = [...text].map((ch) => {
    const glyph = FONT[ch];
    if (!glyph) throw new Error(`No glyph for "${ch}"`);
    return glyph;
  });
  return Array.from({ length: GLYPH_ROWS }, (_, row) =>
    glyphs.map((g) => g[row]).join("."),
  );
}

const COLUMNS = tandaBitmap()[0]!.length;

/** Width of one font pixel, as a share of the venue width. */
export const TANDA_PIXEL_W = 0.032;
/** Text width; centred, so the margin each side is `(1 - TANDA_TEXT_W) / 2`. */
export const TANDA_TEXT_W = COLUMNS * TANDA_PIXEL_W;
export const TANDA_LEFT = (1 - TANDA_TEXT_W) / 2;
/** Text height, as a share of the venue depth. */
export const TANDA_TEXT_H = 0.25;
const PIXEL_H = TANDA_TEXT_H / GLYPH_ROWS;
/** The text's top edge runs between 0 and this. */
export const TANDA_MAX_TOP = 1 - TANDA_TEXT_H;

/** Black before the text appears. */
export const TANDA_LEAD_IN_MS = 1_000;
/** Time to go from touching the top edge to touching the bottom edge. */
export const TANDA_CROSS_MS = 2_500;
/** Crossings: down, up, down, ... */
export const TANDA_CROSS_COUNT = 12;
export const TANDA_DURATION_MS =
  TANDA_LEAD_IN_MS + TANDA_CROSS_COUNT * TANDA_CROSS_MS;

/** Show time (ms) at which crossing `index` (0-based) starts. */
export function tandaCrossStartMs(index: number): number {
  return TANDA_LEAD_IN_MS + index * TANDA_CROSS_MS;
}

/**
 * Top edge of the text at show time `tMs`, or null outside the show. Even
 * crossings go down from 0, odd ones come back up from `TANDA_MAX_TOP`.
 */
export function tandaTopAt(tMs: number): number | null {
  const index = Math.floor((tMs - TANDA_LEAD_IN_MS) / TANDA_CROSS_MS);
  if (tMs < TANDA_LEAD_IN_MS || index >= TANDA_CROSS_COUNT) return null;
  const f = (tMs - tandaCrossStartMs(index)) / TANDA_CROSS_MS;
  return TANDA_MAX_TOP * (index % 2 === 0 ? f : 1 - f);
}

type Rect = { col: number; row: number; cols: number; rows: number };

/**
 * Lit pixels as rectangles: runs along each row, merged down while the row
 * below has a run with the same span. Fewer polygons than one per pixel.
 */
function bitmapRects(bitmap: string[]): Rect[] {
  const done: Rect[] = [];
  let open: Rect[] = [];
  bitmap.forEach((line, row) => {
    const next: Rect[] = [];
    for (const m of line.matchAll(/#+/g)) {
      const col = m.index;
      const cols = m[0].length;
      const above = open.find((r) => r.col === col && r.cols === cols);
      if (above) {
        above.rows++;
        next.push(above);
      } else {
        next.push({ col, row, cols, rows: 1 });
      }
    }
    done.push(...open.filter((r) => !next.includes(r)));
    open = next;
  });
  return [...done, ...open];
}

/**
 * One clip per rectangle per crossing. A clip starts where the text is at
 * the start of its crossing and moves the full `TANDA_MAX_TOP` down or up,
 * so consecutive crossings join without a jump.
 */
function tandaClips(): Clip[] {
  const rects = bitmapRects(tandaBitmap());
  const clips: Clip[] = [];
  for (let cross = 0; cross < TANDA_CROSS_COUNT; cross++) {
    const down = cross % 2 === 0;
    const startTop = down ? 0 : TANDA_MAX_TOP;
    const moveTo = { x: 0, y: down ? TANDA_MAX_TOP : -TANDA_MAX_TOP };
    const startMs = tandaCrossStartMs(cross);
    rects.forEach((r, i) => {
      const left = TANDA_LEFT + r.col * TANDA_PIXEL_W;
      const right = left + r.cols * TANDA_PIXEL_W;
      const top = startTop + r.row * PIXEL_H;
      const bottom = top + r.rows * PIXEL_H;
      clips.push({
        id: `cross-${cross + 1}-rect-${i + 1}`,
        layer: 0,
        startMs,
        endMs: startMs + TANDA_CROSS_MS,
        color: TANDA_COLOR,
        fadeInMs: 0,
        fadeOutMs: 0,
        label: TANDA_TEXT,
        shape: {
          kind: "polygon",
          points: [
            { x: left, y: top },
            { x: right, y: top },
            { x: right, y: bottom },
            { x: left, y: bottom },
          ],
          moveTo,
        },
      });
    });
  }
  return clips;
}

export const TANDA_SHOW: Show = {
  id: TANDA_SHOW_ID,
  name: "TANDA bounce",
  venue: TEST_VENUE,
  audio: { fileId: "", durationMs: TANDA_DURATION_MS },
  clips: tandaClips(),
  createdAt: "2026-11-21T00:00:00.000Z",
  updatedAt: "2026-11-21T00:00:00.000Z",
};
