import {
  encodeMessage,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "@/lib/protocol";
import type {
  ParticipantState,
  Point,
  ScheduleEvent,
  Venue,
} from "@/lib/types";
import {
  SOCKET_OPEN,
  backoffMs,
  detachSocket,
  type KeyValueStorage,
  type SocketLike,
} from "@/lib/client-socket";
import { wsUrlFor } from "@/lib/ws-url";

/**
 * The participant page's connection to the server, kept apart from rendering
 * (SPEC 2.3, 4.3). It owns the socket, the connect delay, reconnects with
 * resume, and a snapshot of what the page should show. React reads it through
 * `subscribe` + `getSnapshot` (`useSyncExternalStore`).
 *
 * Later chunks hook in without touching the rendering:
 * - ClockSync (chunk 4): `addListener({ onOpen, onMessage })` to start a
 *   burst on every open and feed `sync` replies, `send` to ping.
 * - Playback (chunk 5): read `schedule` and `T0` from the snapshot, and
 *   `addListener({ onMessage })` for `start` / `stop`.
 *
 * Browser globals are only touched in `browserDeps()`, so the class runs in
 * Node tests with injected deps.
 */

export type { KeyValueStorage, SocketLike };

export type ParticipantClientDeps = {
  wsUrl: string;
  createSocket: (url: string) => SocketLike;
  /** Null if storage is unavailable (private mode); resume then won't work. */
  storage: KeyValueStorage | null;
  /** 0..1, like `Math.random`. */
  random: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  /** Random delay before the first connect, spread over 0..this (SPEC 4.3). */
  connectDelayMaxMs: number;
  /** Reconnect backoff: base * 2^attempt, capped, plus random jitter. */
  reconnectBaseMs: number;
  reconnectMaxMs: number;
};

export const DEFAULT_CONNECT_DELAY_MAX_MS = 800;
export const DEFAULT_RECONNECT_BASE_MS = 500;
export const DEFAULT_RECONNECT_MAX_MS = 5_000;

/** Close code the server uses when a newer socket resumed this participant. */
export const CLOSE_REPLACED = 4000;

export type ConnectionStatus =
  /** Not started, or waiting out the initial random delay. */
  | "waiting"
  | "connecting"
  | "open"
  /** Socket closed; a reconnect is scheduled. */
  | "reconnecting"
  /** Stopped for good (`stop()` or a fatal error). */
  | "closed";

/** Errors the page cannot recover from by reconnecting. */
export type FatalError =
  /** The join code does not match a live session. */
  | "unknown-session"
  /** Another tab resumed this participant (sessionStorage is copied when a tab is duplicated). */
  | "replaced";

export type ParticipantSchedule = {
  events: ScheduleEvent[];
  durationMs: number;
};

export type ParticipantSnapshot = {
  code: string;
  connection: ConnectionStatus;
  /** At least one `welcome` arrived. */
  welcomed: boolean;
  participantId: string | null;
  venue: Venue | null;
  seat: Point | null;
  /** Ready was tapped (here or before a reload). */
  readyTapped: boolean;
  /** The schedule for the current seat, or null while pending. */
  schedule: ParticipantSchedule | null;
  /** Server-clock start time while a show runs (SPEC 4.6), else null. */
  T0: number | null;
  /** The host stopped a running show. */
  showOver: boolean;
  fatal: FatalError | null;
  /** The last non-fatal `error` message from the server, for debugging. */
  lastError: string | null;
};

/** Which screen the page shows (SPEC 2.3). */
export type ParticipantScreen =
  | "connecting"
  | "not-found"
  | "replaced"
  | "seat"
  | "syncing"
  | "standby"
  | "playing"
  | "over";

export function participantScreen(s: ParticipantSnapshot): ParticipantScreen {
  if (s.fatal === "unknown-session") return "not-found";
  if (s.fatal === "replaced") return "replaced";
  if (!s.welcomed || !s.venue) return "connecting";
  if (s.showOver) return "over";
  if (!s.readyTapped || !s.seat) return "seat";
  if (!s.schedule) return "syncing";
  return s.T0 !== null ? "playing" : "standby";
}

export type ParticipantClientListener = {
  /** The socket opened (first connect or reconnect), before `join` is sent. */
  onOpen?: () => void;
  /** Every parsed server message, after the client handled it. */
  onMessage?: (message: ServerMessage) => void;
  /** The socket closed. `willReconnect` is false after `stop()` or a fatal error. */
  onClose?: (willReconnect: boolean) => void;
};

type StoredResume = { participantId: string; resumeToken: string };

/** States in which the server already knows Ready was tapped. */
const READY_STATES: readonly ParticipantState[] = [
  "syncing",
  "standby",
  "playing",
];

export function storageKey(code: string): string {
  return `aurora.participant.${code.toUpperCase()}`;
}

export class ParticipantClient {
  private readonly depsSource:
    ParticipantClientDeps | (() => ParticipantClientDeps);
  private resolvedDeps: ParticipantClientDeps | null = null;
  private snapshot: ParticipantSnapshot;
  private socket: SocketLike | null = null;
  private timer: unknown = null;
  private attempt = 0;
  private started = false;
  private stopped = false;
  private readonly subscribers = new Set<() => void>();
  private readonly listeners = new Set<ParticipantClientListener>();

  /**
   * `deps` may be a function, called on first use, so the client can be
   * constructed during server rendering (`browserDeps` needs `window`).
   */
  constructor(
    code: string,
    deps: ParticipantClientDeps | (() => ParticipantClientDeps),
  ) {
    this.depsSource = deps;
    this.snapshot = {
      code: code.toUpperCase(),
      connection: "waiting",
      welcomed: false,
      participantId: null,
      venue: null,
      seat: null,
      readyTapped: false,
      schedule: null,
      T0: null,
      showOver: false,
      fatal: null,
      lastError: null,
    };
  }

  private get deps(): ParticipantClientDeps {
    if (!this.resolvedDeps) {
      const source = this.depsSource;
      this.resolvedDeps = typeof source === "function" ? source() : source;
    }
    return this.resolvedDeps;
  }

  // -- Lifecycle -------------------------------------------------------------

  /**
   * Open the socket after a random 0..connectDelayMaxMs delay. Idempotent
   * while running. Restarts after `stop()` (React strict mode runs effects
   * twice), but not after a fatal error.
   */
  start(): void {
    if (this.started || this.snapshot.fatal) return;
    this.started = true;
    this.stopped = false;
    this.update({ connection: "waiting" });
    const delay = this.deps.random() * this.deps.connectDelayMaxMs;
    this.schedule(() => this.connect(), delay);
  }

  /** Close the socket and stop reconnecting until `start()`. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.started = false;
    this.clearTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      detachSocket(socket);
      socket.close(1000, "stopped");
      this.emitClose(false);
    }
    this.update({ connection: "closed" });
  }

  // -- Store interface (useSyncExternalStore) --------------------------------

  getSnapshot = (): ParticipantSnapshot => this.snapshot;

  subscribe = (onChange: () => void): (() => void) => {
    this.subscribers.add(onChange);
    return () => this.subscribers.delete(onChange);
  };

  /** Hook for ClockSync and playback. Returns an unsubscribe function. */
  addListener(listener: ParticipantClientListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // -- Actions ---------------------------------------------------------------

  /** Send a message if the socket is open. Returns whether it was sent. */
  send(message: ClientMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return false;
    socket.send(encodeMessage(message));
    return true;
  }

  /** Place or move the seat (normalised 0..1). Sent now, or on reconnect. */
  setSeat(seat: Point): void {
    this.update({
      seat,
      // A new seat means a new schedule; the server sends it after `seat`.
      schedule: this.snapshot.readyTapped ? null : this.snapshot.schedule,
    });
    this.send({ type: "seat", x: seat.x, y: seat.y });
  }

  /** Tap Ready. Needs a seat. Sent now, or on reconnect. */
  ready(): void {
    if (!this.snapshot.seat || this.snapshot.readyTapped) return;
    this.update({ readyTapped: true });
    this.send({ type: "ready" });
  }

  // -- Socket ----------------------------------------------------------------

  private connect(): void {
    if (this.stopped) return;
    this.update({ connection: "connecting" });
    let socket: SocketLike;
    try {
      socket = this.deps.createSocket(this.deps.wsUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.update({ connection: "open" });
      for (const l of this.listeners) l.onOpen?.();
      const resume = this.readResume();
      this.send({
        type: "join",
        code: this.snapshot.code,
        ...(resume ?? {}),
      });
    };
    socket.onmessage = (event) => {
      if (socket !== this.socket || typeof event.data !== "string") return;
      const parsed = parseServerMessage(event.data);
      if (!parsed.ok) return;
      this.handleMessage(parsed.message);
      for (const l of this.listeners) l.onMessage?.(parsed.message);
    };
    socket.onclose = (event) => {
      if (socket !== this.socket) return;
      this.socket = null;
      detachSocket(socket);
      if (event.code === CLOSE_REPLACED) {
        this.fail("replaced");
        return;
      }
      if (this.stopped) return;
      this.emitClose(true);
      this.scheduleReconnect();
    };
    // A failed connect is followed by `close`, which schedules the retry.
    socket.onerror = () => {};
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const backoff = backoffMs(
      this.attempt,
      this.deps.reconnectBaseMs,
      this.deps.reconnectMaxMs,
    );
    this.attempt += 1;
    // Jitter spreads a venue's worth of phones after a wifi blip (SPEC 4.3).
    const jitter = this.deps.random() * this.deps.connectDelayMaxMs;
    this.update({ connection: "reconnecting" });
    this.schedule(() => this.connect(), backoff + jitter);
  }

  private fail(fatal: FatalError): void {
    this.stopped = true;
    this.clearTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      detachSocket(socket);
      socket.close(1000, fatal);
    }
    this.emitClose(false);
    this.update({ connection: "closed", fatal });
  }

  // -- Messages --------------------------------------------------------------

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "welcome":
        this.onWelcome(message);
        return;
      case "schedule":
        this.update({
          schedule: { events: message.events, durationMs: message.durationMs },
        });
        return;
      case "start":
        this.update({ T0: message.T0, showOver: false });
        return;
      case "stop":
        // Chunk 5 may refine this (for example, "over" only at the end).
        this.update({ T0: null, showOver: this.snapshot.T0 !== null });
        return;
      case "error":
        if (message.reason === "unknown-session") {
          this.fail("unknown-session");
          return;
        }
        this.update({ lastError: `${message.reason}: ${message.message}` });
        return;
      default:
        // `sync` replies and host-only messages are for listeners.
        return;
    }
  }

  private onWelcome(message: Extract<ServerMessage, { type: "welcome" }>) {
    this.attempt = 0;
    this.writeResume({
      participantId: message.participantId,
      resumeToken: message.resumeToken,
    });

    const prev = this.snapshot;
    const sameParticipant = prev.participantId === message.participantId;
    const serverSeat = message.state.seat;
    const serverReady = READY_STATES.includes(message.state.participant);
    // Prefer what this page chose while offline; else what the server kept.
    const seat = prev.seat ?? serverSeat;
    const readyTapped = prev.readyTapped || serverReady;

    this.update({
      welcomed: true,
      participantId: message.participantId,
      venue: message.venue,
      seat,
      readyTapped,
      // The server resends the schedule to a resumed, ready participant.
      schedule: sameParticipant ? prev.schedule : null,
      T0: message.state.T0,
      lastError: null,
    });

    // Bring the server up to date if it lost us (new participant) or the
    // seat moved while the socket was down.
    if (seat && !samePoint(seat, serverSeat)) {
      this.send({ type: "seat", x: seat.x, y: seat.y });
    }
    if (seat && readyTapped && !serverReady) this.send({ type: "ready" });
  }

  // -- Plumbing --------------------------------------------------------------

  private update(patch: Partial<ParticipantSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.subscribers) fn();
  }

  private emitClose(willReconnect: boolean): void {
    for (const l of this.listeners) l.onClose?.(willReconnect);
  }

  private schedule(fn: () => void, ms: number): void {
    this.clearTimer();
    this.timer = this.deps.setTimeout(() => {
      this.timer = null;
      fn();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = null;
  }

  private readResume(): StoredResume | null {
    try {
      const raw = this.deps.storage?.getItem(storageKey(this.snapshot.code));
      if (!raw) return null;
      const value: unknown = JSON.parse(raw);
      if (
        typeof value === "object" &&
        value !== null &&
        "participantId" in value &&
        "resumeToken" in value &&
        typeof value.participantId === "string" &&
        typeof value.resumeToken === "string"
      ) {
        return {
          participantId: value.participantId,
          resumeToken: value.resumeToken,
        };
      }
    } catch {
      // Storage blocked or corrupt: join as a new participant.
    }
    return null;
  }

  private writeResume(resume: StoredResume): void {
    try {
      this.deps.storage?.setItem(
        storageKey(this.snapshot.code),
        JSON.stringify(resume),
      );
    } catch {
      // Storage full or blocked: reconnects will join as new participants.
    }
  }
}

function samePoint(a: Point, b: Point | null): boolean {
  return b !== null && a.x === b.x && a.y === b.y;
}

/** Deps for the real page. Call only in the browser. */
export function browserDeps(): ParticipantClientDeps {
  let storage: KeyValueStorage | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null;
  }
  return {
    wsUrl: wsUrlFor(window.location),
    createSocket: (url) => new WebSocket(url),
    storage,
    random: Math.random,
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    connectDelayMaxMs: DEFAULT_CONNECT_DELAY_MAX_MS,
    reconnectBaseMs: DEFAULT_RECONNECT_BASE_MS,
    reconnectMaxMs: DEFAULT_RECONNECT_MAX_MS,
  };
}
