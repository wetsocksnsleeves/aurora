import { describe, expect, it } from "vitest";
import {
  encodeMessage,
  parseClientMessage,
  parseMessage,
  parseServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "./protocol";
import { TEST_SHOW, TEST_VENUE } from "./test-show";
import type { Show } from "./types";

/** A show with every clip variant, for round-trips. */
const SHOW: Show = {
  ...TEST_SHOW,
  clips: [
    ...TEST_SHOW.clips.slice(0, 1),
    {
      id: "fill",
      layer: 2,
      startMs: 0,
      endMs: 500,
      color: "#123456",
      fadeInMs: 10,
      fadeOutMs: 20,
      shape: { kind: "fill" },
    },
    {
      id: "still",
      layer: 1,
      startMs: 0,
      endMs: 500,
      color: "#abc",
      fadeInMs: 0,
      fadeOutMs: 0,
      shape: {
        kind: "polygon",
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
          { x: 0, y: 1 },
        ],
      },
    },
  ],
};

const okClient = (value: unknown) => {
  const result = parseClientMessage(JSON.stringify(value));
  if (!result.ok) throw new Error(result.error);
  return result.message;
};

const badClient = (raw: string) => {
  const result = parseClientMessage(raw);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.error;
};

describe("parseClientMessage", () => {
  it("accepts every client message type", () => {
    const messages: ClientMessage[] = [
      { type: "join", code: "ABCDEF" },
      { type: "join", code: "ABCDEF", participantId: "p1" },
      { type: "join", code: "ABCDEF", participantId: "p1", resumeToken: "t" },
      { type: "seat", x: 0, y: 1 },
      { type: "ready" },
      { type: "sync", c0: 123.456 },
      { type: "clock", ready: true, degraded: false, rttMs: 42 },
      { type: "clock", ready: false, degraded: false, rttMs: null },
      { type: "host", showId: "test" },
      { type: "host", code: "ABCDEF" },
      { type: "host", code: "ABCDEF", hostToken: "secret" },
      { type: "start" },
      { type: "stop" },
      {
        type: "positioning",
        config: { targetWidthM: 4.2, venueWidthM: 30, venueDepthM: 25 },
      },
    ];
    for (const message of messages) {
      expect(okClient(message)).toEqual(message);
    }
  });

  it("drops unknown fields", () => {
    expect(okClient({ type: "ready", extra: 1 })).toEqual({ type: "ready" });
    expect(okClient({ type: "join", code: "A", participantId: null })).toEqual({
      type: "join",
      code: "A",
    });
  });

  it("rejects bad JSON and unknown types", () => {
    expect(badClient("{nope")).toMatch(/JSON/);
    expect(badClient("[]")).toMatch(/type/);
    expect(badClient('"join"')).toMatch(/type/);
    expect(badClient('{"type":"welcome"}')).toMatch(/unknown/);
  });

  it("rejects bad payloads", () => {
    badClient('{"type":"join"}');
    badClient('{"type":"join","code":""}');
    badClient('{"type":"join","code":"ABCDEF","participantId":5}');
    badClient(`{"type":"join","code":"${"A".repeat(17)}"}`);
    badClient('{"type":"seat","x":0.5}');
    badClient('{"type":"seat","x":"0.5","y":0.5}');
    badClient('{"type":"seat","x":1.5,"y":0.5}');
    badClient('{"type":"seat","x":-0.1,"y":0.5}');
    badClient('{"type":"sync"}');
    badClient('{"type":"sync","c0":null}');
    badClient('{"type":"clock","degraded":false,"rttMs":1}');
    badClient('{"type":"clock","ready":"yes","degraded":false,"rttMs":1}');
    badClient('{"type":"clock","ready":true,"degraded":false,"rttMs":-1}');
    badClient('{"type":"host"}');
    badClient('{"type":"positioning"}');
    badClient(
      '{"type":"positioning","config":{"targetWidthM":0,"venueWidthM":20,"venueDepthM":20}}',
    );
    badClient(
      '{"type":"positioning","config":{"targetWidthM":3,"venueWidthM":5000,"venueDepthM":20}}',
    );
    badClient('{"type":"host","showId":"a","code":"b"}');
  });
});

describe("parseServerMessage", () => {
  it("round-trips every server message type", () => {
    const messages: ServerMessage[] = [
      {
        type: "welcome",
        participantId: "p1",
        resumeToken: "tok",
        venue: TEST_VENUE,
        state: { participant: "connected", seat: null, T0: null },
        positioning: { targetWidthM: 3, venueWidthM: 20, venueDepthM: 20 },
      },
      {
        type: "welcome",
        participantId: "p1",
        resumeToken: "tok",
        venue: TEST_VENUE,
        state: { participant: "playing", seat: { x: 0.2, y: 0.3 }, T0: 99 },
        positioning: { targetWidthM: 3, venueWidthM: 20, venueDepthM: 20 },
      },
      { type: "sync", c0: 1, s1: 2 },
      {
        type: "schedule",
        events: [
          { tMs: 0, color: "#000000" },
          { tMs: 100, color: "#ffffff" },
        ],
        durationMs: 20_000,
      },
      { type: "start", T0: 12_345.5 },
      { type: "stop" },
      {
        type: "positioning",
        config: { targetWidthM: 3, venueWidthM: 20, venueDepthM: 20 },
      },
      {
        type: "session",
        code: "ABCDEF",
        joinUrl: "https://x.example/j/ABCDEF",
        showId: "test",
        venue: TEST_VENUE,
        T0: null,
        show: SHOW,
        positioning: { targetWidthM: 3, venueWidthM: 20, venueDepthM: 20 },
      },
      {
        type: "session",
        code: "ABCDEF",
        joinUrl: "https://x.example/j/ABCDEF",
        showId: "test",
        venue: TEST_VENUE,
        T0: 5,
        show: TEST_SHOW,
        positioning: { targetWidthM: 3, venueWidthM: 20, venueDepthM: 20 },
        hostToken: "secret",
      },
      {
        type: "participants",
        list: [
          {
            id: "p1",
            x: null,
            y: null,
            state: "connected",
            rttMs: null,
            degraded: false,
          },
          {
            id: "p2",
            x: 0.1,
            y: 0.2,
            state: "standby",
            rttMs: 40,
            degraded: true,
          },
        ],
      },
      { type: "error", reason: "unknown-session", message: "no session" },
      { type: "error", reason: "no-standby", message: "nobody ready" },
      { type: "error", reason: "show-running", message: "already" },
    ];
    for (const message of messages) {
      const result = parseServerMessage(encodeMessage(message));
      expect(result).toEqual({ ok: true, message });
    }
  });

  it("rejects malformed server messages", () => {
    expect(parseServerMessage('{"type":"start"}').ok).toBe(false);
    expect(
      parseServerMessage('{"type":"error","reason":"nope","message":"x"}').ok,
    ).toBe(false);
    expect(
      parseServerMessage(
        '{"type":"participants","list":[{"id":"p","state":"dancing"}]}',
      ).ok,
    ).toBe(false);
    const session = {
      type: "session",
      code: "ABCDEF",
      joinUrl: "https://x.example/j/ABCDEF",
      showId: "test",
      venue: TEST_VENUE,
      T0: null,
    };
    expect(parseServerMessage(JSON.stringify(session)).ok).toBe(false);
    const badClip = { ...SHOW.clips[0], shape: { kind: "circle" } };
    expect(
      parseServerMessage(
        JSON.stringify({ ...session, show: { ...SHOW, clips: [badClip] } }),
      ).ok,
    ).toBe(false);
  });
});

describe("parseMessage direction", () => {
  it("reads sync and start by direction", () => {
    expect(parseMessage('{"type":"start"}', "client").ok).toBe(true);
    expect(parseMessage('{"type":"start"}', "server").ok).toBe(false);
    expect(parseMessage('{"type":"sync","c0":1}', "client").ok).toBe(true);
    expect(parseMessage('{"type":"sync","c0":1}', "server").ok).toBe(false);
  });
});
