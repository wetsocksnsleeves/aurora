import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { rawUpgrade } from "./testing/raw-upgrade";
import { attachWebSocketServer, type UpgradeHandler } from "./ws";

let server: Server | undefined;

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

async function listen(
  nextUpgrade: UpgradeHandler,
  forwardNextUpgrades: boolean,
): Promise<number> {
  server = createServer((_req, res) => res.end("ok"));
  attachWebSocketServer(server, { nextUpgrade, forwardNextUpgrades });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const noop: UpgradeHandler = () => {};

describe("attachWebSocketServer upgrade routing", () => {
  it("echoes on /ws", async () => {
    const port = await listen(noop, true);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve) => ws.once("open", resolve));
    const reply = new Promise<string>((resolve) =>
      ws.once("message", (data) => resolve(String(data))),
    );
    ws.send("hello");
    expect(await reply).toBe("hello");
    ws.close();
  });

  it("rejects an unknown path with 404 and closes the socket", async () => {
    const nextUpgrade = vi.fn(noop);
    const port = await listen(nextUpgrade, true);
    const result = await rawUpgrade(port, "/nope");
    expect(result.response).toBe("HTTP/1.1 404 Not Found\r\n\r\n");
    expect(result.closed).toBe(true);
    expect(nextUpgrade).not.toHaveBeenCalled();
  });

  it("forwards /_next/* to Next when enabled (dev)", async () => {
    const nextUpgrade = vi.fn<UpgradeHandler>((_req, socket) => {
      socket.destroy();
    });
    const port = await listen(nextUpgrade, true);
    await rawUpgrade(port, "/_next/hmr");
    expect(nextUpgrade).toHaveBeenCalledOnce();
  });

  it("rejects /_next/* with 404 when forwarding is off (production)", async () => {
    const nextUpgrade = vi.fn(noop);
    const port = await listen(nextUpgrade, false);
    const result = await rawUpgrade(port, "/_next/hmr");
    expect(result.response).toBe("HTTP/1.1 404 Not Found\r\n\r\n");
    expect(result.closed).toBe(true);
    expect(nextUpgrade).not.toHaveBeenCalled();
  });

  it("destroys the socket when Next's handler throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const port = await listen(() => {
      throw new Error("boom");
    }, true);
    const result = await rawUpgrade(port, "/_next/hmr");
    expect(result.closed).toBe(true);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("destroys the socket when Next's handler rejects", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const port = await listen(async () => {
      throw new Error("boom");
    }, true);
    const result = await rawUpgrade(port, "/_next/hmr");
    expect(result.closed).toBe(true);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
