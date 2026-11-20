import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    // Tests sit next to the code they test as `*.test.ts(x)`.
    include: ["**/*.test.{ts,tsx}"],
    exclude: [
      "node_modules/**",
      ".next/**",
      ".next-test/**",
      "dist/**",
      "e2e/**",
    ],
  },
});
