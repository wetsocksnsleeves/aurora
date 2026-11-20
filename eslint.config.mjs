import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

const nodeBuiltins = [
  "node:*",
  "fs",
  "path",
  "os",
  "http",
  "https",
  "net",
  "crypto",
  "stream",
  "child_process",
  "worker_threads",
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  {
    // lib/ is shared by the server, the browser and the test harness, so it
    // must not touch Node or browser globals. Pass clocks, timers and send
    // functions in instead.
    files: ["lib/**/*.{ts,tsx}"],
    ignores: ["lib/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-globals": [
        "error",
        "window",
        "document",
        "navigator",
        "localStorage",
        "sessionStorage",
        "location",
        "process",
        "Buffer",
        "__dirname",
        "__filename",
        "require",
        "global",
      ],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: nodeBuiltins,
              message: "lib/ must stay free of Node APIs.",
            },
            {
              group: ["next", "next/*", "react", "react-dom", "@/server/*"],
              message: "lib/ must not depend on Next, React or server/.",
            },
          ],
        },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    ".next-test/**",
    "out/**",
    "build/**",
    "dist/**",
    "data/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
