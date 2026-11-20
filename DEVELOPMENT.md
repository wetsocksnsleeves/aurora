# Development plan

As of 2026-11-20. Breaks [SPEC.md](SPEC.md) section 7 (milestones) into chunks of work. Each chunk should fit in one PR and leave the app runnable. Section references such as (4.4) point into SPEC.md.

The order puts the risky part first: sync is built and measured before the editor (spec 7.2). Until the compiler exists, the server uses a hardcoded test show so the join and sync work can be tested end to end.

## Overview

| # | Chunk | Milestone | Depends on | Status |
| --- | --- | --- | --- | --- |
| 0 | Scaffold: Next.js + custom server + WebSocket | — | — | [x] |
| 1 | Protocol types and session store | 1. Join and standby | 0 | [ ] |
| 2 | Participant page: join, seat, ready | 1. Join and standby | 1 | [ ] |
| 3 | Host screen: QR code and live dots | 1. Join and standby | 1 | [ ] |
| 4 | `ClockSync` and the handshake | 2. Sync | 2 | [ ] |
| 5 | Start, stop, and rAF playback | 2. Sync | 3, 4 | [ ] |
| 6 | Simulated-client harness | 2. Sync | 5 | [ ] |
| 7 | Playwright browser sync test | 2. Sync | 5 | [ ] |
| 8 | Schedule compiler: fill, polygons, layers | 3. Schedule compiler | 1 | [ ] |
| 9 | Schedule compiler: moving shapes and fades | 3. Schedule compiler | 8 | [ ] |
| 10 | Show storage and API | 5. Save and host | 0 | [ ] |
| 11 | Editor: venue drawing | 4. Editor | 10 | [ ] |
| 12 | Editor: audio import and timeline | 4. Editor | 10 | [ ] |
| 13 | Editor: clip tools | 4. Editor | 9, 11, 12 | [ ] |
| 14 | Editor: preview | 4. Editor | 13 | [ ] |
| 15 | Show list and host flow with audio | 5. Save and host | 5, 10, 14 | [ ] |
| 16 | Real-device test | 6. Real-device test | 15 | [ ] |

Chunks 8 to 10 do not depend on sync, so they can run in parallel with 4 to 7 if two people are working.

## Milestone 0: scaffold

### Chunk 0. Next.js + custom server + WebSocket

Build:

- Next.js App Router project, TypeScript, strict mode.
- `server.ts`: `http.createServer`, Next request handler, `ws` server on `/ws`. Other upgrade paths go to `app.getUpgradeHandler()` (5.1).
- `npm run dev` runs `tsx watch server.ts`. `npm run build && npm start` runs the compiled server.
- Empty `lib/` and `scripts/` folders, Vitest, ESLint, Prettier.
- GitHub Actions CI on pull requests: `typecheck`, `lint`, `test`, `build`. Every later chunk merges only when CI passes.
- `.env.example` with `PORT` and `PUBLIC_URL` (the URL the QR code points to, set to the tunnel URL in demos).

Done when:

- `npm run dev` serves a page, and editing it hot-reloads.
- A test WebSocket client connects to `/ws` and gets an echo.
- The app loads on a phone through a cloudflared tunnel over HTTPS.

## Milestone 1: join and standby

### Chunk 1. Protocol types and session store

Build:

- `lib/protocol.ts`: message types for every row in 5.2, as discriminated unions on `type`. One `parseMessage` function that validates incoming JSON.
- `lib/types.ts`: `Point`, `Venue`, `Clip`, `Show`, `Schedule` from 3.2 and 3.3.
- `lib/test-show.ts`: a hardcoded venue (two rectangles) and a `testSchedule(seat)` that flashes white with a delay proportional to `seat.x`, so a left-to-right wave is visible before the compiler exists.
- `server/sessions.ts`: in-memory session store with join codes (6 characters, no ambiguous letters such as O/0 and I/1), participants, and the state machine from 5.3. Removes disconnected participants after 60 s.
- WebSocket routing in `server/ws.ts`: `host`, `join`, `seat`, `ready`.

Done when: unit tests cover the state transitions in 5.3, including a reconnect that keeps the same participant.

### Chunk 2. Participant page

Build:

- `/j/[code]`: opens the socket after a random 0 to 800 ms delay (4.3), sends `join`, renders the venue from `welcome`.
- Tap to place a seat marker, tap again to move it. Sends `seat`.
- Ready button: requests fullscreen (where supported) and the wake lock in the same tap handler (2.3, 4.9). Sends `ready`.
- Screens for each state: seat picker, "syncing", green standby with a "turn your brightness up" hint, show over.
- Reconnect on socket close, keeping the participant id in `sessionStorage`.

Done when: on a real phone, the page goes from scan to green with the test schedule. Standby here means schedule received only. The clock gate arrives in chunk 4.

### Chunk 3. Host screen

Build:

- `/sessions/[code]/host`: venue map with one dot per participant, coloured by state (5.3).
- QR code for `PUBLIC_URL/j/<code>` (the `qrcode` package), the code as text, and counts per state.
- Server sends `participants` to the host, throttled to 4 updates per second.
- A temporary "New test session" button that creates a session for the hardcoded show.

Done when: three phones join, and their dots appear grey, then yellow, then green on the host map.

**Milestone 1 demo:** scan, tap a seat, tap Ready, the phone and its dot turn green.

## Milestone 2: sync

### Chunk 4. `ClockSync` and the handshake

Build:

- `lib/clock-sync.ts`, with no browser or Node globals. The clock and the send function are passed in, so the harness can inject fake clocks.
  - Offset and RTT per sample, discarding out-of-range samples (4.2).
  - A window of 40 samples, with the best estimate taken from the lowest-RTT sample.
  - Ping schedule: a burst of 14 on open and on return to visible, 1 every 20 s after that, with singleton timers (4.3).
  - Ready gate and degraded fallback after 6 s (4.4).
  - Slew of the applied offset (4.5).
- Server replies to `sync` with `s1 = performance.now()`.
- Participant page: standby now also requires `clock.ready`. Send ready, degraded and RTT to the server for the host map.
- Host page runs its own `ClockSync`.

Done when: unit tests cover every item in 6.3 for `ClockSync` and the offset estimator, including asymmetric latency with a known true offset.

### Chunk 5. Start, stop, and playback

Build:

- Host Start and Stop buttons. Start is enabled once one participant is in standby (2.2).
- Server sets `T0 = now + startLeadMs`, broadcasts `start`, and stores `T0` in session state for late joiners and reconnects (4.6). `START_LEAD_MS` in env, default 900.
- Participant rAF loop exactly as in 4.7, with a forward-moving cursor over `schedule.events`.
- Return to visible: stay dark until the clock is ready again (4.9).
- "Show over" screen after `durationMs`.
- The host map colours `playing` dots with the participant's current colour, computed on the host from the same test schedule.

Done when: two phones side by side flash together by eye, and a phone that reloads mid-show rejoins at the current position.

### Chunk 6. Simulated-client harness

Build:

- `scripts/sim.ts` (6.1): N clients in one process, each with its own `ClockSync` over a faked clock carrying offset and drift.
- Fault injection from the 6.1 table, each range configurable by CLI flag.
- Report from 6.2: sync error p50/p95/max, join-to-standby p50/p95. Exit code 1 if p95 is over 50 ms.
- Simulated dots appear on the host map, so the test wave is visible sweeping across.

Done when: `npx tsx scripts/sim.ts --clients 500` passes with default faults, and a run with an injected bug (for example slew disabled) fails.

### Chunk 7. Playwright browser sync test

Build: 3 to 5 browser contexts with mobile emulation run `/j/[code]` end to end. Each records the wall-clock time of every colour change. The test asserts a p95 spread under 50 ms (6.3).

Done when: it passes with `npm run test:e2e` locally.

**Milestone 2 demo:** 200 simulated clients plus a few real phones play the test wave in sync, and the harness reports p95 under 50 ms.

## Milestone 3: schedule compiler

### Chunk 8. Fill, polygons, layers

Build:

- `lib/compile.ts`: `compileSchedule(show, seat): Schedule`, sampling at 20 ms, point-in-polygon by ray casting, highest layer wins, run-length encoded (3.3).
- The server compiles on `ready` and on `seat` after ready, replacing `testSchedule`. Compiles run on a `worker_threads` worker so `sync` replies are not delayed (3.3).
- A seat outside every venue shape snaps to the nearest point on the nearest edge (spec section 8).

Done when: unit tests cover fill, static polygon, layering, and a seat exactly on a polygon edge.

### Chunk 9. Moving shapes and fades

Build: `moveTo` interpolation and the fade envelope from 3.3.

Done when: unit tests cover both, and compiling a 3-minute show for one seat takes under 10 ms (benchmark in the test).

## Milestone 4: editor

### Chunk 10. Show storage and API

Build:

- SQLite via `better-sqlite3`: one `shows` table holding the show JSON plus `id`, `name`, `created_at` and `updated_at`.
- `/api/shows` (list, create) and `/api/shows/[id]` (get, update, delete).
- `/api/audio`: upload to `data/audio/<id>.<ext>`, and serve it back.
- `data/` in `.gitignore`.

Done when: route handler tests cover create, read, update, delete and audio upload.

### Chunk 11. Venue drawing

Build: `/shows/[id]/edit` canvas with rectangle and polygon tools, select, move, delete. Coordinates normalised to 0..1. Saves through the API.

Done when: a venue drawn, saved and reloaded renders the same at different window sizes.

### Chunk 12. Audio import and timeline

Build:

- Upload audio, decode it, show a waveform with wavesurfer.js under the canvas.
- Playhead, scrubbing, zoom.
- Snap grid: 100 ms, 50 ms, or beat subdivisions when a BPM is set (3.1).

Done when: a 3-minute mp3 loads, plays, and scrubs without lag.

### Chunk 13. Clip tools

Build:

- Tools from the 2.1 table: fill, shape, moving shape (draw start position, then drag to end position), brush (freehand stroke simplified to a polygon).
- Each drawing creates a clip at the playhead. Clips appear as bars on the timeline with draggable start and end handles.
- Clip inspector: colour, fade in, fade out, layer.

Done when: a wave, a split-colour block and a full-crowd flash can be drawn, saved and reloaded.

### Chunk 14. Preview

Build: playing the timeline plays the audio and animates the venue with a grid of simulated dots. Each dot's colour comes from `compileSchedule`, so the preview shows what phones will show.

Done when: the preview matches the host map's `playing` colours for the same show.

## Milestone 5: save and host

### Chunk 15. Show list and host flow

Build:

- `/`: show list with create, open, delete, and Host.
- Host creates a session from a snapshot of the show (spec section 8 proposal: no live edits).
- Remove the temporary test-session button from chunk 3.
- Host audio (4.8): `AudioBufferSourceNode` started at the `AudioContext` time matching `T0`, minus `outputLatency`, plus a manual offset slider of ±500 ms.

Done when: a show built in the editor runs end to end on real phones, with audio from the host laptop.

## Milestone 6: real-device test

### Chunk 16. Real-device test

Build: a test show of hard black and white flashes at 1 Hz.

Run: 5 to 10 phones (mixed iOS and Android), on venue-like wifi and on mobile data, filmed at 240 fps (6.4). Count frames between the first and last phone to change. Tune the audio offset slider by ear and camera against the flashes.

Done when: results are written to `docs/device-test.md`, with the spread per flash and any device that was consistently late.

## Decisions

Spec section 8 records the decisions that chunks 6, 8, 11, 13 and 15 depend on: 500 participants, any colour, straight-edged polygons, snap-to-edge for stray seats, no host auth, and a show snapshot per session.
