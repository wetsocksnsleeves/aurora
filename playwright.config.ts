import { defineConfig } from "@playwright/test";

/**
 * Browser end-to-end tests (DEVELOPMENT.md chunk 7). Each spec boots its own
 * app server with `spawnServer()` (Next dev mode, a free port, its own build
 * directory), so there is no `webServer` here and specs can run beside
 * `npm run dev`. Only Chromium is installed: `npx playwright install chromium`.
 */
export default defineConfig({
  testDir: "e2e",
  // The sync test measures timing; running specs side by side would only
  // add noise.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    browserName: "chromium",
    trace: "retain-on-failure",
  },
});
