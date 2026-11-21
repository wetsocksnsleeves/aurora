import { describe, expect, it } from "vitest";
import { boxChanged, crowdBox, fitToCrowd, minimumRoom } from "./crowd";

// The default positioning: a 200 m x 200 m box, so 1 m is 0.005.
const MIN = minimumRoom({ venueWidthM: 200, venueDepthM: 200 });
const m = (metres: number) => metres / 200;

describe("crowdBox and fitToCrowd", () => {
  it("keeps the screen at the top centre", () => {
    // A crowd from 2 m left to 30 m right of the screen, 5 to 40 m back.
    const seats = [
      { x: 0.5 - m(2), y: m(5) },
      { x: 0.5 + m(30), y: m(40) },
    ];
    const box = crowdBox(seats, MIN);
    expect(box.minY).toBe(0);
    expect((box.minX + box.maxX) / 2).toBeCloseTo(0.5, 9);
    // The furthest phone sits near the edge, the near-left one just left of centre.
    const right = fitToCrowd(seats[1]!, box);
    const left = fitToCrowd(seats[0]!, box);
    expect(right.x).toBeCloseTo(0.5 + 0.5 / 1.06, 6);
    expect(right.y).toBeCloseTo(1 / 1.06, 6);
    expect(left.x).toBeLessThan(0.5);
    expect(left.x).toBeGreaterThan(0.45);
  });

  it("shows a lone phone where it is, in the minimum room", () => {
    // 2 m left of the screen, 3 m back: a quarter across, half way down.
    const box = crowdBox([{ x: 0.5 - m(2), y: m(3) }], MIN);
    const seat = fitToCrowd({ x: 0.5 - m(2), y: m(3) }, box);
    expect(seat.x).toBeCloseTo(0.25, 6);
    expect(seat.y).toBeCloseTo(0.5, 6);
  });

  it("is the minimum room with no seats", () => {
    expect(crowdBox([], MIN)).toEqual({
      minX: 0.5 - m(4),
      minY: 0,
      maxX: 0.5 + m(4),
      maxY: m(6),
    });
    expect(fitToCrowd({ x: 0.3, y: 0.2 }, null)).toEqual({ x: 0.3, y: 0.2 });
  });

  it("ignores a stray seat in a big crowd", () => {
    const crowd = Array.from({ length: 50 }, (_, i) => ({
      x: 0.45 + (i % 10) * 0.01,
      y: 0.1 + Math.floor(i / 10) * 0.02,
    }));
    const box = crowdBox([...crowd, { x: 1, y: 1 }], MIN);
    expect(box.maxX).toBeLessThan(0.56);
    expect(box.maxY).toBeLessThan(0.2);
  });

  it("clamps a seat outside the box to its edge", () => {
    const box = { minX: 0, minY: 0, maxX: 0.5, maxY: 0.5 };
    expect(fitToCrowd({ x: 0.9, y: -0.1 }, box)).toEqual({ x: 1, y: 0 });
  });
});

describe("boxChanged", () => {
  const box = { minX: 0.4, minY: 0.05, maxX: 0.6, maxY: 0.15 };

  it("ignores tiny moves", () => {
    expect(boxChanged(box, { ...box, maxX: 0.6001 })).toBe(false);
  });

  it("notices an edge moving", () => {
    expect(boxChanged(box, { ...box, maxX: 0.65 })).toBe(true);
    expect(boxChanged(null, box)).toBe(true);
    expect(boxChanged(null, null)).toBe(false);
  });
});
