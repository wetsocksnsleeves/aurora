import { describe, expect, it } from "vitest";
import {
  encodeMessage,
  type ClientMessage,
  type ServerMessage,
} from "@/lib/protocol";
import { CLOCK_SYNC } from "@/lib/clock-sync";
import { FakeTime } from "@/lib/fake-time";
import { TEST_VENUE } from "@/lib/test-show";
import {
  CLOSE_REPLACED,
  ParticipantClient,
  participantScreen,
  storageKey,
  type KeyValueStorage,
  type ParticipantClientDeps,
  type SocketLike,
} from "./participant-client";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: ClientMessage[] = [];
  closedWith: number | null = null;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }
  /** Sent messages other than clock pings. */
  get msgs(): ClientMessage[] {
    return this.sent.filter((m) => m.type !== "sync");
  }
  /** `clock` reports sent. */
  get clockReports(): ClientMessage[] {
    return this.sent.filter((m) => m.type === "clock");
  }
  private answered = 0;
  /** Answer every unanswered `sync` now, as a server `offsetMs` ahead. */
  answerSyncs(offsetMs = 1_000): void {
    const pings = this.sent.filter((m) => m.type === "sync");
    for (const ping of pings.slice(this.answered)) {
      this.receive({ type: "sync", c0: ping.c0, s1: ping.c0 + offsetMs });
    }
    this.answered = pings.length;
  }
  close(code = 1000): void {
    this.closedWith = code;
    this.readyState = 3;
  }
  // Test controls
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: ServerMessage): void {
    this.onmessage?.({ data: encodeMessage(message) });
  }
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
}

class MemoryStorage implements KeyValueStorage {
  readonly map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
}

/** Manual timers: `tick()` runs the pending timer and returns its delay. */
function setup(storage = new MemoryStorage(), random = () => 0.5) {
  const sockets: FakeSocket[] = [];
  const time = new FakeTime(10_000);
  let pending: { fn: () => void; ms: number; id: number } | null = null;
  let nextId = 1;
  const deps: ParticipantClientDeps = {
    wsUrl: "ws://test/ws",
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    storage,
    random,
    setTimeout: (fn, ms) => {
      pending = { fn, ms, id: nextId++ };
      return pending.id;
    },
    clearTimeout: (id) => {
      if (pending?.id === id) pending = null;
    },
    connectDelayMaxMs: 800,
    reconnectBaseMs: 500,
    reconnectMaxMs: 5_000,
    clock: time,
  };
  const client = new ParticipantClient("abc234", deps);
  return {
    client,
    sockets,
    storage,
    time,
    /** Answer pings as the burst goes out until the clock is ready. */
    syncClock: (offsetMs = 1_000) => {
      for (let i = 0; i < CLOCK_SYNC.burstCount; i++) {
        sockets[sockets.length - 1]!.answerSyncs(offsetMs);
        if (client.clock.ready) return;
        time.advance(CLOCK_SYNC.burstIntervalMs);
      }
      throw new Error("clock did not become ready");
    },
    last: () => sockets[sockets.length - 1]!,
    pendingDelay: () => pending?.ms ?? null,
    tick: () => {
      const p = pending;
      if (!p) throw new Error("no timer pending");
      pending = null;
      p.fn();
      return p.ms;
    },
  };
}

function welcome(
  overrides: Partial<Extract<ServerMessage, { type: "welcome" }>> = {},
): ServerMessage {
  return {
    type: "welcome",
    participantId: "p1",
    resumeToken: "tok1",
    venue: TEST_VENUE,
    state: { participant: "connected", seat: null, T0: null },
    positioning: { targetWidthM: 3, venueWidthM: 20, venueDepthM: 20 },
    ...overrides,
  };
}

const schedule: ServerMessage = {
  type: "schedule",
  events: [{ tMs: 0, color: "#000000" }],
  durationMs: 1000,
};

describe("ParticipantClient", () => {
  it("waits a random 0..800 ms, then connects and joins", () => {
    const t = setup(new MemoryStorage(), () => 0.25);
    t.client.start();
    expect(t.sockets).toHaveLength(0);
    expect(t.pendingDelay()).toBe(200);
    t.tick();
    expect(t.client.getSnapshot().connection).toBe("connecting");
    t.last().open();
    expect(t.last().sent).toEqual([
      { type: "join", code: "ABC234" },
      { type: "sync", c0: 10_000 },
    ]);
    expect(participantScreen(t.client.getSnapshot())).toBe("connecting");
  });

  it("walks seat → syncing → standby and stores the resume token", () => {
    const t = setup();
    t.client.start();
    t.tick();
    t.last().open();
    t.last().receive(welcome());
    expect(t.storage.getItem(storageKey("abc234"))).toBe(
      JSON.stringify({ participantId: "p1", resumeToken: "tok1" }),
    );
    expect(participantScreen(t.client.getSnapshot())).toBe("seat");

    t.client.ready(); // no seat yet: ignored
    expect(t.client.getSnapshot().readyTapped).toBe(false);

    t.client.setSeat({ x: 0.2, y: 0.5 });
    t.client.ready();
    expect(t.last().msgs.slice(1)).toEqual([
      { type: "seat", x: 0.2, y: 0.5 },
      { type: "ready" },
    ]);
    expect(participantScreen(t.client.getSnapshot())).toBe("syncing");

    t.last().receive(schedule);
    // Schedule in, clock not ready: still syncing (SPEC 4.4).
    expect(participantScreen(t.client.getSnapshot())).toBe("syncing");
    t.syncClock();
    expect(participantScreen(t.client.getSnapshot())).toBe("standby");

    // Moving the seat after Ready waits for a new schedule.
    t.client.setSeat({ x: 0.3, y: 0.5 });
    expect(participantScreen(t.client.getSnapshot())).toBe("syncing");
  });

  it("reconnects with backoff and resumes with id and token", () => {
    const t = setup();
    t.client.start();
    t.tick();
    t.last().open();
    t.last().receive(welcome());
    t.client.setSeat({ x: 0.2, y: 0.5 });
    t.client.ready();
    t.last().receive(schedule);
    t.syncClock();

    t.last().drop();
    expect(t.client.getSnapshot().connection).toBe("reconnecting");
    // Still showing standby while reconnecting: the phone needs no network.
    expect(participantScreen(t.client.getSnapshot())).toBe("standby");
    expect(t.tick()).toBe(500 + 400);

    t.last().drop(); // the retry fails too
    expect(t.tick()).toBe(1000 + 400);

    t.last().open();
    expect(t.last().sent[0]).toEqual({
      type: "join",
      code: "ABC234",
      participantId: "p1",
      resumeToken: "tok1",
    });
    t.last().receive(
      welcome({
        state: { participant: "standby", seat: { x: 0.2, y: 0.5 }, T0: null },
      }),
    );
    // The server kept seat and ready, so only the clock is reported again.
    expect(t.last().msgs).toEqual([
      expect.objectContaining({ type: "join" }),
      expect.objectContaining({ type: "clock", ready: true }),
    ]);
    expect(participantScreen(t.client.getSnapshot())).toBe("standby");

    // Backoff resets after a welcome.
    t.last().drop();
    expect(t.tick()).toBe(500 + 400);
  });

  it("resends seat and ready if the server gave a new participant", () => {
    const t = setup();
    t.client.start();
    t.tick();
    t.last().open();
    t.last().receive(welcome());
    t.client.setSeat({ x: 0.7, y: 0.4 });
    t.client.ready();
    t.last().drop();
    t.tick();
    t.last().open();
    t.last().receive(
      welcome({ participantId: "p2", resumeToken: "tok2" }), // expired
    );
    expect(t.last().msgs.slice(1)).toEqual([
      { type: "seat", x: 0.7, y: 0.4 },
      { type: "ready" },
    ]);
    expect(t.client.getSnapshot().participantId).toBe("p2");
    expect(participantScreen(t.client.getSnapshot())).toBe("syncing");
  });

  it("restores seat and ready from the server after a page reload", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      storageKey("ABC234"),
      JSON.stringify({ participantId: "p1", resumeToken: "tok1" }),
    );
    const t = setup(storage);
    t.client.start();
    t.tick();
    t.last().open();
    expect(t.last().sent[0]).toMatchObject({ participantId: "p1" });
    t.last().receive(
      welcome({
        state: { participant: "syncing", seat: { x: 0.1, y: 0.3 }, T0: null },
      }),
    );
    const s = t.client.getSnapshot();
    expect(s.seat).toEqual({ x: 0.1, y: 0.3 });
    expect(s.readyTapped).toBe(true);
    expect(t.last().msgs).toHaveLength(1);
    t.last().receive(schedule);
    t.syncClock();
    expect(participantScreen(t.client.getSnapshot())).toBe("standby");
  });

  it("stops on an unknown session", () => {
    const t = setup();
    t.client.start();
    t.tick();
    t.last().open();
    t.last().receive({
      type: "error",
      reason: "unknown-session",
      message: "no session",
    });
    expect(participantScreen(t.client.getSnapshot())).toBe("not-found");
    expect(t.client.getSnapshot().connection).toBe("closed");
    expect(t.pendingDelay()).toBeNull();
  });

  it("stops when another tab takes over the participant", () => {
    const t = setup();
    t.client.start();
    t.tick();
    t.last().open();
    t.last().receive(welcome());
    t.last().drop(CLOSE_REPLACED);
    expect(participantScreen(t.client.getSnapshot())).toBe("replaced");
    expect(t.pendingDelay()).toBeNull();
  });

  it("tells listeners about opens, messages and closes", () => {
    const t = setup();
    const events: string[] = [];
    t.client.addListener({
      onOpen: () => events.push("open"),
      onMessage: (m) => events.push(m.type),
      onClose: (again) => events.push(`close:${again}`),
    });
    t.client.start();
    t.tick();
    t.last().open();
    t.last().receive(welcome());
    t.last().drop();
    t.client.stop();
    expect(events).toEqual(["open", "welcome", "close:true"]);
    expect(t.client.getSnapshot().connection).toBe("closed");
    expect(t.pendingDelay()).toBeNull();
  });

  it("tracks start and stop", () => {
    const t = setup();
    t.client.start();
    t.tick();
    t.last().open();
    t.last().receive(welcome());
    t.client.setSeat({ x: 0.2, y: 0.5 });
    t.client.ready();
    t.last().receive(schedule);
    t.syncClock();
    t.last().receive({ type: "start", T0: 12_345 });
    expect(t.client.getSnapshot().T0).toBe(12_345);
    expect(participantScreen(t.client.getSnapshot())).toBe("playing");
    // Stop goes back to standby, ready for another start.
    t.last().receive({ type: "stop" });
    expect(t.client.getSnapshot().T0).toBeNull();
    expect(participantScreen(t.client.getSnapshot())).toBe("standby");
  });
});

describe("ParticipantClient clock sync", () => {
  /** Joined, seated, ready, schedule in. */
  function joined() {
    const t = setup();
    t.client.start();
    t.tick();
    t.last().open();
    t.last().receive(welcome());
    t.client.setSeat({ x: 0.2, y: 0.5 });
    t.client.ready();
    t.last().receive(schedule);
    return t;
  }

  it("bursts 14 pings on open, then pings every 20 s", () => {
    const t = setup();
    t.client.start();
    t.tick();
    t.last().open();
    const pings = () => t.last().sent.filter((m) => m.type === "sync").length;
    expect(pings()).toBe(1);
    t.time.advance(CLOCK_SYNC.burstIntervalMs * 13);
    expect(pings()).toBe(CLOCK_SYNC.burstCount);
    t.time.advance(CLOCK_SYNC.burstIntervalMs * 10);
    expect(pings()).toBe(CLOCK_SYNC.burstCount);
    t.time.advance(CLOCK_SYNC.steadyIntervalMs);
    expect(pings()).toBe(CLOCK_SYNC.burstCount + 1);
  });

  it("estimates the server clock from sync replies", () => {
    const t = joined();
    t.syncClock(2_500);
    expect(t.client.clock.serverNow()).toBe(t.time.now() + 2_500);
    expect(t.client.getSnapshot().clockReady).toBe(true);
    expect(t.client.getSnapshot().clockDegraded).toBe(false);
  });

  it("reports clock status changes to the server once joined", () => {
    const t = setup();
    t.client.start();
    t.tick();
    t.last().open();
    // Replies before welcome: nothing is reported yet.
    t.last().answerSyncs();
    expect(t.last().clockReports).toEqual([]);
    t.last().receive(welcome());
    expect(t.last().clockReports).toEqual([]);
    t.syncClock();
    expect(t.last().clockReports).toEqual([
      { type: "clock", ready: true, degraded: false, rttMs: 0 },
    ]);
    // Further replies with the same status send nothing more.
    t.time.advance(CLOCK_SYNC.steadyIntervalMs);
    t.last().answerSyncs();
    expect(t.last().clockReports).toHaveLength(1);
  });

  it("falls back to degraded after 6 s and reports it", () => {
    const t = joined();
    // Replies with RTT 500 ms never pass the 400 ms gate.
    const sock = t.last();
    let answered = 0;
    for (let i = 0; i < 100; i++) {
      const pings = sock.sent.filter((m) => m.type === "sync");
      for (const ping of pings.slice(answered)) {
        const c0 = ping.c0;
        t.time.setTimeout(
          () => sock.receive({ type: "sync", c0, s1: c0 + 250 }),
          500,
        );
      }
      answered = pings.length;
      t.time.advance(CLOCK_SYNC.burstIntervalMs);
    }
    expect(t.client.getSnapshot().clockReady).toBe(true);
    expect(t.client.getSnapshot().clockDegraded).toBe(true);
    expect(sock.clockReports).toEqual([
      { type: "clock", ready: true, degraded: true, rttMs: 500 },
    ]);
    expect(participantScreen(t.client.getSnapshot())).toBe("standby");
  });

  it("returning to visible clears the clock, goes dark, and bursts again", () => {
    const t = joined();
    t.syncClock();
    expect(participantScreen(t.client.getSnapshot())).toBe("standby");
    const before = t.last().sent.length;

    t.client.setVisible(false);
    expect(t.client.clock.ready).toBe(true);

    t.client.setVisible(true);
    expect(t.client.clock.ready).toBe(false);
    expect(t.client.clock.sampleCount).toBe(0);
    expect(participantScreen(t.client.getSnapshot())).toBe("syncing");
    expect(t.last().sent.slice(before)).toEqual([
      { type: "clock", ready: false, degraded: false, rttMs: null },
      { type: "sync", c0: t.time.now() },
    ]);

    t.syncClock();
    expect(participantScreen(t.client.getSnapshot())).toBe("standby");
    expect(t.last().clockReports.at(-1)).toMatchObject({ ready: true });
  });

  it("a reload mid-show resumes playing from welcome's T0", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      storageKey("ABC234"),
      JSON.stringify({ participantId: "p1", resumeToken: "tok1" }),
    );
    const t = setup(storage);
    t.client.start();
    t.tick();
    t.last().open();
    t.last().receive(
      welcome({
        state: {
          participant: "syncing",
          seat: { x: 0.1, y: 0.3 },
          T0: 4_000,
        },
      }),
    );
    t.last().receive(schedule);
    expect(t.client.getSnapshot().T0).toBe(4_000);
    // Playing screen at once; it paints black until the clock is ready.
    expect(participantScreen(t.client.getSnapshot())).toBe("playing");
    t.syncClock();
    expect(t.client.clock.serverNow() - 4_000).toBeGreaterThan(0);
  });

  it("stays dark (playing screen) while the clock resyncs during a show", () => {
    const t = joined();
    t.syncClock();
    t.last().receive({ type: "start", T0: 50_000 });
    t.client.setVisible(true);
    expect(t.client.getSnapshot().clockReady).toBe(false);
    expect(participantScreen(t.client.getSnapshot())).toBe("playing");
  });

  it("stops clock timers on close and restarts the burst on reconnect", () => {
    const t = joined();
    t.syncClock();
    t.time.advance(CLOCK_SYNC.burstIntervalMs * CLOCK_SYNC.burstCount);
    expect(t.time.intervalCount).toBe(1); // steady ping
    t.last().drop();
    expect(t.time.intervalCount).toBe(0);
    // The reconnect delay is on the client's own timer, not the clock's.
    t.tick();
    t.last().open();
    expect(t.last().sent.filter((m) => m.type === "sync")).toHaveLength(1);
    expect(t.time.intervalCount).toBe(1); // burst
    // The clock stayed ready, so standby holds through the reconnect.
    expect(t.client.clock.ready).toBe(true);
    t.client.stop();
    expect(t.time.intervalCount).toBe(0);
    expect(t.time.timeoutCount).toBe(0);
  });
});
