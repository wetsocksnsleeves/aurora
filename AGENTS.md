<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project conventions

Read `SPEC.md` (what to build) and `DEVELOPMENT.md` (chunk plan) first.

- `app/`: Next.js App Router pages and route handlers. Plain CSS modules, no Tailwind.
- `lib/`: code shared by the server, the browser and the test harness. No Node or browser globals and no Node, Next or React imports (ESLint enforces this). Pass clocks, timers and send functions in.
- `server/`: Node-only code used by the custom server (`server.ts`): WebSocket routing, session store. `server/testing/` holds test helpers such as `spawnServer()`.
- WebSocket protocol: message types and `parseMessage` live in `lib/protocol.ts`. A new client message type needs a handler in `WsRouter.handlers` in `server/ws.ts` (missing handlers are a type error). Session state lives in `server/sessions.ts` (`getSessionStore()`); participant state is derived by `deriveState`, never set directly.
- `scripts/`: Node CLIs run with `tsx`, e.g. `scripts/sim.ts`.
- Tests live next to the code they test as `*.test.ts(x)` and run with Vitest. Browser end-to-end tests (Playwright, chunk 7) go in `e2e/`.
- Import with the `@/` alias (`@/lib/types`) or relative paths. Both work in Next, `tsx`, Vitest and the esbuild server bundle.
- Before pushing: `npm run typecheck && npm run lint && npm test && npm run build`. `npm run lint` also runs `prettier --check`; fix with `npm run format`.
- `npm run dev` runs `server.ts` with `tsx watch` (Next in dev mode). `npm run build && npm start` runs the esbuild bundle `dist/server.mjs` in production mode.
