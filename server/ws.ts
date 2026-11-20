import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  encodeMessage,
  parseClientMessage,
  type ClientMessage,
  type ClientMessageType,
  type ErrorReason,
  type MessageOfType,
  type ServerMessage,
} from "@/lib/protocol";
import { TEST_SHOW, TEST_SHOW_ID, testSchedule } from "@/lib/test-show";
import type { Point, Show } from "@/lib/types";
import {
  SessionError,
  getSessionStore,
  type Participant,
  type Session,
  type SessionStore,
  type TimedSchedule,
} from "./sessions";

/** Path the app's WebSocket listens on (SPEC 5.1). */
export const WS_PATH = "/ws";

/** Largest client message accepted. Client messages are tiny. */
export const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;

/** Host `participants` updates are throttled to 4 per second (SPEC 5.2). */
export const PARTICIPANTS_THROTTLE_MS = 250;

export type UpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void | Promise<void>;

/** Upgrade paths Next owns (dev HMR lives at `/_next/hmr`). */
const NEXT_UPGRADE_PREFIX = "/_next/";

export type ScheduleComputer = (
  show: Show,
  seat: Point,
) => TimedSchedule | Promise<TimedSchedule>;

export type ShowResolver = (
  showId: string,
) => Show | undefined | Promise<Show | undefined>;

/**
 * Chunk 1 default: every show plays the hardcoded test wave.
 * Chunk 8 replaces this with `compileSchedule` on a worker thread.
 */
export const defaultComputeSchedule: ScheduleComputer = (show, seat) => ({
  ...testSchedule(seat),
  durationMs: show.audio.durationMs,
});

/**
 * Chunk 1 default: only the test show exists.
 * Chunk 10/15 replaces this with a lookup in show storage.
 */
export const defaultResolveShow: ShowResolver = (showId) =>
  showId === TEST_SHOW_ID ? TEST_SHOW : undefined;

export type AttachOptions = {
  /** Next's `app.getUpgradeHandler()`. */
  nextUpgrade: UpgradeHandler;
  /** Forward `/_next/*` upgrades to Next. True in dev, where HMR needs it. */
  forwardNextUpgrades: boolean;
  /** Defaults to the process-wide `getSessionStore()`. */
  store?: SessionStore;
  /**
   * Base URL for join links (`<publicUrl>/j/<code>`). Defaults to the
   * `PUBLIC_URL` env var, then to the origin the host connected through.
   */
  publicUrl?: string;
  computeSchedule?: ScheduleComputer;
  resolveShow?: ShowResolver;
  /** Defaults to `PARTICIPANTS_THROTTLE_MS`. */
  participantsThrottleMs?: number;
  /** How often to drop participants disconnected for 60 s. Default 5 s. */
  sweepIntervalMs?: number;
  /** Ping interval; a socket that misses a pong is terminated. Default 15 s. */
  heartbeatMs?: number;
};

/**
 * Attach the app WebSocket server to `server` and route every upgrade:
 *
 * - `/ws` goes to the `ws` server (SPEC 5.1).
 * - `/_next/*` goes to Next's upgrade handler, in dev only (HMR).
 * - Anything else, and `/_next/*` in production, gets a 404 and the socket is
 *   destroyed, so clients cannot park idle sockets on unknown paths.
 *
 * If Next's handler throws or rejects, the socket is destroyed.
 *
 * Note on Next 16 (checked against next@16.4.6): `app.getUpgradeHandler()` is
 * a no-op. On the first HTTP request Next adds its own `upgrade` listener to
 * the server, and that listener is what serves `/_next/hmr`. It ignores paths
 * it does not route, so it leaves `/ws` alone. We still forward to
 * `getUpgradeHandler()` as the spec asks, so HMR keeps working if a later
 * version stops attaching its own listener. `server/server.test.ts` fails if
 * Next ever handles an HMR upgrade twice.
 */
export function attachWebSocketServer(
  server: Server,
  options: AttachOptions,
): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
  });
  const router = new WsRouter(options);

  server.on("upgrade", (req, socket, head) => {
    const pathname = pathnameOf(req);
    if (pathname === WS_PATH) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }
    if (
      options.forwardNextUpgrades &&
      pathname?.startsWith(NEXT_UPGRADE_PREFIX)
    ) {
      forwardToNext(options.nextUpgrade, req, socket, head);
      return;
    }
    rejectUpgrade(socket, 404, "Not Found");
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) =>
    router.handleConnection(ws, req),
  );
  wss.on("close", () => router.close());
  return wss;
}

// ---------------------------------------------------------------------------
// Message routing
// ---------------------------------------------------------------------------

type Role =
  | { kind: "none" }
  | {
      kind: "participant";
      session: Session;
      participantId: string;
      /** `Participant.connectionToken` when this socket joined. */
      token: number;
    }
  | { kind: "host"; session: Session };

/** One open socket. */
export type Connection = {
  ws: WebSocket;
  /** Origin the client connected through, for join URLs without PUBLIC_URL. */
  origin: string;
  role: Role;
  alive: boolean;
};

type Handler<K extends ClientMessageType> = (
  conn: Connection,
  message: MessageOfType<ClientMessage, K>,
) => void | Promise<void>;

/** One handler per client message type. Adding a type to the protocol
 * without a handler here is a type error. */
type Handlers = { [K in ClientMessageType]: Handler<K> };

/**
 * Routes client messages to the session store and sends replies.
 *
 * Extension points for later chunks:
 * - `sync` (chunk 4): reply `{ type: "sync", c0, s1: performance.now() }`
 *   from `handlers.sync`, for participants and hosts alike.
 * - `start` / `stop` (chunk 5): in `handlers.start` / `handlers.stop`, check
 *   `requireHost`, call `store.startShow` / `store.stopShow`, then
 *   `broadcastToParticipants` and `sendToHosts`.
 * - Schedules (chunk 8): pass `computeSchedule`, or change
 *   `defaultComputeSchedule`.
 * - Shows (chunks 10, 15): pass `resolveShow`, or change `defaultResolveShow`.
 */
export class WsRouter {
  readonly store: SessionStore;
  private readonly options: AttachOptions;
  private readonly computeSchedule: ScheduleComputer;
  private readonly resolveShow: ShowResolver;
  private readonly throttleMs: number;
  /** Host sockets per session code. */
  private readonly hosts = new Map<string, Set<Connection>>();
  /** The current socket of each participant id. */
  private readonly participantSockets = new Map<string, Connection>();
  private readonly participantsThrottle = new Map<
    string,
    { lastSentAt: number; timer: ReturnType<typeof setTimeout> | null }
  >();
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private readonly heartbeatTimer: ReturnType<typeof setInterval>;
  private readonly connections = new Set<Connection>();

  constructor(options: AttachOptions) {
    this.options = options;
    this.store = options.store ?? getSessionStore();
    this.computeSchedule = options.computeSchedule ?? defaultComputeSchedule;
    this.resolveShow = options.resolveShow ?? defaultResolveShow;
    this.throttleMs =
      options.participantsThrottleMs ?? PARTICIPANTS_THROTTLE_MS;
    this.sweepTimer = setInterval(
      () => this.sweep(),
      options.sweepIntervalMs ?? 5_000,
    );
    this.sweepTimer.unref();
    this.heartbeatTimer = setInterval(
      () => this.heartbeat(),
      options.heartbeatMs ?? 15_000,
    );
    this.heartbeatTimer.unref();
  }

  handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const conn: Connection = {
      ws,
      origin: originOf(req),
      role: { kind: "none" },
      alive: true,
    };
    this.connections.add(conn);
    ws.on("pong", () => (conn.alive = true));
    ws.on("message", (data, isBinary) => {
      void this.onMessage(conn, data, isBinary);
    });
    ws.on("close", () => this.onClose(conn));
    ws.on("error", () => ws.terminate());
  }

  /** Stop timers. Sockets are closed by the WebSocketServer. */
  close(): void {
    clearInterval(this.sweepTimer);
    clearInterval(this.heartbeatTimer);
    for (const t of this.participantsThrottle.values()) {
      if (t.timer) clearTimeout(t.timer);
    }
    this.participantsThrottle.clear();
  }

  // -- Sending ---------------------------------------------------------------

  send(conn: Connection, message: ServerMessage): void {
    if (conn.ws.readyState === conn.ws.OPEN) {
      conn.ws.send(encodeMessage(message));
    }
  }

  sendError(conn: Connection, reason: ErrorReason, message: string): void {
    this.send(conn, { type: "error", reason, message });
  }

  /** Send to every connected participant socket in the session. */
  broadcastToParticipants(session: Session, message: ServerMessage): void {
    const encoded = encodeMessage(message);
    for (const id of session.participants.keys()) {
      const conn = this.participantSockets.get(id);
      if (conn && conn.ws.readyState === conn.ws.OPEN) conn.ws.send(encoded);
    }
  }

  sendToHosts(session: Session, message: ServerMessage): void {
    for (const conn of this.hosts.get(session.code) ?? []) {
      this.send(conn, message);
    }
  }

  /**
   * Queue a `participants` update for the session's hosts. Sends at once if
   * none went out in the last throttle window, otherwise once at its end.
   */
  notifyParticipantsChanged(session: Session): void {
    if (!this.hosts.get(session.code)?.size) return;
    let t = this.participantsThrottle.get(session.code);
    if (!t) {
      t = { lastSentAt: -Infinity, timer: null };
      this.participantsThrottle.set(session.code, t);
    }
    if (t.timer) return;
    const wait = t.lastSentAt + this.throttleMs - Date.now();
    if (wait <= 0) {
      this.flushParticipants(session);
      return;
    }
    t.timer = setTimeout(() => this.flushParticipants(session), wait);
  }

  private flushParticipants(session: Session): void {
    const t = this.participantsThrottle.get(session.code);
    if (t) {
      if (t.timer) clearTimeout(t.timer);
      t.timer = null;
      t.lastSentAt = Date.now();
    }
    this.sendToHosts(session, {
      type: "participants",
      list: this.store.summaries(session),
    });
  }

  // -- Receiving -------------------------------------------------------------

  private async onMessage(
    conn: Connection,
    data: RawData,
    isBinary: boolean,
  ): Promise<void> {
    if (isBinary) {
      this.sendError(conn, "bad-message", "binary messages are not supported");
      return;
    }
    const parsed = parseClientMessage(rawToString(data));
    if (!parsed.ok) {
      this.sendError(conn, "bad-message", parsed.error);
      return;
    }
    const message = parsed.message;
    try {
      // The mapped type guarantees handlers[K] takes MessageOfType<..., K>;
      // TypeScript cannot correlate the two through `message.type`.
      const handler = this.handlers[message.type] as Handler<ClientMessageType>;
      await handler(conn, message as never);
    } catch (err) {
      if (err instanceof SessionError) {
        this.sendError(conn, err.reason, err.message);
        return;
      }
      console.error(`ws: ${message.type} handler failed`, err);
      this.sendError(conn, "bad-message", "internal error");
    }
  }

  private onClose(conn: Connection): void {
    this.connections.delete(conn);
    const role = conn.role;
    if (role.kind === "participant") {
      if (this.participantSockets.get(role.participantId) === conn) {
        this.participantSockets.delete(role.participantId);
      }
      if (this.store.disconnect(role.session, role.participantId, role.token)) {
        this.notifyParticipantsChanged(role.session);
      }
    } else if (role.kind === "host") {
      this.hosts.get(role.session.code)?.delete(conn);
    }
  }

  private readonly handlers: Handlers = {
    join: (conn, msg) => this.onJoin(conn, msg),
    seat: (conn, msg) => this.onSeat(conn, msg),
    ready: (conn) => this.onReady(conn),
    host: (conn, msg) => this.onHost(conn, msg),
    // Chunk 4: reply with the server clock (SPEC 4.2).
    sync: (conn) => this.unsupported(conn, "sync"),
    // Chunk 5: start and stop the show (SPEC 4.6).
    start: (conn) => this.unsupported(conn, "start"),
    stop: (conn) => this.unsupported(conn, "stop"),
  };

  private unsupported(conn: Connection, type: ClientMessageType): void {
    this.sendError(conn, "unsupported", `"${type}" is not implemented yet`);
  }

  private onJoin(conn: Connection, msg: MessageOfType<ClientMessage, "join">) {
    if (conn.role.kind !== "none") {
      throw new SessionError("bad-message", "this socket already joined");
    }
    const session = this.store.requireSession(msg.code);
    const { participant, resumed } = this.store.join(
      session,
      msg.participantId,
    );
    conn.role = {
      kind: "participant",
      session,
      participantId: participant.id,
      token: participant.connectionToken,
    };

    // A rejoin can arrive before the server noticed the old socket died.
    const previous = this.participantSockets.get(participant.id);
    this.participantSockets.set(participant.id, conn);
    if (previous && previous !== conn) previous.ws.close(4000, "replaced");

    this.send(conn, {
      type: "welcome",
      participantId: participant.id,
      venue: session.show.venue,
      state: {
        participant: participant.state,
        seat: participant.seat,
        T0: session.T0,
      },
    });
    if (resumed && participant.readyTapped) {
      if (participant.schedule) {
        this.sendSchedule(participant, participant.schedule);
      } else {
        void this.updateSchedule(session, participant);
      }
    }
    this.notifyParticipantsChanged(session);
  }

  private onSeat(conn: Connection, msg: MessageOfType<ClientMessage, "seat">) {
    const { session, participant } = this.requireParticipant(conn);
    this.store.setSeat(session, participant.id, { x: msg.x, y: msg.y });
    if (participant.readyTapped) void this.updateSchedule(session, participant);
    this.notifyParticipantsChanged(session);
  }

  private onReady(conn: Connection) {
    const { session, participant } = this.requireParticipant(conn);
    this.store.markReady(session, participant.id);
    void this.updateSchedule(session, participant);
    this.notifyParticipantsChanged(session);
  }

  private async onHost(
    conn: Connection,
    msg: MessageOfType<ClientMessage, "host">,
  ) {
    if (conn.role.kind !== "none") {
      throw new SessionError("bad-message", "this socket already joined");
    }
    let session: Session;
    if ("showId" in msg) {
      const show = await this.resolveShow(msg.showId);
      if (!show) {
        throw new SessionError("unknown-show", `no show "${msg.showId}"`);
      }
      session = this.store.createSession(show);
    } else {
      session = this.store.requireSession(msg.code);
    }
    conn.role = { kind: "host", session };
    let set = this.hosts.get(session.code);
    if (!set) {
      set = new Set();
      this.hosts.set(session.code, set);
    }
    set.add(conn);

    const base = (
      this.options.publicUrl ??
      process.env.PUBLIC_URL ??
      conn.origin
    ).replace(/\/+$/, "");
    this.send(conn, {
      type: "session",
      code: session.code,
      joinUrl: `${base}/j/${session.code}`,
      showId: session.showId,
      venue: session.show.venue,
      T0: session.T0,
    });
    this.send(conn, {
      type: "participants",
      list: this.store.summaries(session),
    });
  }

  // -- Helpers ---------------------------------------------------------------

  /** Throws `not-joined` unless this socket joined as a participant. */
  requireParticipant(conn: Connection): {
    session: Session;
    participant: Participant;
  } {
    const role = conn.role;
    if (role.kind !== "participant") {
      throw new SessionError("not-joined", "send join first");
    }
    return {
      session: role.session,
      participant: this.store.getParticipant(role.session, role.participantId),
    };
  }

  /** Throws `not-host` unless this socket attached as a host. */
  requireHost(conn: Connection): Session {
    if (conn.role.kind !== "host") {
      throw new SessionError("not-host", "send host first");
    }
    return conn.role.session;
  }

  /**
   * Compute the participant's schedule for the current seat and send it. If
   * the seat moves while computing, the stale result is dropped (the move
   * started a newer computation).
   */
  private async updateSchedule(
    session: Session,
    participant: Participant,
  ): Promise<void> {
    const { seat, scheduleVersion } = participant;
    if (!seat) return;
    let schedule: TimedSchedule;
    try {
      schedule = await this.computeSchedule(session.show, seat);
    } catch (err) {
      console.error("ws: schedule computation failed", err);
      return;
    }
    if (
      this.store.setSchedule(session, participant.id, schedule, scheduleVersion)
    ) {
      this.sendSchedule(participant, schedule);
      this.notifyParticipantsChanged(session);
    }
  }

  private sendSchedule(participant: Participant, schedule: TimedSchedule) {
    const conn = this.participantSockets.get(participant.id);
    if (!conn) return;
    this.send(conn, {
      type: "schedule",
      events: schedule.events,
      durationMs: schedule.durationMs,
    });
  }

  private sweep(): void {
    for (const session of this.store.removeExpired()) {
      this.notifyParticipantsChanged(session);
    }
  }

  private heartbeat(): void {
    for (const conn of this.connections) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      conn.ws.ping();
    }
  }
}

// ---------------------------------------------------------------------------
// Upgrade helpers
// ---------------------------------------------------------------------------

function forwardToNext(
  handler: UpgradeHandler,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  const fail = (err: unknown) => {
    console.error("Next upgrade handler failed", err);
    socket.destroy();
  };
  try {
    Promise.resolve(handler(req, socket, head)).catch(fail);
  } catch (err) {
    fail(err);
  }
}

/** Answer an upgrade with a plain HTTP error and close the socket. */
export function rejectUpgrade(
  socket: Duplex,
  status: number,
  reason: string,
): void {
  if (socket.writable) {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\n\r\n`);
  }
  socket.destroy();
}

/** The request path, or null if the URL cannot be parsed. */
function pathnameOf(req: IncomingMessage): string | null {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return null;
  }
}

/** `proto://host` the client used, honouring a tunnel's forwarded headers. */
function originOf(req: IncomingMessage): string {
  const first = (value: string | string[] | undefined) =>
    (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();
  const proto = first(req.headers["x-forwarded-proto"]) ?? "http";
  const host =
    first(req.headers["x-forwarded-host"]) ?? req.headers.host ?? "localhost";
  return `${proto}://${host}`;
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}
