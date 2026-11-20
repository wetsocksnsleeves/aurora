import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

let spawnCount = 0;

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
 * its "listening" line. Runs Next in dev mode, so no build is needed. Each
 * server gets its own build directory under `.next-test/`, so several test
 * files and `npm run dev` can run at once without fighting over Next's dev
 * lock. The directory is removed on `stop()`.
 */
export async function spawnServer(
  env: Record<string, string> = {},
  timeoutMs = 60_000,
): Promise<SpawnedServer> {
  const runId = `${process.pid}-${spawnCount++}`;
  const distDir = `.next-test/${runId}`;
  // Next dev rewrites the tsconfig it is given (adds distDir to `include`).
  // Hand it a throwaway one that extends the real tsconfig.json.
  const tsconfigPath = `.next-test/${runId}.tsconfig.json`;
  await mkdir(path.join(repoRoot, ".next-test"), { recursive: true });
  await writeFile(
    path.join(repoRoot, tsconfigPath),
    JSON.stringify({ extends: "../tsconfig.json" }, null, 2),
  );
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: "0",
      HOST: "127.0.0.1",
      NEXT_TELEMETRY_DISABLED: "1",
      NEXT_DIST_DIR: distDir,
      NEXT_TSCONFIG_PATH: tsconfigPath,
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
    stop: async () => {
      await stopChild(child);
      await rm(path.join(repoRoot, distDir), { recursive: true, force: true });
      await rm(path.join(repoRoot, tsconfigPath), { force: true });
    },
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
