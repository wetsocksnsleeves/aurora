import { WebSocketServer, type WebSocket } from "ws";
import type { Point, Venue } from "@/lib/types";
import { encodeFrame, encodeSeats } from "@/lib/crowd-stream";

/** Frames per second sent to viewers. */
const STREAM_HZ = 30;
/** Skip a viewer whose send queue is above this many bytes. */
const MAX_BUFFERED_BYTES = 256 * 1024;

export type StreamSource = {
  seat: Point | null;
  color: string;
  /** The venue outline once this client has been told it. */
  venue?: Venue | null;
};

export type CrowdStream = {
  port: number;
  close: () => Promise<void>;
};

/**
 * Serves the clients' seats and live colours (`lib/crowd-stream.ts`) over a
 * WebSocket. Binds 127.0.0.1 unless `host` says otherwise; port 0 picks one.
 */
export async function startCrowdStream(
  clients: readonly StreamSource[],
  code: string,
  port: number,
  host = "127.0.0.1",
): Promise<CrowdStream> {
  const wss = new WebSocketServer({ host, port });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  wss.on("error", () => {});

  const seatsKey = () =>
    JSON.stringify(clients.map((c) => (c.seat ? [c.seat.x, c.seat.y] : null)));
  const venueOf = () => clients.find((c) => c.venue)?.venue ?? null;
  let lastKey = seatsKey();
  let lastVenueKnown = venueOf() !== null;
  const sendSeats = (ws: WebSocket) =>
    ws.send(
      encodeSeats(
        code,
        clients.map((c) => c.seat),
        venueOf(),
      ),
    );
  wss.on("connection", (ws) => {
    ws.on("error", () => {});
    sendSeats(ws);
  });

  let frame = 0;
  const timer = setInterval(() => {
    const key = seatsKey();
    const venueKnown = venueOf() !== null;
    if (key !== lastKey || venueKnown !== lastVenueKnown) {
      lastKey = key;
      lastVenueKnown = venueKnown;
      for (const ws of wss.clients)
        if (ws.readyState === ws.OPEN) sendSeats(ws);
    }
    if (wss.clients.size === 0) return;
    const bytes = encodeFrame(
      frame++,
      clients.map((c) => c.color),
    );
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN || ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        continue;
      }
      ws.send(bytes);
    }
  }, 1000 / STREAM_HZ);

  return {
    port: (wss.address() as { port: number }).port,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(timer);
        for (const ws of wss.clients) ws.terminate();
        wss.close(() => resolve());
      }),
  };
}
