import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build, type BuildOptions } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { compileSchedule } from "../lib/compile";
import type { Show } from "../lib/types";
import { closeCompilePool, compileInWorker } from "./compile-pool";
import type { ScheduleComputer } from "./ws";

// server/ws.ts can pass compileInWorker as its `computeSchedule`.
const asComputer: ScheduleComputer = compileInWorker;
void asComputer;

const show: Show = {
  id: "s1",
  name: "worker test",
  venue: {
    shapes: [
      {
        id: "floor",
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
      },
    ],
  },
  audio: { fileId: "a1", durationMs: 5000 },
  clips: [
    {
      id: "c1",
      layer: 0,
      startMs: 0,
      endMs: 2000,
      color: "#ff0000",
      fadeInMs: 0,
      fadeOutMs: 0,
      shape: { kind: "fill" },
    },
    {
      id: "c2",
      layer: 1,
      startMs: 1000,
      endMs: 3000,
      color: "#00ff00",
      fadeInMs: 0,
      fadeOutMs: 0,
      shape: {
        kind: "polygon",
        points: [
          { x: 0, y: 0 },
          { x: 0.5, y: 0 },
          { x: 0.5, y: 1 },
          { x: 0, y: 1 },
        ],
      },
    },
  ],
  createdAt: "2026-11-20T00:00:00.000Z",
  updatedAt: "2026-11-20T00:00:00.000Z",
};

describe("compileInWorker", () => {
  afterAll(() => closeCompilePool());

  it("returns the same schedule as compileSchedule on the main thread", async () => {
    const seat = { x: 0.25, y: 0.5 };
    const schedule = await compileInWorker(show, seat);
    expect(schedule).toEqual(compileSchedule(show, seat));
    expect(schedule.events.map((e) => e.color)).toEqual([
      "#ff0000",
      "#00ff00",
      "#000000",
    ]);
  });

  it("handles many concurrent compiles", async () => {
    const seats = Array.from({ length: 50 }, (_, i) => ({
      x: (i % 10) / 10,
      y: Math.floor(i / 10) / 5,
    }));
    const results = await Promise.all(
      seats.map((seat) => compileInWorker(show, seat)),
    );
    results.forEach((schedule, i) => {
      expect(schedule).toEqual(compileSchedule(show, seats[i]));
    });
  });

  it("rejects when the compile throws, and keeps working after", async () => {
    const broken = { ...show, clips: null } as unknown as Show;
    await expect(compileInWorker(broken, { x: 0.5, y: 0.5 })).rejects.toThrow();
    const ok = await compileInWorker(show, { x: 0.75, y: 0.5 });
    expect(ok).toEqual(compileSchedule(show, { x: 0.75, y: 0.5 }));
  });
});

describe("compileInWorker in the production bundle", () => {
  it("finds dist/compile-worker.mjs next to the bundled server", async () => {
    // Mirrors `build:server` in package.json: the server and the worker are
    // bundled separately into the same directory.
    const serverDir = path.dirname(fileURLToPath(import.meta.url));
    const outDir = await mkdtemp(path.join(tmpdir(), "lightshow-compile-"));
    const common: BuildOptions = {
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      packages: "external",
      logLevel: "silent",
    };
    try {
      await build({
        ...common,
        stdin: {
          contents: `
            import { compileInWorker, closeCompilePool } from "./compile-pool";
            const show = ${JSON.stringify(show)};
            const schedule = await compileInWorker(show, { x: 0.25, y: 0.5 });
            console.log(JSON.stringify(schedule));
            await closeCompilePool();
          `,
          resolveDir: serverDir,
          sourcefile: "server.ts",
          loader: "ts",
        },
        outfile: path.join(outDir, "server.mjs"),
      });
      await build({
        ...common,
        entryPoints: [path.join(serverDir, "compile-worker.ts")],
        outfile: path.join(outDir, "compile-worker.mjs"),
      });

      const { stdout } = await promisify(execFile)(process.execPath, [
        path.join(outDir, "server.mjs"),
      ]);
      expect(JSON.parse(stdout)).toEqual(
        compileSchedule(show, { x: 0.25, y: 0.5 }),
      );
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
