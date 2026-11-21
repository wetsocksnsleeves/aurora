import { describe, expect, it } from "vitest";
import {
  decodeFrame,
  encodeFrame,
  encodeSeats,
  hexToRgbBytes,
  parseSeats,
} from "./crowd-stream";

describe("crowd stream", () => {
  it("parses hex colours", () => {
    expect(hexToRgbBytes("#ff8000")).toEqual([255, 128, 0]);
    expect(hexToRgbBytes("#f80")).toEqual([255, 136, 0]);
    expect(hexToRgbBytes("nope")).toEqual([0, 0, 0]);
  });

  it("round-trips seats", () => {
    const seats = [{ x: 0.25, y: 0.5 }, null];
    const r = parseSeats(encodeSeats("ABC123", seats));
    expect(r).toEqual({
      ok: true,
      value: { type: "seats", version: 1, code: "ABC123", seats },
    });
  });

  it("round-trips the venue and omits it when unknown", () => {
    const venue = {
      shapes: [
        {
          id: "a",
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
          ],
        },
      ],
    };
    const r = parseSeats(encodeSeats("ABC123", [null], venue));
    expect(r.ok && r.value.venue).toEqual(venue);
    const none = parseSeats(encodeSeats("ABC123", [null], null));
    expect(none.ok && "venue" in none.value).toBe(false);
  });

  it("rejects bad seats messages", () => {
    for (const raw of [
      "{",
      "null",
      "{}",
      '{"type":"seats","version":9,"code":"A","seats":[]}',
      '{"type":"seats","version":1,"code":1,"seats":[]}',
      '{"type":"seats","version":1,"code":"A","seats":[{"x":"a","y":1}]}',
      '{"type":"seats","version":1,"code":"A","seats":[5]}',
      '{"type":"seats","version":1,"code":"A","seats":[],"venue":5}',
      '{"type":"seats","version":1,"code":"A","seats":[],"venue":{"shapes":[{"id":"a","points":[{"x":1}]}]}}',
    ]) {
      expect(parseSeats(raw).ok).toBe(false);
    }
  });

  it("round-trips frames", () => {
    const bytes = encodeFrame(0x01020304, ["#010203", "#ffffff"]);
    expect(bytes.length).toBe(5 + 6);
    const r = decodeFrame(bytes.buffer, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.frame).toBe(0x01020304);
    expect([...r.value.rgb]).toEqual([1, 2, 3, 255, 255, 255]);
  });

  it("rejects bad frames", () => {
    const good = encodeFrame(1, ["#000000"]);
    expect(decodeFrame("text").ok).toBe(false);
    expect(decodeFrame(good.subarray(0, 3)).ok).toBe(false);
    expect(decodeFrame(good.subarray(0, 7)).ok).toBe(false);
    expect(decodeFrame(good, 2).ok).toBe(false);
    const wrongTag = good.slice();
    wrongTag[0] = 9;
    expect(decodeFrame(wrongTag).ok).toBe(false);
  });
});
