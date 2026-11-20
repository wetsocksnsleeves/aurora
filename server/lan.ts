import os from "node:os";

type Interfaces = ReturnType<typeof os.networkInterfaces>;

/**
 * This machine's LAN IPv4 addresses, e.g. `192.168.0.200`: the addresses a
 * phone on the same network can reach it on. Loopback and link-local
 * (169.254.x.x) addresses are skipped. Read on every call, so joining a
 * different network is picked up without configuration.
 */
export function lanAddresses(
  interfaces: Interfaces = os.networkInterfaces(),
): string[] {
  const out: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      if (entry.family !== "IPv4") continue;
      if (entry.address.startsWith("169.254.")) continue;
      if (!out.includes(entry.address)) out.push(entry.address);
    }
  }
  return out;
}
