import { describe, expect, it } from "vitest";
import {
  encodeMessage,
  type ClientMessage,
  type ServerMessage,
} from "@/lib/protocol";
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
  };
  const client = new ParticipantClient("abc234", deps);
  return {
    client,
    sockets,
    storage,
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
    expect(t.last().sent).toEqual([{ type: "join", code: "ABC234" }]);
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
    expect(t.last().sent.slice(1)).toEqual([
      { type: "seat", x: 0.2, y: 0.5 },
      { type: "ready" },
    ]);
    expect(participantScreen(t.client.getSnapshot())).toBe("syncing");

    t.last().receive(schedule);
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
    // The server kept everything, so nothing is resent.
    expect(t.last().sent).toHaveLength(1);
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
    expect(t.last().sent.slice(1)).toEqual([
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
    expect(t.last().sent).toHaveLength(1);
    t.last().receive(schedule);
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
    t.last().receive({ type: "start", T0: 12_345 });
    expect(participantScreen(t.client.getSnapshot())).toBe("playing");
    t.last().receive({ type: "stop" });
    expect(participantScreen(t.client.getSnapshot())).toBe("over");
  });
});
