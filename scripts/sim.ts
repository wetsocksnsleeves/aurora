/**
 * Simulated-client harness (SPEC 6.1, 6.2): N participant clients with
 * injected clock and network faults play a show, and the run reports how far
 * each rendered event was from its true time. Exits 1 if p95 is over 50 ms.
 *
 *   npx tsx scripts/sim.ts                         # 500 clients, in-process server
 *   npx tsx scripts/sim.ts --clients 50 --waves 3  # quick run
 *   npx tsx scripts/sim.ts --bug no-slew           # self-test: must fail
 *   npx tsx scripts/sim.ts --url http://localhost:3000 --code ABC123
 *       # join a session on a running server; the dots show on its host page,
 *       # and the run waits for Start there
 *
 * Run with --help for every flag.
 */
import { parseArgs } from "node:util";
import { BUGS, type BugName } from "./sim/bugs";
import {
  DEFAULT_FAULTS,
  NO_FAULTS,
  parseRange,
  type FaultConfig,
  type LatencyModel,
} from "./sim/faults";
import {
  DEFAULT_SIM_OPTIONS,
  runSim,
  type SimReport,
  type SimTarget,
} from "./sim/run";
import { ms } from "./sim/stats";

const HELP = `Usage: npx tsx scripts/sim.ts [options]

Target
  --clients N          simulated participants (default 500)
  --url URL            use a running server (http://host:port) instead of an
                       in-process one
  --code CODE          join this session on --url and wait for Start on its
                       host page (the host map shows the simulated dots).
                       Without it, a test-show session is created and started.
  --waves N            in-process show length in 2 s test-wave periods (default 10)
  --test-wave          in-process: send the exact test wave instead of compiling
  --start-lead MS      in-process START_LEAD_MS (default 900)
  --seed N             random seed (default 1)

Faults (SPEC 6.1 defaults)
  --offset MS          clock offset range, +/- (default 10000)
  --drift PPM          clock drift range, +/- (default 50)
  --latency MIN-MAX    one-way latency (default 20-200)
  --latency-model M    path (default): one latency per client, drawn from
                       --latency, plus per-message jitter and spikes drawn
                       separately for each direction;
                       message: every message draws from --latency (stress)
  --asymmetry MS       fixed up-minus-down path difference per client, +/-
                       (default 20). No two-way sync can see it: half of it
                       shows up as clock error.
  --jitter MS          extra delay per message, +/- (default 30)
  --spike-rate R       fraction of messages delayed by --spike-ms (default 0.02)
  --spike-ms MS        spike size (default 500)
  --disconnect-rate R  fraction of clients that drop and reconnect mid-show
                       (default 0.01)
  --no-faults          zero every fault

Checks
  --max-p95 MS         fail above this p95 sync error (default 50)
  --join-timeout MS    wait this long for every client to reach standby
  --start-timeout MS   with --code: wait this long for Start (default 600000)
  --bug NAME           inject a ClockSync bug; the run should fail.
                       One of: ${BUGS.join(", ")}
  --json               print the report as JSON

Viewer
  --stream PORT        serve every client's seat and live colour as a
                       WebSocket on ws://localhost:PORT (format in
                       lib/crowd-stream.ts). After the report the process
                       keeps serving until Ctrl+C.
`;

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", short: "h" },
      clients: { type: "string" },
      url: { type: "string" },
      code: { type: "string" },
      waves: { type: "string" },
      "test-wave": { type: "boolean" },
      "start-lead": { type: "string" },
      seed: { type: "string" },
      offset: { type: "string" },
      drift: { type: "string" },
      latency: { type: "string" },
      "latency-model": { type: "string" },
      asymmetry: { type: "string" },
      jitter: { type: "string" },
      "spike-rate": { type: "string" },
      "spike-ms": { type: "string" },
      "disconnect-rate": { type: "string" },
      "no-faults": { type: "boolean" },
      "max-p95": { type: "string" },
      "join-timeout": { type: "string" },
      "start-timeout": { type: "string" },
      bug: { type: "string" },
      json: { type: "boolean" },
      stream: { type: "string" },
    },
    strict: true,
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const num = (name: string, raw: string | undefined, fallback: number) => {
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`--${name} must be a non-negative number, got "${raw}"`);
    }
    return value;
  };

  const base = values["no-faults"] ? NO_FAULTS : DEFAULT_FAULTS;
  const model = values["latency-model"] ?? base.latencyModel;
  if (model !== "path" && model !== "message") {
    throw new Error(`--latency-model must be path or message`);
  }
  const faults: FaultConfig = {
    offsetMs: num("offset", values.offset, base.offsetMs),
    driftPpm: num("drift", values.drift, base.driftPpm),
    latencyMs: values.latency ? parseRange(values.latency) : base.latencyMs,
    latencyModel: model as LatencyModel,
    asymmetryMs: num("asymmetry", values.asymmetry, base.asymmetryMs),
    jitterMs: num("jitter", values.jitter, base.jitterMs),
    spikeRate: num("spike-rate", values["spike-rate"], base.spikeRate),
    spikeMs: num("spike-ms", values["spike-ms"], base.spikeMs),
    disconnectRate: num(
      "disconnect-rate",
      values["disconnect-rate"],
      base.disconnectRate,
    ),
  };

  let bug: BugName | null = null;
  if (values.bug !== undefined) {
    if (!(BUGS as readonly string[]).includes(values.bug)) {
      throw new Error(`--bug must be one of ${BUGS.join(", ")}`);
    }
    bug = values.bug as BugName;
  }

  if (values.code && !values.url) throw new Error("--code needs --url");
  const target: SimTarget = values.url
    ? { kind: "remote", url: values.url, code: values.code ?? null }
    : {
        kind: "local",
        waves: num("waves", values.waves, 10),
        compile: !values["test-wave"],
        startLeadMs: num("start-lead", values["start-lead"], 900),
      };

  const clients = num("clients", values.clients, DEFAULT_SIM_OPTIONS.clients);
  const json = values.json === true;
  const log = (line: string) => {
    // Progress goes to stderr so --json output stays parseable.
    process.stderr.write(`sim: ${line}\n`);
  };

  const streamPort =
    values.stream === undefined ? null : num("stream", values.stream, 0);
  if (
    streamPort !== null &&
    (!Number.isInteger(streamPort) || streamPort > 65535)
  ) {
    throw new Error(`--stream must be a port number, got "${values.stream}"`);
  }

  let printed = false;
  const print = (report: SimReport) => {
    printed = true;
    process.stdout.write(
      json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report, bug),
    );
  };

  return runSim({
    clients: Math.floor(clients),
    seed: num("seed", values.seed, DEFAULT_SIM_OPTIONS.seed),
    faults,
    target,
    maxP95Ms: num("max-p95", values["max-p95"], DEFAULT_SIM_OPTIONS.maxP95Ms),
    joinTimeoutMs: num(
      "join-timeout",
      values["join-timeout"],
      DEFAULT_SIM_OPTIONS.joinTimeoutMs,
    ),
    startTimeoutMs: num(
      "start-timeout",
      values["start-timeout"],
      DEFAULT_SIM_OPTIONS.startTimeoutMs,
    ),
    bug,
    stream: streamPort === null ? null : { port: streamPort },
    onReport: async (report) => {
      if (streamPort === null) return;
      print(report);
      log("stream still serving; Ctrl+C to stop");
      await new Promise<void>((resolve) => process.once("SIGINT", resolve));
    },
    log,
  }).then((report) => {
    if (!printed) print(report);
    return report.passed ? 0 : 1;
  });
}

export function formatReport(r: SimReport, bug: BugName | null): string {
  const lines = [
    "",
    `Simulated clients: ${r.clients}${bug ? ` (injected bug: ${bug})` : ""}`,
    `Session ${r.sessionCode}, show ${(r.showDurationMs / 1000).toFixed(1)} s`,
    "",
    `Sync error (|render - true event time|, ${r.syncError.count} events)`,
    `  p50 ${ms(r.syncError.p50)}   p95 ${ms(r.syncError.p95)}   max ${ms(r.syncError.max)}   mean signed ${ms(r.meanSignedErrorMs)}`,
    `Clock error (|serverNow() - server clock| at those events)`,
    `  p50 ${ms(r.clockError.p50)}   p95 ${ms(r.clockError.p95)}   max ${ms(r.clockError.max)}`,
    `Join to standby`,
    `  p50 ${ms(r.joinToStandby.p50, 0)}   p95 ${ms(r.joinToStandby.p95, 0)}   max ${ms(r.joinToStandby.max, 0)}`,
    `Standby at start: ${r.standbyAtStart}/${r.clients}, degraded clocks: ${r.degradedAtStart}`,
    `Reconnects: ${r.reconnects.planned} planned, ${r.reconnects.reconnected} reconnected, ${r.reconnects.resumed} resumed`,
    `Skipped events: ${r.skippedEvents}, silent clients: ${r.silentClients}`,
    `Clients with any event over the limit: ${r.clientsOverLimit}`,
    `Worst clients:`,
    ...r.worstClients.map(
      (w) =>
        `  #${w.index}: max ${ms(w.maxErrorMs)}, best RTT ${ms(w.bestRttMs ?? NaN)}, ` +
        `path ${ms(w.pathMs ?? NaN)}, asymmetry ${ms(w.asymmetryMs)}` +
        `${w.degraded ? ", degraded" : ""}${w.dropped ? ", dropped" : ""}`,
    ),
    `Frame timer lag: p95 ${ms(r.frameLag.p95)}, max ${ms(r.frameLag.max)}`,
    `Run time: ${(r.runMs / 1000).toFixed(1)} s`,
    "",
    r.passed ? "PASS" : `FAIL\n${r.failures.map((f) => `  - ${f}`).join("\n")}`,
    "",
  ];
  return lines.join("\n");
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(
      `sim: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  },
);
