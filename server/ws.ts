import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

/** Path the app's WebSocket listens on (SPEC 5.1). */
export const WS_PATH = "/ws";

export type UpgradeHandler = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void | Promise<void>;

/** Upgrade paths Next owns (dev HMR lives at `/_next/hmr`). */
const NEXT_UPGRADE_PREFIX = "/_next/";

export type AttachOptions = {
  /** Next's `app.getUpgradeHandler()`. */
  nextUpgrade: UpgradeHandler;
  /** Forward `/_next/*` upgrades to Next. True in dev, where HMR needs it. */
  forwardNextUpgrades: boolean;
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
  const wss = new WebSocketServer({ noServer: true });

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

  wss.on("connection", handleConnection);
  return wss;
}

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

function handleConnection(ws: WebSocket): void {
  // Chunk 0: echo every message back. Chunk 1 replaces this with routing.
  ws.on("message", (data, isBinary) => {
    ws.send(data, { binary: isBinary });
  });
}

/** The request path, or null if the URL cannot be parsed. */
function pathnameOf(req: IncomingMessage): string | null {
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return null;
  }
}
