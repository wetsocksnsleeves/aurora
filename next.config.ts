import type { NextConfig } from "next";

/**
 * Hosts allowed to load dev-mode resources (HMR, chunks) from another device,
 * e.g. a phone on the LAN. Taken from PUBLIC_URL and ALLOWED_HOSTS so one
 * setting covers both the API host allowlist and Next's dev origin check.
 */
function devOrigins(): string[] {
  const hosts = new Set<string>();
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
