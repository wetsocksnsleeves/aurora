import { parseColor } from "./compile";
import type { Point } from "./types";

/**
 * Wire format of the simulated crowd stream (`scripts/sim.ts --stream`): each
 * simulated client's seat and live colour, for a viewer such as the 3D mock
 * run-through. Pure; works in the browser and in Node.
 *
 * Two message kinds on one WebSocket:
 *
 * - Text (JSON) `seats`, sent once per connection and again whenever the
 *   client list or any seat changes:
 *   `{ type: "seats", version: 1, code, seats: ({x, y} | null)[] }`.
 *   The array index is the client index; null until a seat is chosen.
 * - Binary `frame`, ~30 per second: byte 0 is `FRAME_TAG` (0x01), bytes 1-4
 *   are a big-endian uint32 frame counter (wraps), then 3 bytes (R, G, B)
 *   per client in client-index order. Length is `5 + 3 * clients`.
 */

export const CROWD_STREAM_VERSION = 1;
export const FRAME_TAG = 0x01;
export const FRAME_HEADER_BYTES = 5;

export type SeatsMessage = {
  type: "seats";
  version: number;
  code: string;
  seats: (Point | null)[];
};

export type Rgb8 = readonly [number, number, number];

export type DecodedFrame = {
  frame: number;
  /** `3 * clients` bytes, RGB per client. A view into the input. */
  rgb: Uint8Array;
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/** `#rgb` or `#rrggbb` to bytes. Anything else is black. */
export function hexToRgbBytes(color: string): Rgb8 {
  const { r, g, b } = parseColor(color);
  return [r, g, b];
}

export function encodeSeats(code: string, seats: (Point | null)[]): string {
  const message: SeatsMessage = {
    type: "seats",
    version: CROWD_STREAM_VERSION,
    code,
    seats: seats.map((s) => (s ? { x: s.x, y: s.y } : null)),
  };
  return JSON.stringify(message);
}

export function parseSeats(raw: string): Result<SeatsMessage> {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "not JSON" };
  }
  if (typeof data !== "object" || data === null) {
    return { ok: false, error: "not an object" };
  }
  const m = data as Record<string, unknown>;
  if (m.type !== "seats") return { ok: false, error: "not a seats message" };
  if (m.version !== CROWD_STREAM_VERSION) {
    return { ok: false, error: `unsupported version ${String(m.version)}` };
  }
  if (typeof m.code !== "string") return { ok: false, error: "bad code" };
  if (!Array.isArray(m.seats)) return { ok: false, error: "bad seats" };
  const seats: (Point | null)[] = [];
  for (const s of m.seats as unknown[]) {
    if (s === null) {
      seats.push(null);
      continue;
    }
    const p = s as { x?: unknown; y?: unknown } | undefined;
    if (
      typeof p !== "object" ||
      typeof p.x !== "number" ||
      typeof p.y !== "number" ||
      !Number.isFinite(p.x) ||
      !Number.isFinite(p.y)
    ) {
      return { ok: false, error: "bad seat" };
    }
    seats.push({ x: p.x, y: p.y });
  }
  return {
    ok: true,
    value: { type: "seats", version: m.version, code: m.code, seats },
  };
}

/** Encodes one frame from `#rrggbb` colours, one per client. */
export function encodeFrame(
  frame: number,
  colors: readonly string[],
): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES + 3 * colors.length);
  out[0] = FRAME_TAG;
  new DataView(out.buffer).setUint32(1, frame >>> 0, false);
  colors.forEach((c, i) => {
    const [r, g, b] = hexToRgbBytes(c);
    const o = FRAME_HEADER_BYTES + 3 * i;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
  });
  return out;
}

/** Decodes a frame; `clients` is the expected count when known. */
export function decodeFrame(
  data: unknown,
  clients?: number,
): Result<DecodedFrame> {
  let bytes: Uint8Array;
  if (data instanceof Uint8Array) bytes = data;
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else return { ok: false, error: "not binary" };
  if (bytes.length < FRAME_HEADER_BYTES) {
    return { ok: false, error: "too short" };
  }
  if (bytes[0] !== FRAME_TAG) return { ok: false, error: "bad tag" };
  const body = bytes.length - FRAME_HEADER_BYTES;
  if (body % 3 !== 0) return { ok: false, error: "bad length" };
  if (clients !== undefined && body !== 3 * clients) {
    return { ok: false, error: "wrong client count" };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    ok: true,
    value: {
      frame: view.getUint32(1, false),
      rgb: bytes.subarray(FRAME_HEADER_BYTES),
    },
  };
}
