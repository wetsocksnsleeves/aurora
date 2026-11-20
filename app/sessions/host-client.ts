import {
  SOCKET_OPEN,
  backoffMs,
  detachSocket,
  type KeyValueStorage,
  type SocketLike,
} from "@/lib/client-socket";
import {
  encodeMessage,
  parseServerMessage,
  type ClientMessage,
  type ParticipantSummary,
  type ServerMessage,
  type SessionMessage,
} from "@/lib/protocol";
import { wsUrlFor } from "@/lib/ws-url";

/**
 * The host page's connection to the server (SPEC 2.2), kept apart from
 * rendering like `ParticipantClient`. Creating a session and re-attaching to
 * it both go through here:
 *
 * - `createHostedSession(showId)` sends `host { showId }`, stores the
 *   returned `hostToken` in sessionStorage keyed by code, and resolves the
 *   code. The page then navigates to `/sessions/<code>/host`.
 * - `HostClient` re-attaches with `host { code, hostToken }` and keeps the
 *   session and the throttled `participants` list in a snapshot. Without a
 *   stored token it does not connect and reports `no-token`.
 *
 * Later chunks hook in with `addListener` and `send`: Start/Stop (chunk 5),
 * the host's own ClockSync (chunk 4).
 */

export type HostClientDeps = {
  wsUrl: string;
  createSocket: (url: string) => SocketLike;
  storage: KeyValueStorage | null;
  random: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
};

export type HostConnection = "connecting" | "open" | "reconnecting" | "closed";

export type HostFatal =
  /** This browser tab never created the session (no stored token). */
  | "no-token"
  /** The server refused the stored token. */
  | "not-host"
  /** No session with this code (e.g. the server restarted). */
  | "unknown-session";

export type HostSnapshot = {
  code: string;
  connection: HostConnection;
  /** The last `session` message, or null before the first. */
  session: SessionMessage | null;
  participants: ParticipantSummary[];
  /** Server-clock start time while a show runs, else null. */
  T0: number | null;
  fatal: HostFatal | null;
};

export type HostClientListener = {
  onOpen?: () => void;
  onMessage?: (message: ServerMessage) => void;
  onClose?: (willReconnect: boolean) => void;
};

export function hostStorageKey(code: string): string {
  return `aurora.host.${code.toUpperCase()}`;
}

export function readHostToken(
  storage: KeyValueStorage | null,
  code: string,
): string | null {
  try {
    return storage?.getItem(hostStorageKey(code)) ?? null;
  } catch {
    return null;
  }
}

export function saveHostToken(
  storage: KeyValueStorage | null,
  code: string,
  token: string,
): void {
  try {
    storage?.setItem(hostStorageKey(code), token);
  } catch {
    // Storage blocked: a reload of the host page will show "not the host".
  }
}

export class HostClient {
  private readonly depsSource: HostClientDeps | (() => HostClientDeps);
  private resolvedDeps: HostClientDeps | null = null;
  private snapshot: HostSnapshot;
  private socket: SocketLike | null = null;
  private timer: unknown = null;
  private attempt = 0;
  private running = false;
  private readonly subscribers = new Set<() => void>();
  private readonly listeners = new Set<HostClientListener>();

  /** `deps` may be a function, called on first use (see `browserHostDeps`). */
  constructor(code: string, deps: HostClientDeps | (() => HostClientDeps)) {
    this.depsSource = deps;
    this.snapshot = {
      code: code.toUpperCase(),
      connection: "connecting",
      session: null,
      participants: [],
      T0: null,
      fatal: null,
    };
  }

  private get deps(): HostClientDeps {
    if (!this.resolvedDeps) {
      const source = this.depsSource;
      this.resolvedDeps = typeof source === "function" ? source() : source;
    }
    return this.resolvedDeps;
  }

  /** Connect now. Idempotent while running; restarts after `stop()`. */
  start(): void {
    if (this.running || this.snapshot.fatal) return;
    if (!readHostToken(this.deps.storage, this.snapshot.code)) {
      this.update({ connection: "closed", fatal: "no-token" });
      return;
    }
    this.running = true;
    this.connect();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.clearTimer();
    this.dropSocket();
    this.emitClose(false);
    this.update({ connection: "closed" });
  }

  getSnapshot = (): HostSnapshot => this.snapshot;

  subscribe = (onChange: () => void): (() => void) => {
    this.subscribers.add(onChange);
    return () => this.subscribers.delete(onChange);
  };

  addListener(listener: HostClientListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Send a message if the socket is open. Returns whether it was sent. */
  send(message: ClientMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return false;
    socket.send(encodeMessage(message));
    return true;
  }

  private connect(): void {
    if (!this.running) return;
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
      const hostToken = readHostToken(this.deps.storage, this.snapshot.code);
      this.send({
        type: "host",
        code: this.snapshot.code,
        ...(hostToken ? { hostToken } : {}),
      });
    };
    socket.onmessage = (event) => {
      if (socket !== this.socket || typeof event.data !== "string") return;
      const parsed = parseServerMessage(event.data);
      if (!parsed.ok) return;
      this.handleMessage(parsed.message);
      for (const l of this.listeners) l.onMessage?.(parsed.message);
    };
    socket.onclose = () => {
      if (socket !== this.socket) return;
      this.socket = null;
      detachSocket(socket);
      if (!this.running) return;
      this.emitClose(true);
      this.scheduleReconnect();
    };
    socket.onerror = () => {};
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "session":
        this.attempt = 0;
        this.update({ session: message, T0: message.T0 });
        return;
      case "participants":
        this.update({ participants: message.list });
        return;
      case "start":
        this.update({ T0: message.T0 });
        return;
      case "stop":
        this.update({ T0: null });
        return;
      case "error":
        if (
          message.reason === "not-host" ||
          message.reason === "unknown-session"
        ) {
          this.fail(message.reason);
        }
        return;
      default:
        return;
    }
  }

  private fail(fatal: HostFatal): void {
    this.running = false;
    this.clearTimer();
    this.dropSocket();
    this.emitClose(false);
    this.update({ connection: "closed", fatal });
  }

  private scheduleReconnect(): void {
    if (!this.running) return;
    const delay =
      backoffMs(
        this.attempt,
        this.deps.reconnectBaseMs,
        this.deps.reconnectMaxMs,
      ) +
      this.deps.random() * this.deps.reconnectBaseMs;
    this.attempt += 1;
    this.update({ connection: "reconnecting" });
    this.clearTimer();
    this.timer = this.deps.setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private dropSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      detachSocket(socket);
      socket.close(1000, "stopped");
    }
  }

  private clearTimer(): void {
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = null;
  }

  private emitClose(willReconnect: boolean): void {
    for (const l of this.listeners) l.onClose?.(willReconnect);
  }

  private update(patch: Partial<HostSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.subscribers) fn();
  }
}

export class CreateSessionError extends Error {}

/**
 * Create a session for `showId`: send `host { showId }`, store the returned
 * host token under its code, close the socket, and resolve the code.
 */
export function createHostedSession(
  showId: string,
  deps: Pick<HostClientDeps, "wsUrl" | "createSocket" | "storage">,
  timeoutMs = 10_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = deps.createSocket(deps.wsUrl);
    let settled = false;
    const finish = (error: Error | null, code?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      detachSocket(socket);
      socket.close(1000, "done");
      if (error) reject(error);
      else resolve(code!);
    };
    const timer = setTimeout(
      () => finish(new CreateSessionError("timed out creating the session")),
      timeoutMs,
    );
    socket.onopen = () => {
      socket.send(encodeMessage({ type: "host", showId }));
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const parsed = parseServerMessage(event.data);
      if (!parsed.ok) return;
      const message = parsed.message;
      if (message.type === "session" && message.hostToken) {
        saveHostToken(deps.storage, message.code, message.hostToken);
        finish(null, message.code);
      } else if (message.type === "error") {
        finish(new CreateSessionError(message.message));
      }
    };
    socket.onclose = () =>
      finish(new CreateSessionError("connection closed before the session"));
    socket.onerror = () => {};
  });
}

/** Deps for the real host page. Call only in the browser. */
export function browserHostDeps(): HostClientDeps {
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
    reconnectBaseMs: 500,
    reconnectMaxMs: 5_000,
  };
}
