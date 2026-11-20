/**
 * Count frames between phones in a slow-motion video of the device test
 * show (docs/device-test.md). Needs `ffmpeg` and `ffprobe` on the PATH.
 *
 *   npx tsx scripts/flash-frames.ts <video> --rois "<x,y,w,h>;<x,y,w,h>;..."
 *     [--names "Pixel 8,iPhone 13,..."] [--from <s>] [--to <s>] [--fps <n>]
 *
 * Each ROI is a box on one phone's screen, as fractions of the frame
 * (0..1, from the top left). Pick boxes in the middle of each screen, all
 * at the same height in the picture, so the camera's rolling shutter reads
 * them at the same moment. The script prints, for every flash, how many
 * frames each phone lit up after the first phone, then a per-phone summary
 * and table rows to paste into docs/device-test.md.
 */

import { execFileSync, spawn } from "node:child_process";
import {
  framesToMs,
  groupFlashes,
  risingEdges,
  summarisePhones,
} from "../lib/flash-analysis";

type Roi = { x: number; y: number; w: number; h: number };

type Args = {
  video: string;
  rois: Roi[];
  names: string[];
  from: number | null;
  to: number | null;
  fps: number | null;
};

/** Decode width: enough pixels per screen, small enough to be quick. */
const DECODE_WIDTH = 480;

function usage(message?: string): never {
  if (message) console.error(`error: ${message}\n`);
  console.error(
    'usage: npx tsx scripts/flash-frames.ts <video> --rois "x,y,w,h;x,y,w,h" [--names "A,B"] [--from s] [--to s] [--fps n]',
  );
  process.exit(2);
}

export function parseRois(text: string): Roi[] {
  return text
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const [x, y, w, h] = part.split(",").map(Number);
      const roi = { x: x!, y: y!, w: w!, h: h! };
      const ok =
        [roi.x, roi.y, roi.w, roi.h].every(
          (v) => Number.isFinite(v) && v >= 0 && v <= 1,
        ) &&
        roi.w > 0 &&
        roi.h > 0;
      if (!ok) throw new Error(`bad ROI "${part}": want x,y,w,h in 0..1`);
      return roi;
    });
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    video: "",
    rois: [],
    names: [],
    from: null,
    to: null,
    fps: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i] ?? usage(`${a} needs a value`);
    if (a === "--rois") args.rois = parseRois(next());
    else if (a === "--names")
      args.names = next()
        .split(",")
        .map((s) => s.trim());
    else if (a === "--from") args.from = Number(next());
    else if (a === "--to") args.to = Number(next());
    else if (a === "--fps") args.fps = Number(next());
    else if (a === "--help" || a === "-h") usage();
    else if (!args.video) args.video = a;
    else usage(`unexpected argument ${a}`);
  }
  if (!args.video) usage("no video given");
  if (args.rois.length < 2) usage("give at least two --rois");
  return args;
}

type Probe = { width: number; height: number; fps: number };

function probe(video: string): Probe {
  const out = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,avg_frame_rate,r_frame_rate",
      "-of",
      "json",
      video,
    ],
    { encoding: "utf8" },
  );
  const stream = (
    JSON.parse(out) as {
      streams: {
        width: number;
        height: number;
        avg_frame_rate: string;
        r_frame_rate: string;
      }[];
    }
  ).streams[0];
  if (!stream) throw new Error("no video stream");
  const rate = (s: string) => {
    const [n, d] = s.split("/").map(Number);
    return d ? n! / d : n!;
  };
  return {
    width: stream.width,
    height: stream.height,
    fps: rate(stream.r_frame_rate) || rate(stream.avg_frame_rate),
  };
}

/** Mean grey level of each ROI in every frame, decoded by ffmpeg. */
async function roiBrightness(
  args: Args,
  size: { width: number; height: number },
): Promise<number[][]> {
  const { width, height } = size;
  const boxes = args.rois.map((r) => ({
    x0: Math.floor(r.x * width),
    y0: Math.floor(r.y * height),
    x1: Math.max(Math.floor(r.x * width) + 1, Math.floor((r.x + r.w) * width)),
    y1: Math.max(
      Math.floor(r.y * height) + 1,
      Math.floor((r.y + r.h) * height),
    ),
  }));
  const input = [
    ...(args.from !== null ? ["-ss", String(args.from)] : []),
    ...(args.to !== null ? ["-to", String(args.to)] : []),
    "-i",
    args.video,
  ];
  // Every decoded frame, no frame-rate conversion (-fps_mode passthrough).
  const ff = spawn(
    "ffmpeg",
    [
      "-v",
      "error",
      ...input,
      "-an",
      "-fps_mode",
      "passthrough",
      "-vf",
      `scale=${width}:${height},format=gray`,
      "-f",
      "rawvideo",
      "-",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const frameBytes = width * height;
  const series: number[][] = args.rois.map(() => []);
  let pending = Buffer.alloc(0);
  for await (const chunk of ff.stdout as AsyncIterable<Buffer>) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= frameBytes) {
      const frame = pending.subarray(0, frameBytes);
      boxes.forEach((b, i) => {
        let sum = 0;
        for (let y = b.y0; y < b.y1; y++) {
          const row = y * width;
          for (let x = b.x0; x < b.x1; x++) sum += frame[row + x]!;
        }
        series[i]!.push(sum / ((b.x1 - b.x0) * (b.y1 - b.y0)));
      });
      pending = pending.subarray(frameBytes);
    }
  }
  const code = await new Promise<number | null>((resolve) =>
    ff.on("close", resolve),
  );
  if (code !== 0) throw new Error(`ffmpeg exited with ${code}`);
  return series;
}

function fmt(frames: number | null, fps: number): string {
  if (frames === null) return "–";
  return `${frames} (${framesToMs(frames, fps).toFixed(1)} ms)`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const info = probe(args.video);
  const fps = args.fps ?? info.fps;
  const scale = DECODE_WIDTH / info.width;
  const size = {
    width: DECODE_WIDTH,
    height: Math.max(2, Math.round((info.height * scale) / 2) * 2),
  };
  const names = args.rois.map((_, i) => args.names[i] || `phone ${i + 1}`);
  console.log(
    `${args.video}: ${info.width}x${info.height} at ${fps.toFixed(2)} fps (1 frame = ${(1000 / fps).toFixed(2)} ms)`,
  );
  if (fps < 200) {
    console.log(
      "warning: under 200 fps. Check the file is the 240 fps original, not a 30 fps export.",
    );
  }

  const series = await roiBrightness(args, size);
  const edges = series.map((s) => risingEdges(s));
  // Flashes are 1 s apart; edges within half a period are one flash.
  const rows = groupFlashes(edges, Math.round(fps / 2));

  console.log(`\nframes analysed: ${series[0]?.length ?? 0}`);
  console.log(`flashes found: ${rows.length}\n`);
  console.log(
    ["flash", "t (s)", ...names, "spread"].join("\t") +
      "\n" +
      rows
        .map((r, i) =>
          [
            String(i + 1),
            (r.firstFrame / fps + (args.from ?? 0)).toFixed(3),
            ...r.lateFrames.map((f) => fmt(f, fps)),
            fmt(r.spreadFrames, fps),
          ].join("\t"),
        )
        .join("\n"),
  );

  const summary = summarisePhones(rows, names.length);
  const spreads = rows.map((r) => r.spreadFrames);
  console.log("\nper phone (frames late vs the first phone in each flash):");
  summary.forEach((s, i) => {
    console.log(
      `  ${names[i]}: seen in ${s.flashes}/${rows.length}, median ${fmt(s.medianLateFrames, fps)}, max ${fmt(s.maxLateFrames, fps)}, last in ${s.lastCount}`,
    );
  });
  if (spreads.length) {
    const sorted = [...spreads].sort((a, b) => a - b);
    console.log(
      `\nspread per flash: median ${fmt(sorted[Math.floor(sorted.length / 2)]!, fps)}, max ${fmt(sorted.at(-1)!, fps)}`,
    );
  }
  console.log(
    "\nrows for docs/device-test.md (fill in device, OS, browser, network):",
  );
  summary.forEach((s, i) => {
    const ms =
      s.medianLateFrames === null
        ? "–"
        : framesToMs(s.medianLateFrames, fps).toFixed(1);
    console.log(
      `| ${names[i]} |  |  |  | ${s.medianLateFrames ?? "–"} (max ${s.maxLateFrames ?? "–"}) | ${ms} |  |`,
    );
  });
}

// Run only as a CLI, so tests can import parseRois.
if (process.argv[1] && /flash-frames\.ts$/.test(process.argv[1])) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
