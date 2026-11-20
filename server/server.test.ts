import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  ParticipantClient,
  participantScreen,
  type KeyValueStorage,
  type ParticipantClientDeps,
  type SocketLike,
} from "@/app/j/[code]/participant-client";
import {
  HostClient,
  createHostedSession,
  hostStorageKey,
  type HostClientDeps,
} from "@/app/sessions/host-client";
import { rawUpgrade } from "./testing/raw-upgrade";
import { TestClient } from "./testing/ws-client";
import { spawnServer, type SpawnedServer } from "./testing/spawn-server";

let server: SpawnedServer;

beforeAll(async () => {
  server = await spawnServer();
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(String(data)));
    ws.once("error", reject);
    ws.once("close", () => reject(new Error("socket closed")));
  });
}

async function expectHmrSocketWorks(): Promise<void> {
  const url = server.httpUrl.replace("http", "ws") + "/_next/hmr";
  const ws = await openSocket(url);
  const first = JSON.parse(await nextMessage(ws)) as { type: string };
  expect(typeof first.type).toBe("string");
  ws.close();
}

describe("custom server", () => {
  it("serves the home page over HTTP", async () => {
    const res = await fetch(`${server.httpUrl}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Aurora");
  }, 60_000);

  it("leaves the Next HMR socket working after a page load", async () => {
    await expectHmrSocketWorks();
    expect(server.output()).not.toContain("Error handling upgrade request");
  }, 30_000);

  it("runs the join flow over /ws", async () => {
    const host = await TestClient.connect(server.wsUrl);
    host.send({ type: "host", showId: "test" });
    const { code } = await host.next("session");

    const phone = await TestClient.connect(server.wsUrl);
    phone.send({ type: "join", code });
    await phone.next("welcome");
    phone.send({ type: "seat", x: 0.5, y: 0.5 });
    phone.send({ type: "ready" });
    expect((await phone.next("schedule")).events.length).toBeGreaterThan(0);

    await Promise.all([host.close(), phone.close()]);
  });

  it("rejects upgrades on unknown paths and closes the socket", async () => {
    const result = await rawUpgrade(server.port, "/nope");
    expect(result.response).toBe("HTTP/1.1 404 Not Found\r\n\r\n");
    expect(result.closed).toBe(true);
    expect(server.output()).not.toContain("Error handling upgrade request");
  });
});

/** Deps that drive `ParticipantClient` with Node's built-in WebSocket. */
function nodeParticipantDeps(url: string): {
  deps: ParticipantClientDeps;
  sockets: SocketLike[];
} {
  const sockets: SocketLike[] = [];
  const map = new Map<string, string>();
  const storage: KeyValueStorage = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
  return {
    sockets,
    deps: {
      wsUrl: url,
      createSocket: (u) => {
        const socket = new globalThis.WebSocket(u);
        sockets.push(socket);
        return socket;
      },
      storage,
      random: () => 0,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      connectDelayMaxMs: 800,
      reconnectBaseMs: 50,
      reconnectMaxMs: 200,
    },
  };
}

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("participant page", () => {
  it("serves /j/<code> with 200", async () => {
    const host = await TestClient.connect(server.wsUrl);
    host.send({ type: "host", showId: "test" });
    const { code } = await host.next("session");
    const res = await fetch(`${server.httpUrl}/j/${code}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Connecting");
    await host.close();
  }, 60_000);

  it("ParticipantClient joins, seats, readies, and resumes after a drop", async () => {
    const host = await TestClient.connect(server.wsUrl);
    host.send({ type: "host", showId: "test" });
    const { code } = await host.next("session");

    const { deps, sockets } = nodeParticipantDeps(server.wsUrl);
    const client = new ParticipantClient(code.toLowerCase(), deps);
    client.start();
    try {
      await until(() => participantScreen(client.getSnapshot()) === "seat");
      const id = client.getSnapshot().participantId;
      expect(client.getSnapshot().venue?.shapes).toHaveLength(2);

      client.setSeat({ x: 0.3, y: 0.6 });
      client.ready();
      await until(() => participantScreen(client.getSnapshot()) === "standby");

      // The host's throttled summary reaches standby with the seat.
      let latest = await host.next("participants");
      while (latest.list.find((p) => p.id === id)?.state !== "standby") {
        latest = await host.next("participants");
      }
      expect(latest.list).toContainEqual(
        expect.objectContaining({ id, x: 0.3, y: 0.6, state: "standby" }),
      );

      // Drop the socket: the client reconnects and resumes the same id.
      sockets[0]!.close();
      await until(() => sockets.length === 2);
      await until(
        () =>
          client.getSnapshot().connection === "open" &&
          client.getSnapshot().schedule !== null,
      );
      expect(client.getSnapshot().participantId).toBe(id);
      expect(participantScreen(client.getSnapshot())).toBe("standby");
      latest = await host.next("participants");
      while (latest.list.find((p) => p.id === id)?.state !== "standby") {
        latest = await host.next("participants");
      }
      expect(latest.list).toHaveLength(1);
    } finally {
      client.stop();
      await host.close();
    }
  });

  it("ParticipantClient shows not-found for an unknown code", async () => {
    const { deps } = nodeParticipantDeps(server.wsUrl);
    const client = new ParticipantClient("ZZZZZZ", deps);
    client.start();
    await until(() => client.getSnapshot().fatal !== null);
    expect(participantScreen(client.getSnapshot())).toBe("not-found");
    expect(client.getSnapshot().connection).toBe("closed");
  });
});

/** Deps that drive `HostClient` with Node's built-in WebSocket. */
function nodeHostDeps(url: string): HostClientDeps {
  const map = new Map<string, string>();
  return {
    wsUrl: url,
    createSocket: (u) => new globalThis.WebSocket(u),
    storage: {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    },
    random: () => 0,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    reconnectBaseMs: 50,
    reconnectMaxMs: 200,
  };
}

describe("host page", () => {
  it("creates a session and serves /sessions/<code>/host with 200", async () => {
    const deps = nodeHostDeps(server.wsUrl);
    const code = await createHostedSession("test", deps);
    expect(deps.storage!.getItem(hostStorageKey(code))).toBeTruthy();
    const res = await fetch(`${server.httpUrl}/sessions/${code}/host`);
    expect(res.status).toBe(200);
  }, 60_000);

  it("HostClient re-attaches with its token and sees participants reach standby", async () => {
    const deps = nodeHostDeps(server.wsUrl);
    const code = await createHostedSession("test", deps);
    const host = new HostClient(code, deps);
    host.start();
    const phone = await TestClient.connect(server.wsUrl);
    try {
      await until(() => host.getSnapshot().session !== null);
      expect(host.getSnapshot().session?.joinUrl).toMatch(
        new RegExp(`/j/${code}$`),
      );

      phone.send({ type: "join", code });
      const { participantId } = await phone.next("welcome");
      await until(() =>
        host.getSnapshot().participants.some((p) => p.id === participantId),
      );
      phone.send({ type: "seat", x: 0.7, y: 0.4 });
      phone.send({ type: "ready" });
      await until(
        () => host.getSnapshot().participants[0]?.state === "standby",
      );
      expect(host.getSnapshot().participants).toEqual([
        {
          id: participantId,
          x: 0.7,
          y: 0.4,
          state: "standby",
          rttMs: null,
          degraded: false,
        },
      ]);

      await phone.close();
      await until(
        () => host.getSnapshot().participants[0]?.state === "disconnected",
      );
    } finally {
      host.stop();
      await phone.close();
    }
  });

  it("HostClient without the right token is not the host", async () => {
    const creator = nodeHostDeps(server.wsUrl);
    const code = await createHostedSession("test", creator);

    const noToken = new HostClient(code, nodeHostDeps(server.wsUrl));
    noToken.start();
    expect(noToken.getSnapshot().fatal).toBe("no-token");

    const wrongDeps = nodeHostDeps(server.wsUrl);
    wrongDeps.storage!.setItem(hostStorageKey(code), "not-the-token");
    const wrong = new HostClient(code, wrongDeps);
    wrong.start();
    await until(() => wrong.getSnapshot().fatal !== null);
    expect(wrong.getSnapshot().fatal).toBe("not-host");
    expect(wrong.getSnapshot().session).toBeNull();
  });
});
