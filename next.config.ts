import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Tests boot their own dev server with NEXT_DIST_DIR=.next-test so they
  // can run while `npm run dev` holds the lock on `.next/dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
