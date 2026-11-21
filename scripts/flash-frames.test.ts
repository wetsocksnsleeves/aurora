import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseRois } from "./flash-frames";

const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 &&
  spawnSync("ffprobe", ["-version"]).status === 0;

describe("parseRois", () => {
  it("parses boxes separated by semicolons", () => {
    expect(parseRois("0.1,0.2,0.3,0.4; 0.5,0.5,0.1,0.1;")).toEqual([
      { x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      { x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
    ]);
  });

  it("rejects boxes outside the frame or empty", () => {
    expect(() => parseRois("0.1,0.1,2,0.1")).toThrow(/bad ROI/);
    expect(() => parseRois("0.1,0.1,0,0.1")).toThrow(/bad ROI/);
    expect(() => parseRois("a,b,c,d")).toThrow(/bad ROI/);
  });
});

describe.skipIf(!hasFfmpeg)("flash-frames CLI", () => {
  it("measures a screen lit 3 frames late in a 240 fps video", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lightshow-flash-"));
    try {
      const video = path.join(dir, "synth.mp4");
      // Two white boxes flashing at 1 Hz; the right one 12.5 ms (3 frames) late.
      const box = (x: number, start: number) =>
        `drawbox=x=${x}:y=60:w=100:h=120:color=white:t=fill:enable='gte(t,${start})*lt(mod(t-${start},1),0.5)'`;
      execFileSync("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=black:s=480x240:r=240:d=2.2",
        "-vf",
        `${box(40, 0.5)},${box(300, 0.5125)}`,
        "-pix_fmt",
        "yuv420p",
        video,
      ]);
      const out = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          path.join(import.meta.dirname, "flash-frames.ts"),
          video,
          "--rois",
          "0.1,0.3,0.15,0.4;0.65,0.3,0.15,0.4",
          "--names",
          "left,right",
        ],
        { encoding: "utf8" },
      );
      expect(out).toContain("flashes found: 2");
      expect(out).toContain("right: seen in 2/2, median 3 (12.5 ms)");
      expect(out).toContain("left: seen in 2/2, median 0 (0.0 ms)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
