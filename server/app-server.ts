import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import next from "next";
import { attachWebSocketServer } from "./ws";

export type StartServerOptions = {
  /** Run Next in dev mode (HMR, on-demand compile). */
  dev: boolean;
  /** Port to listen on. 0 picks a free port. */
  port: number;
  hostname?: string;
  /** Next project directory. Defaults to the current working directory. */
  dir?: string;
};

export type RunningServer = {
  server: Server;
  /** The port actually bound, useful when `port` was 0. */
  port: number;
  close(): Promise<void>;
};

/**
 * Create the one HTTP server for the app (SPEC 5.1): Next handles HTTP
 * requests, `ws` handles upgrades on `/ws`, other upgrades go back to Next.
 */
export async function startServer(
  options: StartServerOptions,
): Promise<RunningServer> {
  const hostname = options.hostname ?? "0.0.0.0";
  const server = createServer();
  const app = next({
    dev: options.dev,
    dir: options.dir,
    hostname,
    port: options.port,
    httpServer: server,
  });
  const handle = app.getRequestHandler();
  await app.prepare();

  server.on("request", (req, res) => {
    void handle(req, res);
  });
  const wss = attachWebSocketServer(server, app.getUpgradeHandler());

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  return {
    server,
    port,
    async close() {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.close();
    },
  };
}
