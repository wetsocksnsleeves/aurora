import type { NextConfig } from "next";
import { lanAddresses } from "./server/lan";

/**
 * Hosts allowed to load dev-mode resources (HMR, chunks) from another device,
 * e.g. a phone on the LAN. Matches the API host allowlist: this machine's LAN
 * IPs, PUBLIC_URL and ALLOWED_HOSTS. Read once at startup, so restart
 * `npm run dev` after switching networks.
 */
function devOrigins(): string[] {
  const hosts = new Set<string>(lanAddresses());
  const publicUrl = process.env.PUBLIC_URL;
  if (publicUrl) {
    try {
      hosts.add(new URL(publicUrl).hostname);
    } catch {
      // Malformed PUBLIC_URL: the server reports it elsewhere.
    }
  }
  for (const entry of (process.env.ALLOWED_HOSTS ?? "").split(",")) {
    const host = entry.trim().replace(/:\d+$/, "");
    if (host) hosts.add(host);
  }
  hosts.delete("localhost");
  return [...hosts];
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Test servers (server/testing/spawn-server.ts) each get their own build
  // directory, so parallel test files and `npm run dev` don't share Next's
  // dev lock.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Next dev adds its distDir to the tsconfig `include` list on startup.
  // Test servers point this at a throwaway tsconfig that extends the real
  // one, so running tests never rewrites tsconfig.json.
  typescript: {
    tsconfigPath: process.env.NEXT_TSCONFIG_PATH || "tsconfig.json",
  },
  // Native module: load it with Node's require instead of bundling it.
  serverExternalPackages: ["better-sqlite3"],
  allowedDevOrigins: devOrigins(),
};

export default nextConfig;
