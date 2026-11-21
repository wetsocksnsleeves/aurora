import { describe, expect, it } from "vitest";
import { colorAt, compileSchedule, showDurationMs } from "./compile";
import {
  TANDA_COLOR,
  TANDA_CROSS_COUNT,
  TANDA_CROSS_MS,
  TANDA_DURATION_MS,
  TANDA_LEFT,
  TANDA_MAX_TOP,
  TANDA_PIXEL_W,
  TANDA_SHOW,
  TANDA_TEXT_H,
  TANDA_TEXT_W,
  tandaBitmap,
  tandaCrossStartMs,
  tandaTopAt,
} from "./tanda-show";

const BLACK = "#000000";
const bitmap = tandaBitmap();
const pixelH = TANDA_TEXT_H / bitmap.length;

describe("TANDA_SHOW", () => {
  it("spells TANDA in a 5x7 font", () => {
    expect(bitmap).toEqual([
      "#####..###..#...#.####...###.",
      "..#...#...#.#...#.#...#.#...#",
      "..#...#...#.##..#.#...#.#...#",
      "..#...#####.#.#.#.#...#.#####",
      "..#...#...#.#..##.#...#.#...#",
      "..#...#...#.#...#.#...#.#...#",
      "..#...#...#.#...#.####..#...#",
    ]);
  });

  it("fits inside the venue square, centred", () => {
    expect(TANDA_LEFT).toBeGreaterThan(0);
    expect(TANDA_LEFT + TANDA_TEXT_W).toBeCloseTo(1 - TANDA_LEFT, 9);
    expect(TANDA_MAX_TOP + TANDA_TEXT_H).toBeCloseTo(1, 9);
  });

  it("runs twelve crossings after a one-second lead-in", () => {
    expect(showDurationMs(TANDA_SHOW)).toBe(TANDA_DURATION_MS);
    expect(TANDA_DURATION_MS).toBe(31_000);
  });

  it("turns back at the top and bottom edges", () => {
    for (let i = 0; i < TANDA_CROSS_COUNT; i++) {
      const start = tandaCrossStartMs(i);
      const atStart = i % 2 === 0 ? 0 : TANDA_MAX_TOP;
      expect(tandaTopAt(start)).toBeCloseTo(atStart, 9);
      expect(tandaTopAt(start + TANDA_CROSS_MS - 1e-6)).toBeCloseTo(
        TANDA_MAX_TOP - atStart,
        6,
      );
    }
    expect(tandaTopAt(0)).toBeNull();
    expect(tandaTopAt(TANDA_DURATION_MS)).toBeNull();
  });

  it("draws the bitmap at every pixel while going down and up", () => {
    for (const cross of [0, 1, TANDA_CROSS_COUNT - 1]) {
      for (const f of [0.1, 0.5, 0.9]) {
        const tMs = tandaCrossStartMs(cross) + f * TANDA_CROSS_MS;
        const top = tandaTopAt(tMs)!;
        bitmap.forEach((line, row) => {
          const y = top + (row + 0.5) * pixelH;
          [...line].forEach((px, col) => {
            const x = TANDA_LEFT + (col + 0.5) * TANDA_PIXEL_W;
            const want = px === "#" ? TANDA_COLOR : BLACK;
            expect(colorAt(TANDA_SHOW, { x, y }, tMs)).toBe(want);
          });
        });
      }
    }
  });

  it("is black during the lead-in and outside the text", () => {
    expect(colorAt(TANDA_SHOW, { x: 0.1, y: 0.05 }, 500)).toBe(BLACK);
    const mid = tandaCrossStartMs(0) + TANDA_CROSS_MS / 2;
    const top = tandaTopAt(mid)!;
    expect(colorAt(TANDA_SHOW, { x: 0.1, y: top - 0.05 }, mid)).toBe(BLACK);
    expect(
      colorAt(TANDA_SHOW, { x: 0.1, y: top + TANDA_TEXT_H + 0.05 }, mid),
    ).toBe(BLACK);
  });

  it("compiles to blue and black for a seat, starting black", () => {
    const { events, durationMs } = compileSchedule(TANDA_SHOW, {
      x: 0.5,
      y: 0.5,
    });
    expect(durationMs).toBe(TANDA_DURATION_MS);
    expect(events[0]).toEqual({ tMs: 0, color: BLACK });
    expect(new Set(events.map((e) => e.color))).toEqual(
      new Set([BLACK, TANDA_COLOR]),
    );
  });
});
