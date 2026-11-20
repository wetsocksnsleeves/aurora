import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocketServer } from "ws";
import { compileSchedule } from "@/lib/compile";
import {
  TEST_SHOW,
  TEST_SHOW_DURATION_MS,
  testSchedule,
} from "@/lib/test-show";
import type { Show } from "@/lib/types";
import { closeCompilePool, compileInWorker } from "./compile-pool";
import { SessionStore } from "./sessions";
import { rawUpgrade } from "./testing/raw-upgrade";
import { TestClient } from "./testing/ws-client";
import {
  attachWebSocketServer,
  type AttachOptions,
  type UpgradeHandler,
} from "./ws";

let server: Server | undefined;
let wss: WebSocketServer | undefined;
let clients: TestClient[] = [];

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
  wss?.close();
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
  wss = undefined;
});

afterAll(() => closeCompilePool());

const noop: UpgradeHandler = () => {};

/**
 * A show whose schedule takes a few hundred ms to compile on one thread: a
 * 10-minute track under 400 moving, fading polygons.
 */
const HEAVY_SHOW: Show = {
  ...TEST_SHOW,
  audio: { fileId: "", durationMs: 600_000 },
  clips: Array.from({ length: 400 }, (_, i) => ({
    id: `c${i}`,
    layer: i,
    startMs: 0,
    endMs: 600_000,
    color: "#ff0000",
    fadeInMs: 1_000,
    fadeOutMs: 1_000,
    shape: {
      kind: "polygon" as const,
      points: [
        { x: 0, y: 0 },
        { x: 0.2, y: 0 },
        { x: 0.2, y: 0.2 },
        { x: 0, y: 0.2 },
      ],
      moveTo: { x: 0.8, y: 0.8 },
    },
  })),
};

async function listen(
  options: Partial<AttachOptions> = {},
): Promise<{ port: number; store: SessionStore; url: string }> {
  const store = options.store ?? new SessionStore();
  server = createServer((_req, res) => res.end("ok"));
  wss = attachWebSocketServer(server, {
    nextUpgrade: noop,
    forwardNextUpgrades: true,
    publicUrl: "https://aurora.example",
    ...options,
    store,
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { port, store, url: `ws://127.0.0.1:${port}/ws` };
}

async function connect(url: string): Promise<TestClient> {
  const client = await TestClient.connect(url);
  clients.push(client);
  return client;
}

/** What a phone's ClockSync reports once the ready gate passes. */
const CLOCK_READY = {
  type: "clock",
  ready: true,
  degraded: false,
  rttMs: 12,
} as const;

/** A host with a fresh test-show session. */
async function hostSession(url: string) {
  const host = await connect(url);
  host.send({ type: "host", showId: "test" });
  const session = await host.next("session");
  await host.next("participants");
  return { host, code: session.code, hostToken: session.hostToken };
}

describe("attachWebSocketServer upgrade routing", () => {
  it("rejects an unknown path with 404 and closes the socket", async () => {
    const nextUpgrade = vi.fn(noop);
    const { port } = await listen({ nextUpgrade });
    const result = await rawUpgrade(port, "/nope");
    expect(result.response).toBe("HTTP/1.1 404 Not Found\r\n\r\n");
    expect(result.closed).toBe(true);
    expect(nextUpgrade).not.toHaveBeenCalled();
  });

  it("forwards /_next/* to Next when enabled (dev)", async () => {
    const nextUpgrade = vi.fn<UpgradeHandler>((_req, socket) => {
      socket.destroy();
    });
    const { port } = await listen({ nextUpgrade });
    await rawUpgrade(port, "/_next/hmr");
    expect(nextUpgrade).toHaveBeenCalledOnce();
  });

  it("rejects /_next/* with 404 when forwarding is off (production)", async () => {
    const nextUpgrade = vi.fn(noop);
    const { port } = await listen({ nextUpgrade, forwardNextUpgrades: false });
    const result = await rawUpgrade(port, "/_next/hmr");
    expect(result.response).toBe("HTTP/1.1 404 Not Found\r\n\r\n");
    expect(result.closed).toBe(true);
    expect(nextUpgrade).not.toHaveBeenCalled();
  });

  it("destroys the socket when Next's handler throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { port } = await listen({
      nextUpgrade: () => {
        throw new Error("boom");
      },
    });
    const result = await rawUpgrade(port, "/_next/hmr");
    expect(result.closed).toBe(true);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("destroys the socket when Next's handler rejects", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { port } = await listen({
      nextUpgrade: async () => {
        throw new Error("boom");
      },
    });
    const result = await rawUpgrade(port, "/_next/hmr");
    expect(result.closed).toBe(true);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("message routing", () => {
  it("host creates a session and gets a join URL and an empty list", async () => {
    const { url, store } = await listen();
    const host = await connect(url);
    host.send({ type: "host", showId: "test" });
    const session = await host.next("session");
    expect(session.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(session.joinUrl).toBe(`https://aurora.example/j/${session.code}`);
    expect(session.showId).toBe("test");
    expect(session.venue.shapes).toHaveLength(2);
    expect(session.T0).toBeNull();
    expect(await host.next("participants")).toEqual({
      type: "participants",
      list: [],
    });
    expect(store.getSession(session.code)).toBeDefined();
  });

  it("falls back to the connection origin when no public URL is set", async () => {
    const previous = process.env.PUBLIC_URL;
    delete process.env.PUBLIC_URL;
    try {
      const { url, port } = await listen({ publicUrl: undefined });
      const host = await connect(url);
      host.send({ type: "host", showId: "test" });
      const session = await host.next("session");
      expect(session.joinUrl).toBe(
        `http://127.0.0.1:${port}/j/${session.code}`,
      );
    } finally {
      if (previous !== undefined) process.env.PUBLIC_URL = previous;
    }
  });

  it("gives the creating host a host token", async () => {
    const { url, store } = await listen();
    const { code, hostToken } = await hostSession(url);
    expect(hostToken).toBe(store.getSession(code)!.hostToken);
    expect(hostToken).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
  });

  it("host can re-attach to an existing session with its token", async () => {
    const { url } = await listen();
    const { code, hostToken } = await hostSession(url);
    const second = await connect(url);
    second.send({ type: "host", code: code.toLowerCase(), hostToken });
    const session = await second.next("session");
    expect(session.code).toBe(code);
    // Re-attaching hosts already hold the token; it is not resent.
    expect(session.hostToken).toBeUndefined();
    await second.next("participants");
  });

  it("refuses to re-attach a host without the right token", async () => {
    const { url } = await listen({ participantsThrottleMs: 0 });
    const { host, code } = await hostSession(url);

    const missing = await connect(url);
    missing.send({ type: "host", code });
    expect((await missing.next("error")).reason).toBe("not-host");

    const wrong = await connect(url);
    wrong.send({ type: "host", code, hostToken: "x".repeat(43) });
    expect((await wrong.next("error")).reason).toBe("not-host");

    // Refused sockets are not attached: they get no participant updates.
    const phone = await connect(url);
    phone.send({ type: "join", code });
    await phone.next("welcome");
    await host.next("participants");
    expect(missing.all("participants")).toHaveLength(0);
    expect(wrong.all("participants")).toHaveLength(0);
    expect(missing.all("session")).toHaveLength(0);
  });

  it("rejects an unknown show and an unknown session", async () => {
    const { url } = await listen();
    const host = await connect(url);
    host.send({ type: "host", showId: "nope" });
    expect((await host.next("error")).reason).toBe("unknown-show");

    const phone = await connect(url);
    phone.send({ type: "join", code: "ZZZZZZ" });
    expect((await phone.next("error")).reason).toBe("unknown-session");
  });

  it("answers bad JSON and out-of-order messages with an error", async () => {
    const { url } = await listen();
    const client = await connect(url);
    client.ws.send("{nope");
    expect((await client.next("error")).reason).toBe("bad-message");
    client.send({ type: "seat", x: 0.5, y: 0.5 });
    expect((await client.next("error")).reason).toBe("not-joined");
    client.send({ type: "ready" });
    expect((await client.next("error")).reason).toBe("not-joined");
  });

  it("join → seat → ready gives welcome, a schedule, and host updates", async () => {
    const { url } = await listen();
    const { host, code } = await hostSession(url);
    const phone = await connect(url);

    phone.send({ type: "join", code });
    const welcome = await phone.next("welcome");
    expect(welcome.state).toEqual({
      participant: "connected",
      seat: null,
      T0: null,
    });
    expect(welcome.venue.shapes).toHaveLength(2);
    const id = welcome.participantId;
    await expect(host.next("participants")).resolves.toMatchObject({
      list: [{ id, state: "connected", x: null, y: null }],
    });

    phone.send({ type: "ready" });
    expect((await phone.next("error")).reason).toBe("no-seat");

    phone.send({ type: "seat", x: 0.25, y: 0.5 });
    await expect(host.next("participants")).resolves.toMatchObject({
      list: [{ id, state: "seated", x: 0.25, y: 0.5 }],
    });

    phone.send({ type: "ready" });
    const schedule = await phone.next("schedule");
    expect(schedule.durationMs).toBe(TEST_SHOW_DURATION_MS);
    expect(schedule.events).toEqual(testSchedule({ x: 0.25, y: 0.5 }).events);

    // Schedule in, clock not ready yet: still syncing.
    let latest = await host.next("participants");
    while (latest.list[0]?.state !== "syncing") {
      latest = await host.next("participants");
    }

    phone.send(CLOCK_READY);
    // Throttled updates may merge states; standby must arrive.
    while (latest.list[0]?.state !== "standby") {
      latest = await host.next("participants");
    }
    expect(latest.list).toEqual([
      { id, x: 0.25, y: 0.5, state: "standby", rttMs: 12, degraded: false },
    ]);
  });

  it("moving the seat after Ready sends a new schedule", async () => {
    const { url } = await listen();
    const { code } = await hostSession(url);
    const phone = await connect(url);
    phone.send({ type: "join", code });
    await phone.next("welcome");
    phone.send({ type: "seat", x: 0.1, y: 0.5 });
    phone.send({ type: "ready" });
    await phone.next("schedule");
    phone.send({ type: "seat", x: 0.9, y: 0.5 });
    const moved = await phone.next("schedule");
    expect(moved.events).toEqual(testSchedule({ x: 0.9, y: 0.5 }).events);
  });

  it("reconnect with the previous participantId keeps the participant", async () => {
    const { url, store } = await listen();
    const { host, code } = await hostSession(url);

    const first = await connect(url);
    first.send({ type: "join", code });
    const { participantId, resumeToken } = await first.next("welcome");
    first.send({ type: "seat", x: 0.4, y: 0.6 });
    first.send({ type: "ready" });
    const schedule = await first.next("schedule");
    first.send(CLOCK_READY);
    await vi.waitFor(() =>
      expect(
        store.getSession(code)!.participants.get(participantId)?.state,
      ).toBe("standby"),
    );
    await first.close();

    const session = store.getSession(code)!;
    await vi.waitFor(() =>
      expect(session.participants.get(participantId)?.state).toBe(
        "disconnected",
      ),
    );
    let update = await host.next("participants");
    while (update.list[0]?.state !== "disconnected") {
      update = await host.next("participants");
    }

    const second = await connect(url);
    second.send({ type: "join", code, participantId, resumeToken });
    const welcome = await second.next("welcome");
    expect(welcome.participantId).toBe(participantId);
    // The clock must be reported again on the new connection.
    expect(welcome.state).toEqual({
      participant: "syncing",
      seat: { x: 0.4, y: 0.6 },
      T0: null,
    });
    // The schedule is sent again so the phone can play without a new Ready.
    expect((await second.next("schedule")).events).toEqual(schedule.events);
    expect(session.participants.size).toBe(1);
    second.send(CLOCK_READY);
    await vi.waitFor(() =>
      expect(session.participants.get(participantId)?.state).toBe("standby"),
    );
  });

  it("a rejoin with the right token replaces the old socket", async () => {
    const { url, store } = await listen();
    const { code } = await hostSession(url);
    const first = await connect(url);
    first.send({ type: "join", code });
    const { participantId, resumeToken } = await first.next("welcome");

    const second = await connect(url);
    second.send({ type: "join", code, participantId, resumeToken });
    await second.next("welcome");
    await vi.waitFor(() => expect(first.ws.readyState).toBe(first.ws.CLOSED));

    // The old socket's close must not mark the participant disconnected.
    const p = store.getSession(code)!.participants.get(participantId)!;
    expect(p.state).toBe("connected");
  });

  it("a rejoin with a wrong or missing token gets a new participant and leaves the live socket open", async () => {
    const { url, store } = await listen();
    const { code } = await hostSession(url);
    const victim = await connect(url);
    victim.send({ type: "join", code });
    const { participantId, resumeToken } = await victim.next("welcome");
    victim.send({ type: "seat", x: 0.3, y: 0.3 });

    for (const token of [undefined, "wrong", resumeToken.slice(1)]) {
      const attacker = await connect(url);
      attacker.send({
        type: "join",
        code,
        participantId,
        ...(token === undefined ? {} : { resumeToken: token }),
      });
      const welcome = await attacker.next("welcome");
      expect(welcome.participantId).not.toBe(participantId);
      expect(welcome.resumeToken).not.toBe(resumeToken);
      expect(welcome.state.seat).toBeNull();
    }

    // The victim's socket is still open and still drives its participant.
    expect(victim.ws.readyState).toBe(victim.ws.OPEN);
    victim.send({ type: "ready" });
    await victim.next("schedule");
    victim.send(CLOCK_READY);
    const p = store.getSession(code)!.participants.get(participantId)!;
    await vi.waitFor(() => expect(p.state).toBe("standby"));
    expect(p.seat).toEqual({ x: 0.3, y: 0.3 });
  });

  it("never sends resume tokens to the host", async () => {
    const { url } = await listen({ participantsThrottleMs: 0 });
    const host = await connect(url);
    const raw: string[] = [];
    host.ws.on("message", (data) => raw.push(String(data)));
    host.send({ type: "host", showId: "test" });
    const { code } = await host.next("session");

    const phone = await connect(url);
    phone.send({ type: "join", code });
    const { participantId, resumeToken } = await phone.next("welcome");
    phone.send({ type: "seat", x: 0.5, y: 0.5 });
    phone.send({ type: "ready" });
    await phone.next("schedule");
    phone.send(CLOCK_READY);
    await vi.waitFor(() =>
      expect(raw.some((m) => m.includes("standby"))).toBe(true),
    );

    expect(raw.some((m) => m.includes(participantId))).toBe(true);
    expect(raw.some((m) => m.includes(resumeToken))).toBe(false);
    expect(raw.some((m) => m.includes("resumeToken"))).toBe(false);
  });

  it("never sends the host token to participants", async () => {
    const { url } = await listen({ participantsThrottleMs: 0 });
    const { code, hostToken } = await hostSession(url);
    const phone = await connect(url);
    const raw: string[] = [];
    phone.ws.on("message", (data) => raw.push(String(data)));
    phone.send({ type: "join", code });
    await phone.next("welcome");
    phone.send({ type: "seat", x: 0.5, y: 0.5 });
    phone.send({ type: "ready" });
    await phone.next("schedule");
    phone.send({ type: "host", code }); // a participant trying to take over
    expect((await phone.next("error")).reason).toBe("bad-message");

    expect(hostToken).toBeTruthy();
    expect(raw.some((m) => m.includes(hostToken!))).toBe(false);
    expect(raw.some((m) => m.includes("hostToken"))).toBe(false);
  });

  it("throttles participants updates to one per window", async () => {
    const { url } = await listen({ participantsThrottleMs: 200 });
    const { host, code } = await hostSession(url);
    const phones = await Promise.all(
      Array.from({ length: 10 }, () => connect(url)),
    );
    const sentAt = Date.now();
    for (const phone of phones) phone.send({ type: "join", code });
    await Promise.all(phones.map((p) => p.next("welcome")));

    // Expect the final state (10 participants) to arrive in at most two
    // updates: one at once, one at the end of the window.
    let update = await host.next("participants");
    let count = 1;
    while (update.list.length < 10) {
      update = await host.next("participants");
      count += 1;
    }
    expect(count).toBeLessThanOrEqual(2);
    expect(Date.now() - sentAt).toBeLessThan(1_000);
  });

  it("start and stop are refused until chunk 5", async () => {
    const { url } = await listen();
    const client = await connect(url);
    for (const message of [{ type: "start" }, { type: "stop" }] as const) {
      client.send(message);
      expect((await client.next("error")).reason).toBe("unsupported");
    }
  });
});

describe("clock sync", () => {
  it("answers sync with c0 and the server clock, before and after join", async () => {
    const { url } = await listen();
    const { host, code } = await hostSession(url);
    const phone = await connect(url);

    const before = performance.now();
    phone.send({ type: "sync", c0: 123.5 });
    const reply = await phone.next("sync");
    expect(reply.c0).toBe(123.5);
    // Same process, so the server clock is this clock.
    expect(reply.s1).toBeGreaterThanOrEqual(before);
    expect(reply.s1).toBeLessThanOrEqual(performance.now());

    phone.send({ type: "join", code });
    await phone.next("welcome");
    phone.send({ type: "sync", c0: 7 });
    expect((await phone.next("sync")).c0).toBe(7);

    // The host runs its own ClockSync over the same message.
    host.send({ type: "sync", c0: 9 });
    expect((await host.next("sync")).c0).toBe(9);
  });

  /** Ready a phone in a session of HEAVY_SHOW, then time one sync round. */
  async function syncRttDuringCompile(options: Partial<AttachOptions>) {
    const { url } = await listen({ resolveShow: () => HEAVY_SHOW, ...options });
    const { code } = await hostSession(url);
    const phone = await connect(url);
    phone.send({ type: "join", code });
    await phone.next("welcome");
    phone.send({ type: "seat", x: 0.5, y: 0.5 });
    phone.send({ type: "ready" });
    const sentAt = performance.now();
    phone.send({ type: "sync", c0: sentAt });
    await phone.next("sync", 5_000);
    const rtt = performance.now() - sentAt;
    const scheduleAlreadyIn = phone.all("schedule").length > 0;
    await phone.next("schedule", 10_000);
    return { rtt, scheduleAlreadyIn };
  }

  it("a sync reply is not delayed by a concurrent schedule compile", async () => {
    // Warm the pool so worker start-up is not part of the measurement.
    await compileInWorker(TEST_SHOW, { x: 0.5, y: 0.5 });
    const { rtt, scheduleAlreadyIn } = await syncRttDuringCompile({
      computeSchedule: compileInWorker,
    });
    expect(scheduleAlreadyIn).toBe(false);
    expect(rtt).toBeLessThan(100);
  }, 20_000);

  it("(control) the same compile on the main thread does delay sync", async () => {
    const { rtt } = await syncRttDuringCompile({
      computeSchedule: compileSchedule,
    });
    expect(rtt).toBeGreaterThan(150);
  }, 20_000);

  it("clock reports gate standby and reach the host summary", async () => {
    const { url, store } = await listen({ participantsThrottleMs: 0 });
    const { host, code } = await hostSession(url);
    const phone = await connect(url);
    phone.send({ type: "join", code });
    const { participantId: id } = await phone.next("welcome");
    phone.send({ type: "seat", x: 0.5, y: 0.5 });
    phone.send({ type: "ready" });
    await phone.next("schedule");
    const p = store.getSession(code)!.participants.get(id)!;
    expect(p.state).toBe("syncing");

    phone.send({ type: "clock", ready: true, degraded: true, rttMs: 250 });
    let latest = await host.next("participants");
    while (latest.list[0]?.state !== "standby") {
      latest = await host.next("participants");
    }
    expect(latest.list[0]).toMatchObject({ rttMs: 250, degraded: true });

    // Back to not ready (the tab returned from hidden): syncing again.
    phone.send({ type: "clock", ready: false, degraded: false, rttMs: null });
    while (latest.list[0]?.state !== "syncing") {
      latest = await host.next("participants");
    }
    expect(latest.list[0]).toMatchObject({ rttMs: null, degraded: false });
  });

  it("refuses clock from a socket that has not joined", async () => {
    const { url } = await listen();
    const { host } = await hostSession(url);
    host.send(CLOCK_READY);
    expect((await host.next("error")).reason).toBe("not-joined");
  });
});
