import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
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

  it("echoes messages on /ws", async () => {
    const ws = await openSocket(server.wsUrl);
    const reply = nextMessage(ws);
    ws.send("ping 123");
    expect(await reply).toBe("ping 123");
    ws.close();
  });
});
