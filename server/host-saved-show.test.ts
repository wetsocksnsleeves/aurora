import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { WebSocketServer } from "ws";
import { compileSchedule } from "@/lib/compile";
import { TEST_SHOW, TEST_VENUE } from "@/lib/test-show";
import type { Clip, Show } from "@/lib/types";
import { closeCompilePool } from "./compile-pool";
import { createShow, deleteShow, getShow, updateShow } from "./db";
import { SessionStore } from "./sessions";
import { withTempDataDir } from "./testing/temp-data-dir";
import { TestClient } from "./testing/ws-client";
import { attachWebSocketServer } from "./ws";

// Hosting a saved show end to end through the default show resolver
// (SQLite) and the default schedule compiler (worker pool).

withTempDataDir();

let server: Server | undefined;
let wss: WebSocketServer | undefined;
let clients: TestClient[] = [];

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients = [];
  wss?.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
  wss = undefined;
});

afterAll(() => closeCompilePool());

async function listen(): Promise<{ url: string; store: SessionStore }> {
  const store = new SessionStore();
  server = createServer((_req, res) => res.end("ok"));
  // No resolveShow / computeSchedule: the defaults are what is under test.
  wss = attachWebSocketServer(server, {
    nextUpgrade: () => {},
    forwardNextUpgrades: false,
    publicUrl: "https://aurora.example",
    store,
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}/ws`, store };
}

async function connect(url: string): Promise<TestClient> {
  const client = await TestClient.connect(url);
  clients.push(client);
  return client;
}

function clip(partial: Partial<Clip> & Pick<Clip, "id">): Clip {
  return {
    layer: 0,
    startMs: 0,
    endMs: 1_000,
    color: "#ffffff",
    fadeInMs: 0,
    fadeOutMs: 0,
    shape: { kind: "fill" },
    ...partial,
  };
}

function savedShow(): Show {
  return createShow({
    name: "Saved show",
    venue: TEST_VENUE,
    audio: {
      fileId: "01234567-89ab-cdef-0123-456789abcdef.mp3",
      durationMs: 4_000,
    },
    clips: [
      clip({ id: "red", startMs: 0, endMs: 2_000, color: "#ff0000" }),
      clip({
        id: "blue-left",
        layer: 1,
        startMs: 500,
        endMs: 3_000,
        color: "#0000ff",
        fadeInMs: 200,
        shape: {
          kind: "polygon",
          points: [
            { x: 0, y: 0 },
            { x: 0.5, y: 0 },
            { x: 0.5, y: 1 },
            { x: 0, y: 1 },
          ],
        },
      }),
    ],
  });
}

describe("hosting a saved show", () => {
  it("snapshots the saved show and compiles participants' schedules from it", async () => {
    const show = savedShow();
    const { url, store } = await listen();

    const host = await connect(url);
    host.send({ type: "host", showId: show.id });
    const session = await host.next("session");
    expect(session.showId).toBe(show.id);
    expect(session.show).toEqual(show);
    expect(session.venue).toEqual(show.venue);
    expect(session.hostToken).toEqual(expect.any(String));
    expect(store.requireSession(session.code).show).toEqual(show);

    for (const seat of [
      { x: 0.25, y: 0.5 },
      { x: 0.75, y: 0.5 },
    ]) {
      const phone = await connect(url);
      phone.send({ type: "join", code: session.code });
      await phone.next("welcome");
      phone.send({ type: "seat", ...seat });
      phone.send({ type: "ready" });
      const schedule = await phone.next("schedule");
      const expected = compileSchedule(show, seat);
      expect(schedule.events).toEqual(expected.events);
      expect(schedule.durationMs).toBe(expected.durationMs);
    }
  });

  it("keeps the snapshot when the show is edited or deleted after hosting", async () => {
    const show = savedShow();
    const { url } = await listen();
    const host = await connect(url);
    host.send({ type: "host", showId: show.id });
    const { code } = await host.next("session");

    const edited = updateShow(show.id, {
      name: "Edited",
      clips: [clip({ id: "green", endMs: 4_000, color: "#00ff00" })],
    });
    expect(edited?.clips[0]?.color).toBe("#00ff00");

    const seat = { x: 0.25, y: 0.5 };
    const phone = await connect(url);
    phone.send({ type: "join", code });
    await phone.next("welcome");
    phone.send({ type: "seat", ...seat });
    phone.send({ type: "ready" });
    const schedule = await phone.next("schedule");
    expect(schedule.events).toEqual(compileSchedule(show, seat).events);
    expect(schedule.events.some((e) => e.color === "#00ff00")).toBe(false);

    // Deleting the saved show does not end the session either.
    expect(deleteShow(show.id)).toBe(true);
    expect(getShow(show.id)).toBeNull();
    const late = await connect(url);
    late.send({ type: "join", code });
    expect((await late.next("welcome")).venue).toEqual(show.venue);
    late.send({ type: "seat", ...seat });
    late.send({ type: "ready" });
    expect((await late.next("schedule")).events).toEqual(
      compileSchedule(show, seat).events,
    );
  });

  it("re-attaching with the token returns the original snapshot", async () => {
    const show = savedShow();
    const { url } = await listen();
    const host = await connect(url);
    host.send({ type: "host", showId: show.id });
    const first = await host.next("session");
    updateShow(show.id, { name: "Renamed later" });

    const again = await connect(url);
    again.send({
      type: "host",
      code: first.code,
      hostToken: first.hostToken!,
    });
    const second = await again.next("session");
    expect(second.show).toEqual(show);
    expect(second.show.name).toBe("Saved show");
    expect(second.hostToken).toBeUndefined();
  });

  it("still hosts the built-in test show and rejects unknown ids", async () => {
    const { url } = await listen();
    const host = await connect(url);
    host.send({ type: "host", showId: TEST_SHOW.id });
    expect((await host.next("session")).show).toEqual(TEST_SHOW);

    const other = await connect(url);
    other.send({ type: "host", showId: "no-such-show" });
    expect((await other.next("error")).reason).toBe("unknown-show");
  });
});
