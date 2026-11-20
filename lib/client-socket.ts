/**
 * Types for browser-side socket clients (participant page, host page) that
 * take their WebSocket, storage and timers as injected deps, so the same
 * code runs in Node tests. Types only: no globals here.
 */

/**
 * An event handler checked bivariantly (like a method), so the DOM's
 * `(ev: MessageEvent) => any` fits `{ data: unknown }`.
 */
type Handler<E> = { bivarianceHack(event: E): void }["bivarianceHack"];

/** The subset of `WebSocket` the clients use. Browser and Node 24 both fit. */
export type SocketLike = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: Handler<unknown> | null;
  onmessage: Handler<{ data: unknown }> | null;
  onclose: Handler<{ code: number; reason: string }> | null;
  onerror: Handler<unknown> | null;
};

/** `sessionStorage` or a stand-in. */
export type KeyValueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** `WebSocket.OPEN`. */
export const SOCKET_OPEN = 1;

/** Clear a socket's handlers so a dead socket's late events are ignored. */
export function detachSocket(socket: SocketLike): void {
  socket.onopen = null;
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
}

/** Reconnect delay: base * 2^attempt, capped at max. */
export function backoffMs(attempt: number, baseMs: number, maxMs: number) {
  return Math.min(maxMs, baseMs * 2 ** attempt);
}
