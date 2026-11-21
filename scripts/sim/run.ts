import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import {
  encodeMessage,
  parseServerMessage,
  type ClientMessage,
  type ParticipantSummary,
  type ServerMessage,
} from "@/lib/protocol";
import { TEST_SHOW, TEST_SHOW_ID, TEST_WAVE_PERIOD_MS } from "@/lib/test-show";
import type { Point, Show, Venue } from "@/lib/types";
import { shapeAt } from "@/lib/venue-geometry";
import { closeCompilePool } from "@/server/compile-pool";
import { SessionStore } from "@/server/sessions";
import {
  attachWebSocketServer,
  defaultComputeSchedule,
  testWaveComputeSchedule,
} from "@/server/ws";
import { injectBug, type BugName } from "./bugs";
import { drawClientFaults, seededRandom, type FaultConfig } from "./faults";
import { SimClient, trueNow } from "./sim-client";
import { startCrowdStream } from "./stream";
import { mean, summarize, type Summary } from "./stats";

/**
 * The simulated-client harness (SPEC 6.1, 6.2) as a function, so the CLI
 * (`scripts/sim.ts`) and the Vitest run share it.
 *
 * Measurement: every simulated phone runs in this process, so they share one
 * true clock, `performance.now()`. Each phone's local clock is that, scaled
 * by its drift and shifted by its offset.
 *
 * - `local` target (default): the WebSocket server (`WsRouter`, without
 *   Next) runs in this process on a loopback port. The server clock is then
 *   the true clock exactly, so `T0` needs no conversion.
 * - `remote` target: the server is another process (`npm run dev`, or a
 *   deployed server). Before the run the harness measures the server clock
 *   against its own over a clean socket, keeping the lowest-RTT of 40
 *   rounds; on loopback that is good to a fraction of a millisecond, over a
 *   tunnel to half the best RTT.
 */

export type SimTarget =
  | {
      kind: "local";
      /** Test-wave periods to play (2 s each). 10 is the full test show. */
      waves: number;
      /** Compile schedules on the worker pool (the real path) or use the
       * exact test wave. */
      compile: boolean;
      startLeadMs: number;
    }
  | {
      kind: "remote";
      /** Server base URL (`http://localhost:3000`) or its `/ws` URL. */
      url: string;
      /**
       * Join this session; the run waits for Start on its host page, which
       * shows the simulated dots. Null: create a session for the test show
       * and start it from the harness.
       */
      code: string | null;
    };

export type SimOptions = {
  clients: number;
  seed: number;
  faults: FaultConfig;
  target: SimTarget;
  /** Fail when p95 sync error exceeds this. SPEC 4: 50 ms. */
  maxP95Ms: number;
  /** How long to wait for every client to reach standby. */
  joinTimeoutMs: number;
  /** Remote session only: how long to wait for Start on the host page. */
  startTimeoutMs: number;
  bug: BugName | null;
  /** Serve each client's seat and colour on this port (`--stream`). */
  stream: { port: number } | null;
  /**
   * Called with the report while the clients and the stream are still up;
   * the run waits for it to settle before cleaning up.
   */
  onReport?: (report: SimReport) => Promise<void> | void;
  log: (line: string) => void;
};

export const DEFAULT_SIM_OPTIONS: Omit<SimOptions, "faults" | "log"> = {
  clients: 500,
  seed: 1,
  target: { kind: "local", waves: 10, compile: true, startLeadMs: 900 },
  maxP95Ms: 50,
  joinTimeoutMs: 30_000,
  startTimeoutMs: 600_000,
  bug: null,
  stream: null,
};

export type WorstClient = {
  index: number;
  maxErrorMs: number;
  degraded: boolean;
  dropped: boolean;
  bestRttMs: number | null;
  pathMs: number | null;
  asymmetryMs: number;
};

export type SimReport = {
  clients: number;
  /** Clients in standby when the show started. */
  standbyAtStart: number;
  /** Clients whose clock was ready only through the 6 s fallback. */
  degradedAtStart: number;
  /** |render time - event time| over every recorded event. */
  syncError: Summary;
  /** Mean of the signed error (positive: late). */
  meanSignedErrorMs: number;
  /** |serverNow() - true server clock| at each recorded event. */
  clockError: Summary;
  /** Socket open (first `join`) to the page showing standby. */
  joinToStandby: Summary;
  /** Events crossed in the same frame as a later one (never shown). */
  skippedEvents: number;
  /** Clients that recorded no events at all. */
  silentClients: number;
  /** Clients with at least one event off by more than `maxP95Ms`. */
  clientsOverLimit: number;
  /** The clients with the largest error, for debugging. */
  worstClients: WorstClient[];
  reconnects: { planned: number; reconnected: number; resumed: number };
  /** How late the simulated 60 Hz frame timer fired. */
  frameLag: Summary;
  /** Server clock minus true clock, and the RTT it was measured with. */
  serverOffset: { offsetMs: number; rttMs: number };
  sessionCode: string;
  showDurationMs: number;
  runMs: number;
  failures: string[];
  passed: boolean;
};

const FRAME_MS = 1000 / 60;

export async function runSim(options: SimOptions): Promise<SimReport> {
  const runStart = trueNow();
  const { log } = options;
  const restoreBug = options.bug ? injectBug(options.bug) : null;
  const cleanups: (() => Promise<void> | void)[] = [];
  if (restoreBug) cleanups.push(restoreBug);
  try {
    return await run(options, runStart, log, cleanups);
  } finally {
    for (const fn of cleanups.reverse()) {
      try {
        await fn();
      } catch (err) {
        log(`cleanup failed: ${String(err)}`);
      }
    }
  }
}

async function run(
  options: SimOptions,
  runStart: number,
  log: (line: string) => void,
  cleanups: (() => Promise<void> | void)[],
): Promise<SimReport> {
  const { target } = options;

  // -- Server and session ---------------------------------------------------
  let wsUrl: string;
  let serverOffset = { offsetMs: 0, rttMs: 0 };
  let host: RawHost | null = null;
  let code: string;

  if (target.kind === "local") {
    const local = await startLocalServer(target);
    cleanups.push(local.close);
    wsUrl = local.wsUrl;
    log(`server: in-process on ${wsUrl}`);
  } else {
    wsUrl = toWsUrl(target.url);
    serverOffset = await measureServerOffset(wsUrl);
    log(
      `server: ${wsUrl}, clock offset ${serverOffset.offsetMs.toFixed(2)} ms ` +
        `(measured at ${serverOffset.rttMs.toFixed(2)} ms RTT)`,
    );
  }

  if (target.kind === "remote" && target.code) {
    code = target.code.toUpperCase();
  } else {
    host = await RawHost.create(wsUrl, TEST_SHOW_ID);
    cleanups.push(() => host?.close());
    code = host.code;
  }
  log(`session: ${code}`);

  // -- Clients --------------------------------------------------------------
  const master = seededRandom(options.seed);
  const dropCount = Math.round(options.clients * options.faults.disconnectRate);
  const dropIndexes = new Set(
    shuffle(
      Array.from({ length: options.clients }, (_, i) => i),
      master,
    ).slice(0, dropCount),
  );
  const clients: SimClient[] = [];
  for (let i = 0; i < options.clients; i++) {
    const random = seededRandom(Math.floor(master() * 2 ** 32));
    const faults = drawClientFaults(options.faults, random);
    // Drop somewhere in the middle of the show.
    const dropAt = dropIndexes.has(i) ? 0.2 + 0.4 * random() : null;
    clients.push(
      new SimClient(
        code,
        wsUrl,
        (venue) => randomSeat(venue, random),
        faults,
        random,
        dropAt,
      ),
    );
  }
  cleanups.push(() => {
    for (const c of clients) c.stop();
  });

  if (options.stream) {
    const stream = await startCrowdStream(clients, code, options.stream.port);
    cleanups.push(stream.close);
    log(`stream: ws://localhost:${stream.port}`);
  }

  // -- Simulated requestAnimationFrame ----------------------------------------
  const lags: number[] = [];
  let ticking = true;
  let tickTimer: ReturnType<typeof setTimeout> | null = null;
  const firstFrame = trueNow();
  let frameNo = 0;
  const tick = () => {
    const now = trueNow();
    const due = firstFrame + frameNo * FRAME_MS;
    lags.push(now - due);
    for (const c of clients) {
      c.maybeDrop(now, serverOffset.offsetMs);
      c.frame(now, serverOffset.offsetMs);
    }
    if (!ticking) return;
    // The next frame boundary after now, so a slow tick skips frames.
    frameNo = Math.max(frameNo + 1, Math.ceil((now - firstFrame) / FRAME_MS));
    tickTimer = setTimeout(
      tick,
      Math.max(0, firstFrame + frameNo * FRAME_MS - trueNow()),
    );
  };
  tick();
  cleanups.push(() => {
    ticking = false;
    if (tickTimer) clearTimeout(tickTimer);
  });

  for (const c of clients) c.start();

  // -- Join to standby --------------------------------------------------------
  const allStandby = () => clients.every((c) => c.standby);
  const serverStandby = () =>
    host === null ||
    host.participants.filter((p) => p.state === "standby").length >=
      clients.length;
  const joined = await waitFor(
    () => allStandby() && serverStandby(),
    options.joinTimeoutMs,
  );
  const standbyAtStart = clients.filter((c) => c.standby).length;
  const degradedAtStart = clients.filter((c) => c.degraded).length;
  log(
    `standby: ${standbyAtStart}/${clients.length} clients ` +
      `(${degradedAtStart} degraded) after ${((trueNow() - runStart) / 1000).toFixed(1)} s` +
      (joined ? "" : " (join timeout)"),
  );

  // -- Start ----------------------------------------------------------------
  const anyStarted = () => clients.some((c) => c.T0 !== null);
  if (host) {
    await host.start();
  } else {
    log("waiting for Start on the host page...");
    if (!(await waitFor(anyStarted, options.startTimeoutMs))) {
      throw new Error("the show was not started in time");
    }
  }
  await waitFor(anyStarted, 10_000);
  const T0 = clients.find((c) => c.T0 !== null)?.T0 ?? null;
  if (T0 === null) throw new Error("no client received start");
  const durationMs =
    clients.find((c) => c.client.getSnapshot().schedule)?.client.getSnapshot()
      .schedule?.durationMs ?? 0;
  log(`show: started, ${(durationMs / 1000).toFixed(1)} s long`);

  // -- Play ------------------------------------------------------------------
  const trueEnd = T0 - serverOffset.offsetMs + durationMs;
  await waitFor(
    () => clients.every((c) => c.over),
    Math.max(0, trueEnd - trueNow()) + 15_000,
  );

  // -- Report ------------------------------------------------------------------
  const errors = clients.flatMap((c) => c.errors);
  const absErrors = errors.map(Math.abs);
  const clockErrors = clients.flatMap((c) => c.clockErrors).map(Math.abs);
  const joinTimes = clients
    .filter((c) => c.joinAt !== null && c.standbyAt !== null)
    .map((c) => c.standbyAt! - c.joinAt!);
  const planned = clients.filter((c) => c.dropAt !== null);
  const reconnected = planned.filter((c) => c.opens > 1);
  const resumed = reconnected.filter(
    (c) => c.participantIds.size === 1 && c.standby,
  );
  const syncError = summarize(absErrors);

  const failures: string[] = [];
  if (errors.length === 0) failures.push("no events were recorded");
  if (syncError.p95 > options.maxP95Ms) {
    failures.push(
      `p95 sync error ${syncError.p95.toFixed(1)} ms is over ${options.maxP95Ms} ms`,
    );
  }
  if (standbyAtStart < clients.length) {
    failures.push(
      `only ${standbyAtStart}/${clients.length} clients reached standby`,
    );
  }
  const silent = clients.filter((c) => c.errors.length === 0).length;
  if (silent > 0) failures.push(`${silent} clients recorded no events`);
  if (resumed.length < planned.length) {
    failures.push(
      `${resumed.length}/${planned.length} dropped clients resumed their session`,
    );
  }

  const report: SimReport = {
    clients: clients.length,
    standbyAtStart,
    degradedAtStart,
    syncError,
    meanSignedErrorMs: mean(errors),
    clockError: summarize(clockErrors),
    joinToStandby: summarize(joinTimes),
    skippedEvents: clients.reduce((n, c) => n + c.skipped, 0),
    silentClients: silent,
    clientsOverLimit: clients.filter((c) =>
      c.errors.some((e) => Math.abs(e) > options.maxP95Ms),
    ).length,
    worstClients: worstClients(clients, 3),
    reconnects: {
      planned: planned.length,
      reconnected: reconnected.length,
      resumed: resumed.length,
    },
    frameLag: summarize(lags),
    serverOffset,
    sessionCode: code,
    showDurationMs: durationMs,
    runMs: trueNow() - runStart,
    failures,
    passed: failures.length === 0,
  };
  await options.onReport?.(report);
  return report;
}

// ---------------------------------------------------------------------------
// Server side
// ---------------------------------------------------------------------------

/** The test show cut to `waves` wave periods. */
export function testShowWithWaves(waves: number): Show {
  const count = Math.max(1, Math.min(TEST_SHOW.clips.length, waves));
  return {
    ...TEST_SHOW,
    clips: TEST_SHOW.clips.slice(0, count),
    audio: { ...TEST_SHOW.audio, durationMs: count * TEST_WAVE_PERIOD_MS },
  };
}

/**
 * The app's WebSocket server on a plain HTTP server (no Next, which the
 * harness does not need), in this process so it shares the true clock.
 */
async function startLocalServer(
  target: Extract<SimTarget, { kind: "local" }>,
): Promise<{ wsUrl: string; close(): Promise<void> }> {
  const show = testShowWithWaves(target.waves);
  const server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  const wss = attachWebSocketServer(server, {
    nextUpgrade: () => {},
    forwardNextUpgrades: false,
    store: new SessionStore(),
    resolveShow: (id) => (id === TEST_SHOW_ID ? show : undefined),
    computeSchedule: target.compile
      ? defaultComputeSchedule
      : testWaveComputeSchedule,
    startLeadMs: target.startLeadMs,
    publicUrl: "http://sim.invalid",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    async close() {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (target.compile) await closeCompilePool();
    },
  };
}

/** `http://host:3000` -> `ws://host:3000/ws`; a `ws(s)://` URL is kept. */
export function toWsUrl(url: string): string {
  const u = new URL(url);
  if (u.protocol === "http:") u.protocol = "ws:";
  else if (u.protocol === "https:") u.protocol = "wss:";
  if (u.pathname === "/" || u.pathname === "") u.pathname = "/ws";
  return u.toString();
}

/** A host connection with no faults: creates the session, presses Start. */
class RawHost {
  participants: ParticipantSummary[] = [];
  private waiters: ((m: ServerMessage) => boolean)[] = [];

  private constructor(
    private readonly ws: WebSocket,
    public code = "",
  ) {
    ws.on("message", (data) => {
      const parsed = parseServerMessage(String(data));
      if (!parsed.ok) return;
      const m = parsed.message;
      if (m.type === "participants") this.participants = m.list;
      this.waiters = this.waiters.filter((w) => !w(m));
    });
    ws.on("error", () => {});
  }

  static async create(wsUrl: string, showId: string): Promise<RawHost> {
    const ws = await openSocket(wsUrl);
    const host = new RawHost(ws);
    const session = host.next(
      (m) => m.type === "session" || m.type === "error",
    );
    host.send({ type: "host", showId });
    const m = await session;
    if (m.type !== "session") {
      throw new Error(`could not create a session: ${JSON.stringify(m)}`);
    }
    host.code = m.code;
    return host;
  }

  async start(): Promise<void> {
    const reply = this.next((m) => m.type === "start" || m.type === "error");
    this.send({ type: "start" });
    const m = await reply;
    if (m.type !== "start")
      throw new Error(`start refused: ${JSON.stringify(m)}`);
  }

  close(): void {
    this.ws.terminate();
  }

  private send(message: ClientMessage): void {
    this.ws.send(encodeMessage(message));
  }

  private next(match: (m: ServerMessage) => boolean): Promise<ServerMessage> {
    return new Promise((resolve) => {
      this.waiters.push((m) => {
        if (!match(m)) return false;
        resolve(m);
        return true;
      });
    });
  }
}

/**
 * Server clock minus this process's clock, from the lowest-RTT of `rounds`
 * sequential `sync` rounds over a socket with no injected faults.
 */
export async function measureServerOffset(
  wsUrl: string,
  rounds = 40,
): Promise<{ offsetMs: number; rttMs: number }> {
  const ws = await openSocket(wsUrl);
  try {
    let best = { offsetMs: 0, rttMs: Infinity };
    for (let i = 0; i < rounds; i++) {
      const c0 = performance.now();
      const reply = new Promise<number>((resolve, reject) => {
        const onMessage = (data: unknown) => {
          const parsed = parseServerMessage(String(data));
          if (parsed.ok && parsed.message.type === "sync") {
            ws.off("message", onMessage);
            resolve(parsed.message.s1);
          }
        };
        ws.on("message", onMessage);
        ws.once("close", () => reject(new Error("socket closed")));
      });
      ws.send(encodeMessage({ type: "sync", c0 }));
      const s1 = await reply;
      const c1 = performance.now();
      if (c1 - c0 < best.rttMs) {
        best = { offsetMs: s1 - (c0 + c1) / 2, rttMs: c1 - c0 };
      }
    }
    return best;
  } finally {
    ws.terminate();
  }
}

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function worstClients(clients: SimClient[], count: number): WorstClient[] {
  return clients
    .map((c, index) => {
      let maxErrorMs = 0;
      for (const e of c.errors) maxErrorMs = Math.max(maxErrorMs, Math.abs(e));
      return {
        index,
        maxErrorMs,
        degraded: c.degraded,
        dropped: c.dropped,
        bestRttMs: c.client.clock.bestRtt,
        pathMs: c.faults.pathMs,
        asymmetryMs: c.faults.asymmetryMs,
      };
    })
    .sort((a, b) => b.maxErrorMs - a.maxErrorMs)
    .slice(0, count);
}

/** A uniformly random point inside the venue's shapes. */
export function randomSeat(venue: Venue, random: () => number): Point {
  const points = venue.shapes.flatMap((s) => s.points);
  if (points.length === 0) return { x: random(), y: random() };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const [x0, x1] = [Math.max(0, Math.min(...xs)), Math.min(1, Math.max(...xs))];
  const [y0, y1] = [Math.max(0, Math.min(...ys)), Math.min(1, Math.max(...ys))];
  for (let i = 0; i < 1000; i++) {
    const p = { x: x0 + (x1 - x0) * random(), y: y0 + (y1 - y0) * random() };
    if (shapeAt(venue, p) !== null) return p;
  }
  return points[0]!;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/** Polls `done` every 50 ms. Resolves true when it holds, false on timeout. */
async function waitFor(done: () => boolean, timeoutMs: number) {
  const end = trueNow() + timeoutMs;
  while (!done()) {
    if (trueNow() >= end) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}
