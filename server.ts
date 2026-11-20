import { startServer } from "./server/app-server";

const dev = process.env.NODE_ENV !== "production";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const hostname = process.env.HOST ?? "0.0.0.0";

const running = await startServer({ dev, port, hostname });

// Tests parse this line to find the bound port when PORT=0.
console.log(
  `> aurora listening on http://localhost:${running.port} (${dev ? "development" : "production"})`,
);

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`> ${signal} received, shutting down`);
  await running.close();
  process.exit(0);
}
process.on("SIGINT", (s) => void shutdown(s));
process.on("SIGTERM", (s) => void shutdown(s));
