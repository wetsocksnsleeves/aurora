import { describe, expect, it } from "vitest";
import type { KeyValueStorage, SocketLike } from "@/lib/client-socket";
import {
  encodeMessage,
  type ClientMessage,
  type ServerMessage,
} from "@/lib/protocol";
import { CLOCK_SYNC } from "@/lib/clock-sync";
import { FakeTime } from "@/lib/fake-time";
import { TEST_SHOW, TEST_VENUE } from "@/lib/test-show";
import {
  HostClient,
  createHostedSession,
  hostStorageKey,
  readHostToken,
  type HostClientDeps,
} from "./host-client";

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: ClientMessage[] = [];
  closed = false;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientMessage);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(message: ServerMessage) {
    this.onmessage?.({ data: encodeMessage(message) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: "" });
  }
}

function memoryStorage(): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

function setup(token: string | null = "secret") {
  const storage = memoryStorage();
  if (token) storage.setItem(hostStorageKey("abc234"), token);
  const sockets: FakeSocket[] = [];
  const time = new FakeTime(5_000);
  let pending: (() => void) | null = null;
  const deps: HostClientDeps = {
    wsUrl: "ws://test/ws",
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    storage,
    random: () => 0,
    setTimeout: (fn) => {
      pending = fn;
      return 1;
    },
    clearTimeout: () => {
      pending = null;
    },
    reconnectBaseMs: 500,
    reconnectMaxMs: 5_000,
    clock: time,
  };
  const client = new HostClient("abc234", deps);
  return {
    client,
    sockets,
    storage,
    time,
    last: () => sockets[sockets.length - 1]!,
    runTimer: () => {
      const fn = pending;
      pending = null;
      fn?.();
    },
  };
}

const session: ServerMessage = {
  type: "session",
  code: "ABC234",
  joinUrl: "https://x.example/j/ABC234",
  showId: "test",
  venue: TEST_VENUE,
  T0: null,
  show: TEST_SHOW,
  positioning: { targetWidthM: 3, venueWidthM: 20, venueDepthM: 20 },
};

describe("HostClient", () => {
  it("re-attaches with the stored host token", () => {
    const t = setup();
    t.client.start();
    t.last().open();
    expect(t.last().sent).toEqual([
      { type: "host", code: "ABC234", hostToken: "secret" },
      { type: "sync", c0: 5_000 },
    ]);
    t.last().receive(session);
    t.last().receive({
      type: "participants",
      list: [
        {
          id: "p1",
          x: 0.2,
          y: 0.3,
          state: "seated",
          rttMs: null,
          degraded: false,
        },
      ],
    });
    const s = t.client.getSnapshot();
    expect(s.session?.joinUrl).toBe("https://x.example/j/ABC234");
    expect(s.participants).toHaveLength(1);
    expect(s.fatal).toBeNull();
  });

  it("reports no-token without connecting when this tab has no token", () => {
    const t = setup(null);
    t.client.start();
    expect(t.sockets).toHaveLength(0);
    expect(t.client.getSnapshot().fatal).toBe("no-token");
  });

  it("stops on not-host and unknown-session", () => {
    for (const reason of ["not-host", "unknown-session"] as const) {
      const t = setup();
      t.client.start();
      t.last().open();
      t.last().receive({ type: "error", reason, message: "x" });
      expect(t.client.getSnapshot().fatal).toBe(reason);
      expect(t.last().closed).toBe(true);
    }
  });

  it("reconnects after a drop and re-attaches", () => {
    const t = setup();
    t.client.start();
    t.last().open();
    t.last().receive(session);
    t.last().drop();
    expect(t.client.getSnapshot().connection).toBe("reconnecting");
    t.runTimer();
    expect(t.sockets).toHaveLength(2);
    t.last().open();
    expect(t.last().sent[0]).toMatchObject({ hostToken: "secret" });
  });

  it("sends start and stop and tracks T0 and refusals", () => {
    const t = setup();
    t.client.start();
    t.last().open();
    t.last().receive(session);
    expect(t.client.startShow()).toBe(true);
    t.last().receive({
      type: "error",
      reason: "no-standby",
      message: "no participant is in standby yet",
    });
    expect(t.client.getSnapshot().lastError).toMatch(/standby/);
    expect(t.client.getSnapshot().fatal).toBeNull();
    t.client.startShow();
    t.last().receive({ type: "start", T0: 9_000 });
    expect(t.client.getSnapshot()).toMatchObject({
      T0: 9_000,
      lastError: null,
    });
    t.client.stopShow();
    t.last().receive({ type: "stop" });
    expect(t.client.getSnapshot().T0).toBeNull();
    expect(
      t.last().sent.filter((m) => m.type === "start" || m.type === "stop"),
    ).toEqual([{ type: "start" }, { type: "start" }, { type: "stop" }]);
  });

  it("runs its own ClockSync over sync messages", () => {
    const t = setup();
    t.client.start();
    t.last().open();
    t.last().receive(session);
    let answered = 0;
    for (let i = 0; i < CLOCK_SYNC.burstCount && !t.client.clock.ready; i++) {
      const pings = t.last().sent.filter((m) => m.type === "sync");
      for (const ping of pings.slice(answered)) {
        t.last().receive({ type: "sync", c0: ping.c0, s1: ping.c0 + 777 });
      }
      answered = pings.length;
      t.time.advance(CLOCK_SYNC.burstIntervalMs);
    }
    expect(t.client.getSnapshot().clockReady).toBe(true);
    expect(t.client.clock.serverNow()).toBe(t.time.now() + 777);
    // The host never reports its clock to the server.
    expect(t.last().sent.some((m) => m.type === "clock")).toBe(false);

    t.client.setVisible(true);
    expect(t.client.getSnapshot().clockReady).toBe(false);

    t.client.stop();
    expect(t.time.intervalCount + t.time.timeoutCount).toBe(0);
  });
});

describe("createHostedSession", () => {
  it("stores the host token under the code and resolves the code", async () => {
    const storage = memoryStorage();
    const socket = new FakeSocket();
    const promise = createHostedSession("test", {
      wsUrl: "ws://test/ws",
      createSocket: () => socket,
      storage,
    });
    socket.open();
    expect(socket.sent).toEqual([{ type: "host", showId: "test" }]);
    socket.receive({ ...session, hostToken: "tok" });
    await expect(promise).resolves.toBe("ABC234");
    expect(readHostToken(storage, "abc234")).toBe("tok");
    expect(socket.closed).toBe(true);
  });

  it("rejects on a server error", async () => {
    const socket = new FakeSocket();
    const promise = createHostedSession("nope", {
      wsUrl: "ws://test/ws",
      createSocket: () => socket,
      storage: null,
    });
    socket.open();
    socket.receive({
      type: "error",
      reason: "unknown-show",
      message: 'no show "nope"',
    });
    await expect(promise).rejects.toThrow('no show "nope"');
  });
});
