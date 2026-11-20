import { connect } from "node:net";

export type RawUpgradeResult = {
  /** Everything the server wrote before closing. */
  response: string;
  /** True once the server closed the connection. */
  closed: boolean;
};

/**
 * Send a WebSocket upgrade request over a plain TCP socket and wait for the
 * server to close it. Resolves with `closed: false` if it is still open after
 * `timeoutMs`, which means the server left the socket hanging.
 */
export function rawUpgrade(
  port: number,
  path: string,
  timeoutMs = 2_000,
): Promise<RawUpgradeResult> {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ response, closed: false });
    }, timeoutMs);
    socket.on("data", (chunk) => (response += chunk.toString()));
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      resolve({ response, closed: true });
    });
    socket.write(
      [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "",
        "",
      ].join("\r\n"),
    );
  });
}
