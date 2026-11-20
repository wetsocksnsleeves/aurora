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

/**
 * Attach the app WebSocket server to `server`.
 *
 * Upgrades on `/ws` are handled here and never reach Next. Other upgrade paths
 * go to `fallback`, which is `app.getUpgradeHandler()` (SPEC 5.1).
 *
 * How Next 16 handles HMR (checked against next@16.4.6): on the first HTTP
 * request it adds its own `upgrade` listener to the server. That listener
 * serves `/_next/hmr` and ignores paths it does not route, such as `/ws`.
 * `app.getUpgradeHandler()` is a no-op in this version. We still forward to it
 * until Next's listener exists, and stop once it does, so an upgrade is never
 * handed to Next twice if a later version makes both paths live.
 */
export function attachWebSocketServer(
  server: Server,
  fallback: UpgradeHandler,
): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (pathnameOf(req) === WS_PATH) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }
    const nextAttachedItsOwn = server.listenerCount("upgrade") > 1;
    if (!nextAttachedItsOwn) void fallback(req, socket, head);
  });

  wss.on("connection", handleConnection);
  return wss;
}

function handleConnection(ws: WebSocket): void {
  // Chunk 0: echo every message back. Chunk 1 replaces this with routing.
  ws.on("message", (data, isBinary) => {
    ws.send(data, { binary: isBinary });
  });
}

function pathnameOf(req: IncomingMessage): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}
