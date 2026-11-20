import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

export type SpawnedServer = {
  port: number;
  /** `http://127.0.0.1:<port>` */
  httpUrl: string;
  /** `ws://127.0.0.1:<port>/ws` */
  wsUrl: string;
  /** Everything the server wrote to stdout and stderr so far. */
  output(): string;
  stop(): Promise<void>;
};

/**
 * Boot `server.ts` in a child process on a free port (PORT=0) and wait for
 * its "listening" line. Runs Next in dev mode, so no build is needed.
 */
export async function spawnServer(
  env: Record<string, string> = {},
  timeoutMs = 60_000,
): Promise<SpawnedServer> {
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: "0",
      HOST: "127.0.0.1",
      NEXT_TELEMETRY_DISABLED: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let log = "";
  child.stdout?.on("data", (chunk: Buffer) => (log += chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => (log += chunk.toString()));

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server did not start in ${timeoutMs} ms:\n${log}`));
    }, timeoutMs);
    const onData = () => {
      const match = /listening on http:\/\/localhost:(\d+)/.exec(log);
      if (!match) return;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      resolve(Number(match[1]));
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}:\n${log}`));
    });
  });

  return {
    port,
    httpUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    output: () => log,
    stop: () => stopChild(child),
  };
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
