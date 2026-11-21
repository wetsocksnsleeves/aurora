import { describe, expect, it } from "vitest";
import { boxChanged, crowdBox, fitToCrowd } from "./crowd";

describe("crowdBox and fitToCrowd", () => {
  it("maps the crowd's extent onto the whole show", () => {
    const seats = [
      { x: 0.45, y: 0.05 },
      { x: 0.55, y: 0.05 },
      { x: 0.45, y: 0.1 },
      { x: 0.55, y: 0.1 },
    ];
    const box = crowdBox(seats)!;
    const left = fitToCrowd({ x: 0.45, y: 0.075 }, box);
    const right = fitToCrowd({ x: 0.55, y: 0.075 }, box);
    expect(left.x).toBeCloseTo(0.0536, 3);
    expect(right.x).toBeCloseTo(0.9464, 3);
    expect(left.y).toBeCloseTo(0.5, 6);
  });

  it("puts a lone phone in the middle", () => {
    const box = crowdBox([{ x: 0.3, y: 0.2 }]);
    expect(fitToCrowd({ x: 0.3, y: 0.2 }, box)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("leaves seats alone with no crowd", () => {
    expect(crowdBox([])).toBeNull();
    expect(fitToCrowd({ x: 0.3, y: 0.2 }, null)).toEqual({ x: 0.3, y: 0.2 });
  });

  it("ignores a stray seat in a big crowd", () => {
    const crowd = Array.from({ length: 50 }, (_, i) => ({
      x: 0.4 + (i % 10) * 0.02,
      y: 0.1 + Math.floor(i / 10) * 0.02,
    }));
    const box = crowdBox([...crowd, { x: 1, y: 1 }])!;
    expect(box.maxX).toBeLessThan(0.62);
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
