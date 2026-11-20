import { describe, expect, it } from "vitest";
import type { KeyValueStorage, SocketLike } from "@/lib/client-socket";
import {
  encodeMessage,
  type ClientMessage,
  type ServerMessage,
} from "@/lib/protocol";
import { TEST_VENUE } from "@/lib/test-show";
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
  };
  const client = new HostClient("abc234", deps);
  return {
    client,
    sockets,
    storage,
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
};

describe("HostClient", () => {
  it("re-attaches with the stored host token", () => {
    const t = setup();
    t.client.start();
    t.last().open();
    expect(t.last().sent).toEqual([
      { type: "host", code: "ABC234", hostToken: "secret" },
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
