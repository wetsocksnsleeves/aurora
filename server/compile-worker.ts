// Worker thread entry for the schedule compiler (SPEC 3.3). Started by
// server/compile-pool.ts. Runs from source under tsx in dev and tests, and as
// dist/compile-worker.mjs in the production build.

import { parentPort } from "node:worker_threads";
import { compileSchedule } from "../lib/compile";
import type { CompileRequest, CompileResponse } from "./compile-pool";

if (!parentPort) throw new Error("compile-worker must run in a worker thread");
const port = parentPort;

port.on("message", (req: CompileRequest) => {
  let res: CompileResponse;
  try {
    res = { id: req.id, schedule: compileSchedule(req.show, req.seat) };
  } catch (err) {
    res = {
      id: req.id,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  port.postMessage(res);
});
