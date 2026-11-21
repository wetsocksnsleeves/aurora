/**
 * Builds a short mixtape show from several songs. Each song gets its own
 * light show generated from the whole track (as `scripts/light-show.ts`
 * does), then the script keeps the most intense stretch of each, cut on bar
 * lines, and joins them in order with a quick fade-out between songs.
 *
 *   npx tsx scripts/mixtape.ts a.mp3 b.mp3 c.mp3 \
 *     --audio public/builtin-audio/mixtape.mp3 --json lib/mixtape.json
 *
 * Each song gets an equal share of `--seconds`. Its stretch starts
 * `--lead-bars` bars before a drop, so the build-up plays into it, and of
 * the drops that fit, the one with the loudest stretch wins. Songs are
 * levelled to the quietest stretch. Needs `ffmpeg` on PATH.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { analyseAudio, type AudioAnalysis } from "@/lib/audio-analysis";
import { compileSchedule } from "@/lib/compile";
import { barIntensity, generateLightShow } from "@/lib/light-show-generator";
import { TEST_VENUE } from "@/lib/test-show";
import type { Clip, ClipShape, Show } from "@/lib/types";
import { parseShowPatch } from "@/server/show-validation";

/**
 * Same rate as "Create from music" in the editor, which decodes at 48 kHz
 * and halves it (`createFromMusic` in components/room/music.ts). The tempo
 * estimate depends on it, so this keeps the mixtape matching the app.
 */
const ANALYSIS_RATE = 24_000;
const OUTPUT_RATE = 48_000;

const HELP = `Usage: npx tsx scripts/mixtape.ts <audio file>... --audio OUT.mp3 --json OUT.json

  --seconds N     total length (default 120)
  --fade-ms N     fade-out at the end of each song (default 300)
  --lead-bars N   bars of build-up before the drop (default 4)
  --help`;

type Section = {
  title: string;
  /** Where the stretch sits in the mixtape. */
  startMs: number;
  endMs: number;
  /** Where it was cut from in the song. */
  sourceStartMs: number;
  bpm: number;
};

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      audio: { type: "string" },
      json: { type: "string" },
      seconds: { type: "string", default: "120" },
      "fade-ms": { type: "string", default: "300" },
      "lead-bars": { type: "string", default: "4" },
      help: { type: "boolean" },
    },
  });
  if (
    values.help ||
    positionals.length === 0 ||
    !values.audio ||
    !values.json
  ) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }
  const totalMs = Number(values.seconds) * 1000;
  const fadeMs = Number(values["fade-ms"]);
  const leadBars = Number(values["lead-bars"]);
  const shareMs = totalMs / positionals.length;

  const clips: Clip[] = [];
  const sections: Section[] = [];
  const cuts: { file: string; fromMs: number; toMs: number }[] = [];
  let atMs = 0;

  positionals.forEach((file, i) => {
    const analysis = analyseAudio(decode(file), ANALYSIS_RATE);
    const songClips = generateLightShow(analysis, TEST_VENUE);
    const { fromMs, toMs } = pickStretch(analysis, shareMs, leadBars);
    const title = path.basename(file, path.extname(file));
    console.log(
      `${title}: ${analysis.bpm.toFixed(1)} BPM, ` +
        `${fmt(fromMs)}–${fmt(toMs)} of ${fmt(analysis.durationMs)}`,
    );
    for (const clip of songClips) {
      const cut = cutClip(clip, fromMs, toMs, atMs, fadeMs);
      if (cut) clips.push({ ...cut, id: `s${i}-${clip.id}` });
    }
    sections.push({
      title,
      startMs: Math.round(atMs),
      endMs: Math.round(atMs + toMs - fromMs),
      sourceStartMs: Math.round(fromMs),
      bpm: Math.round(analysis.bpm * 10) / 10,
    });
    cuts.push({ file, fromMs, toMs });
    atMs += toMs - fromMs;
  });

  clips.sort((a, b) => a.startMs - b.startMs || a.layer - b.layer);
  const durationMs = Math.round(atMs);
  renderAudio(cuts, fadeMs, values.audio);

  const patch = parseShowPatch({
    name: "mixtape",
    venue: TEST_VENUE,
    audio: { fileId: "", durationMs },
    clips,
  });
  if (!patch.ok) throw new Error(`mixtape show is invalid: ${patch.error}`);
  const draft: Show = {
    id: "draft",
    name: "mixtape",
    venue: TEST_VENUE,
    audio: { fileId: "", durationMs },
    clips,
    createdAt: "",
    updatedAt: "",
  };
  const events = compileSchedule(draft, { x: 0.5, y: 0.5 }).events.length;
  console.log(
    `${fmt(durationMs)}, ${clips.length} clips, ${events} events at the centre seat`,
  );

  fs.writeFileSync(
    values.json,
    JSON.stringify({ durationMs, sections, clips }, null, 2) + "\n",
  );
  console.log(`wrote ${values.audio} and ${values.json}`);
}

/**
 * The stretch of at most `maxMs` to keep, on bar lines. Candidates start
 * `leadBars` before each drop; the loudest wins. Without drops, the
 * loudest stretch anywhere.
 */
function pickStretch(
  analysis: AudioAnalysis,
  maxMs: number,
  leadBars: number,
): { fromMs: number; toMs: number } {
  const bars = analysis.bars.filter((b) => b.startMs >= 0);
  const intensity = bars.map(barIntensity);
  const barMs = 4 * analysis.beatMs;
  const n = Math.min(bars.length, Math.floor(maxMs / barMs));
  const fits = (s: number) => s >= 0 && s + n <= bars.length;
  const mean = (s: number) =>
    intensity.slice(s, s + n).reduce((a, b) => a + b, 0) / n;

  const fromDrops = drops(intensity)
    .map((d) => d - leadBars)
    .filter(fits);
  const candidates = fromDrops.length
    ? fromDrops
    : bars.map((_, s) => s).filter(fits);
  const best = candidates.reduce((a, b) => (mean(b) > mean(a) ? b : a));
  return {
    fromMs: bars[best]!.startMs,
    toMs: Math.min(bars[best + n - 1]!.endMs, analysis.durationMs),
  };
}

/** Bars where the track jumps to full after a quieter stretch (as the generator finds them). */
function drops(intensity: number[]): number[] {
  return intensity.flatMap((v, i) => {
    if (i === 0 || v < 0.85) return [];
    const before = intensity.slice(Math.max(0, i - 2), i);
    const mean = before.reduce((s, x) => s + x, 0) / before.length;
    return mean < 0.65 ? [i] : [];
  });
}

/**
 * The part of `clip` inside [fromMs, toMs), moved to start at `atMs`.
 * Moving shapes keep their position at the cut. A clip cut at the end
 * fades out over `fadeMs`, like the audio.
 */
function cutClip(
  clip: Clip,
  fromMs: number,
  toMs: number,
  atMs: number,
  fadeMs: number,
): Clip | null {
  const start = Math.max(clip.startMs, fromMs);
  const end = Math.min(clip.endMs, toMs);
  if (end - start < 20) return null;
  const len = clip.endMs - clip.startMs;
  const fa = (start - clip.startMs) / len;
  const fb = (end - clip.startMs) / len;
  const newLen = end - start;
  const fadeOutMs =
    end < clip.endMs
      ? Math.min(fadeMs, clip.fadeOutMs || fadeMs)
      : clip.fadeOutMs;
  const shift = atMs - fromMs;
  return {
    ...clip,
    startMs: Math.round(start + shift),
    endMs: Math.round(end + shift),
    fadeInMs: Math.min(
      newLen,
      Math.max(0, clip.fadeInMs - (start - clip.startMs)),
    ),
    fadeOutMs: Math.min(newLen, fadeOutMs),
    shape: cutShape(clip.shape, fa, fb),
  };
}

/** The shape over fractions [fa, fb] of its clip. */
function cutShape(shape: ClipShape, fa: number, fb: number): ClipShape {
  if (fa === 0 && fb === 1) return shape;
  if (shape.kind === "polygon" && shape.moveTo) {
    const { x, y } = shape.moveTo;
    return {
      kind: "polygon",
      points: shape.points.map((p) => ({ x: p.x + x * fa, y: p.y + y * fa })),
      moveTo: { x: x * (fb - fa), y: y * (fb - fa) },
    };
  }
  if (shape.kind === "pattern") {
    const span = shape.to - shape.from;
    return {
      ...shape,
      from: shape.from + span * fa,
      to: shape.from + span * fb,
    };
  }
  return shape;
}

/** Cut, level, fade and join the stretches into one mp3. */
function renderAudio(
  cuts: { file: string; fromMs: number; toMs: number }[],
  fadeMs: number,
  out: string,
): void {
  const trim = (c: (typeof cuts)[number]) =>
    `atrim=start=${c.fromMs / 1000}:end=${c.toMs / 1000},asetpts=PTS-STARTPTS`;
  const loudness = cuts.map((c) => integratedLoudness(c.file, trim(c)));
  // Turn every stretch down to the quietest, so nothing needs a limiter.
  const target = Math.min(...loudness);
  const chains = cuts.map((c, i) => {
    const sec = (c.toMs - c.fromMs) / 1000;
    const fade = fadeMs / 1000;
    return (
      `[${i}:a]${trim(c)},aresample=${OUTPUT_RATE},` +
      `volume=${(target - loudness[i]!).toFixed(2)}dB,` +
      `afade=t=in:d=0.005,afade=t=out:st=${(sec - fade).toFixed(3)}:d=${fade}[a${i}]`
    );
  });
  const graph =
    chains.join(";") +
    `;${cuts.map((_, i) => `[a${i}]`).join("")}concat=n=${cuts.length}:v=0:a=1[out]`;
  run([
    "-y",
    ...cuts.flatMap((c) => ["-i", c.file]),
    "-filter_complex",
    graph,
    "-map",
    "[out]",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "192k",
    out,
  ]);
  loudness.forEach((l, i) =>
    console.log(`  ${path.basename(cuts[i]!.file)}: ${l} LUFS -> ${target}`),
  );
}

function integratedLoudness(file: string, filter: string): number {
  const err = run([
    "-nostats",
    "-i",
    file,
    "-af",
    `${filter},ebur128`,
    "-f",
    "null",
    "-",
  ]);
  const m = [...err.matchAll(/^\s+I:\s+(-?[\d.]+) LUFS/gm)].at(-1);
  if (!m) throw new Error(`no loudness reading for ${file}`);
  return Number(m[1]);
}

/** Run ffmpeg; returns stderr. */
function run(args: string[]): string {
  const r = spawnSync("ffmpeg", ["-hide_banner", ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  if (r.status !== 0) throw new Error(`ffmpeg failed:\n${r.stderr}`);
  return r.stderr;
}

/** Mono float PCM at ANALYSIS_RATE. */
function decode(file: string): Float32Array {
  const r = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      file,
      "-ac",
      "1",
      "-ar",
      String(ANALYSIS_RATE),
      "-f",
      "f32le",
      "-",
    ],
    { maxBuffer: 1 << 30 },
  );
  if (r.status !== 0) throw new Error(`ffmpeg could not decode ${file}`);
  const buf = r.stdout;
  // Copy so the floats are aligned regardless of the Buffer's offset.
  const aligned = new Uint8Array(buf.byteLength - (buf.byteLength % 4));
  aligned.set(buf.subarray(0, aligned.byteLength));
  return new Float32Array(aligned.buffer);
}

function fmt(ms: number): string {
  const s = ms / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
}

main();
