// Runs the schedule compiler on worker threads so a burst of Ready taps does
// not block the event loop and delay `sync` replies (SPEC 3.3).

import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import type { CompiledSchedule } from "../lib/compile";
import type { Point, Show } from "../lib/types";

export type CompileRequest = { id: number; show: Show; seat: Point };
export type CompileResponse =
  { id: number; schedule: CompiledSchedule } | { id: number; error: string };

type Job = {
  resolve: (s: CompiledSchedule) => void;
  reject: (e: Error) => void;
};
type PoolWorker = { worker: Worker; jobs: Map<number, Job> };

// From source (tsx in dev, Vitest in tests) this module is a .ts file and the
// worker runs compile-worker.ts with the tsx loader. In the production build
// this module is bundled into dist/server.mjs and the worker is the separately
// bundled dist/compile-worker.mjs next to it (see `build:server`).
const fromSource = import.meta.url.endsWith(".ts");
const workerUrl = new URL(
  fromSource ? "./compile-worker.ts" : "./compile-worker.mjs",
  import.meta.url,
);
const workerExecArgv = fromSource ? ["--import", "tsx"] : [];

const poolSize = Math.max(
  1,
  Number(process.env.COMPILE_WORKERS) ||
    Math.min(4, availableParallelism() - 1),
);

const workers: PoolWorker[] = [];
let nextId = 1;

/**
 * Compiles a participant's schedule on a worker thread. Resolves with the same
 * result as `compileSchedule(show, seat)`.
 */
export function compileInWorker(
  show: Show,
  seat: Point,
): Promise<CompiledSchedule> {
  const pw = pickWorker();
  const id = nextId++;
  return new Promise<CompiledSchedule>((resolve, reject) => {
    pw.jobs.set(id, { resolve, reject });
    // Keep the process alive only while a compile is in flight.
    pw.worker.ref();
    const req: CompileRequest = { id, show, seat };
    pw.worker.postMessage(req);
  });
}

/** Terminates all compile workers. Pending compiles reject. */
export async function closeCompilePool(): Promise<void> {
  const all = workers.splice(0);
  await Promise.all(
    all.map(async (pw) => {
      failAll(pw, new Error("compile pool closed"));
      await pw.worker.terminate();
    }),
  );
}

function pickWorker(): PoolWorker {
  if (workers.length < poolSize) {
    const idle = workers.find((w) => w.jobs.size === 0);
    if (idle) return idle;
    return startWorker();
  }
  return workers.reduce((a, b) => (b.jobs.size < a.jobs.size ? b : a));
}

function startWorker(): PoolWorker {
  const worker = new Worker(workerUrl, { execArgv: workerExecArgv });
  const pw: PoolWorker = { worker, jobs: new Map() };
  workers.push(pw);
  worker.unref();

  worker.on("message", (res: CompileResponse) => {
    const job = pw.jobs.get(res.id);
    if (!job) return;
    pw.jobs.delete(res.id);
    if (pw.jobs.size === 0) worker.unref();
    if ("error" in res) job.reject(new Error(res.error));
    else job.resolve(res.schedule);
  });
  worker.on("error", (err) => {
    remove(pw);
    failAll(pw, err);
  });
  worker.on("exit", (code) => {
    remove(pw);
    failAll(pw, new Error(`compile worker exited with code ${code}`));
  });
  return pw;
}

function remove(pw: PoolWorker): void {
  const i = workers.indexOf(pw);
  if (i >= 0) workers.splice(i, 1);
}

function failAll(pw: PoolWorker, err: Error): void {
  for (const job of pw.jobs.values()) job.reject(err);
  pw.jobs.clear();
}
