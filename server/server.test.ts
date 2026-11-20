import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
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
