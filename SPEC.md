# Synchronised light show spec

As of 2026-11-20.

A host designs a light show against an audio track on a drawing of the venue. At the event, audience members scan a QR code, point their camera at the big screen so the phone can work out where they are (2.4), and their phone screens become pixels in the show. All phones start on a shared clock and play their own pre-computed light sequence.

## 1. Roles and terms

| Term | Meaning |
| --- | --- |
| Host | The person who designs and runs a show. Uses the host web app on a laptop. |
| Participant | An audience member. Uses a phone browser. No install. |
| Venue | The outline of the seating area, drawn by the host. |
| Show | A venue, an audio file, and a timeline of light clips. Saved and reusable. |
| Session | One live run of a show. Has a join code, a QR code, and a set of participants. |
| Clip | One drawn shape on the timeline with a colour, a start time and an end time. |
| Schedule | The per-participant list of colour changes, computed from the show and the participant's seat. |

## 2. User flows

### 2.1 Show editor (host)

1. **Draw the venue.** The host draws one or more shapes (rectangle, polygon) on a canvas. Coordinates are stored normalised to 0..1 so the venue renders at any screen size.
2. **Import audio.** The host uploads an audio file (mp3, wav, m4a). The editor decodes it and shows a waveform timeline under the venue canvas.
3. **Draw on the timeline.** The host scrubs to a time, picks a tool, and draws on the venue. Each drawing becomes a clip on the timeline with draggable start and end handles.
4. **Preview.** Playing the timeline plays the audio and animates the venue, with simulated dots lighting up as participants would.
5. **Save.** The show is saved with a name. The host can reopen and edit it later.

Drawing tools for the first version:

| Tool | Effect | Example |
| --- | --- | --- |
| Fill | Every seat lights for the clip's duration. | Whole crowd flashes white on the drop. |
| Shape | A rectangle or polygon lights the seats inside it. | Left half red, right half blue. |
| Moving shape | A shape with a start position and an end position. The shape moves linearly between them over the clip's duration. | A white strip sweeps left to right over 4 s, giving a wave. |
| Brush | Freehand stroke, stored as a polygon. | Draw a heart. |

Each clip also has an optional fade in and fade out duration in ms. Clips stack in layers. The topmost clip covering a seat at a given time sets its colour. Uncovered seats are black.

### 2.2 Hosting a session

1. The host picks a saved show and clicks "Host".
2. The server creates a session with a short join code.
3. The host screen shows:
    - Left: the venue with one dot per participant, coloured by state (see 5.3).
    - Right: a QR code for `https://<server>/j/<code>`, the code as text, and participant counts by state.
4. The host clicks "Start" when ready. Start is enabled once at least one participant is in standby. The host can also "Stop" a running show.
5. The host machine plays the audio through the venue's sound system, scheduled on the same clock as the phones.

### 2.3 Participant

1. Scan the QR code. The phone opens the participant page in the browser.
2. The participant taps "Find my seat" and points the camera at the big screen. The phone works out where it is (2.4) and shows the spot on the venue map. "Scan again" repeats it.
3. The participant taps "Ready". The phone enters fullscreen where supported and requests a screen wake lock. This tap is also the user gesture that browsers require for those APIs.
4. In the background the phone runs the clock handshake (section 4) and the server sends the participant's schedule.
5. When both are done the screen turns green. The host map shows the dot as green. The phone waits.
6. The host starts the show. The screen goes black and then plays the schedule. At the end it shows a "Show over" screen.

### 2.4 Finding the seat with the camera

There is no seat picking by hand: the participant points the phone camera at the big screen and the phone works out where it is. The venue is one box in front of the screen, and anyone in it gets positioned.

1. The host opens `/sessions/[code]/screen` on the projector. It shows a positioning target: four corner anchors (rounded-square rings with a core, like a QR code's finder squares) around an LED-style grille of lit and unlit pixels, with the join QR code in the middle. `F` toggles fullscreen.
2. The host enters three sizes in the "Camera seats" panel on the host screen: the target width (between the centres of the left and right anchors, measured on the screen), and the venue box's width and depth in metres. The box's top edge is the screen, centred.
3. The participant taps "Find my seat" and points at the screen. The phone finds the anchors, reads the grille to tell which corner is which, and solves the camera position from about 300 matched points. Past roughly 7 target widths away the grille is too small to read and the four anchors alone are used, assuming the phone is upright.
4. Distance depends on the camera's field of view, which browsers don't report. The phone measures it from the angled view where it can (front and side seats). From about 6 m back and square-on it guides a short measurement: a box appears on one side of the camera view with an arrow, the participant turns the phone until the screen sits inside the box and holds it there, then the box moves to the other side (three holds). The gyro gives the angle turned and the camera the distance the screen slid. Closer than that, a hand-held turn also moves the camera sideways enough to skew the result, so the phone keeps the typical 66°. Measurements are remembered on the phone; `?sweep=1` on the join link forces the guided measurement for testing.
5. The position becomes a seat in the box (`seat` message as usual); a position outside the box lands on its nearest edge. The participant taps Ready.

The maths is in `lib/positioning/`, with synthetic-camera tests. The Playwright sync test (`e2e/`) seats its phones the same way, through a fake camera playing a rendered view of the target.

## 3. Pattern model

### 3.1 Why clips and not frames

The show is stored as clips with times in milliseconds. It is not stored as a sequence of frames. Reasons:

- A wave is one clip with two positions. As frames it would be hundreds of painted frames.
- Clips do not depend on a frame rate. A phone at 60 Hz and one throttled to 30 Hz evaluate the same timeline.
- The editor stays responsive. The timeline zooms to any resolution, and clip edges snap to an adjustable grid (100 ms, 50 ms, or beat subdivisions if a BPM is set).

### 3.2 Data model

```ts
type Point = { x: number; y: number }          // normalised 0..1

type Venue = {
  shapes: { id: string; points: Point[] }[]    // closed polygons; a rectangle is 4 points
}

type Clip = {
  id: string
  layer: number                                // higher draws on top
  startMs: number
  endMs: number
  color: string                                // "#ffffff"
  fadeInMs: number
  fadeOutMs: number
  shape:
    | { kind: "fill" }
    | { kind: "polygon"; points: Point[]; moveTo?: Point }  // moveTo = offset at endMs, interpolated linearly
}

type Show = {
  id: string
  name: string
  venue: Venue
  audio: { fileId: string; durationMs: number }
  clips: Clip[]
  createdAt: string
  updatedAt: string
}
```

### 3.3 Computing a participant's schedule

Input: the show and the participant's seat point `p`.

1. Sample the timeline every 20 ms (50 Hz).
2. At each sample time `t`, find the clips active at `t`. For a moving polygon, offset it by `moveTo * (t - startMs) / (endMs - startMs)`. Test whether `p` is inside (ray casting point-in-polygon).
3. The highest-layer hit sets the colour, scaled by its fade envelope. No hit means black.
4. Run-length encode the samples into change events.

```ts
type Schedule = { events: { tMs: number; color: string }[] }  // sorted by tMs
```

A 3-minute show with mostly solid blocks compresses to a few hundred events. Fades produce more events, which is acceptable at this size.

The server computes the schedule when the participant taps Ready, matching the flow above. The compiler is a pure function shared by the server, the editor preview, and the test harness.

The server runs the compiler on a `worker_threads` worker. A compile takes 2 to 5 ms, so 100 phones tapping Ready in the same second would block the event loop for up to 0.5 s if it ran on the main thread. `sync` replies queued behind that block return with inflated RTT, which delays every phone's ready gate.

Decision: the server sends each phone its own schedule. The other option is to send the whole show to every phone and let each phone compute its own sequence from its seat. Both handle positional differences, because the seat is the only per-phone input either way.

| | Server sends per-seat schedule (chosen) | Server sends whole show, phone computes |
| --- | --- | --- |
| Payload | A few hundred change events, a few KB per phone | All clips, tens of KB, same for every phone |
| Seat change | New `seat` message, server recomputes and resends | Recomputed on the phone, no round trip |
| Phone work | Look up the next event each frame | Run the compiler once at Ready, or evaluate every clip per frame |
| Testing | The harness can assert the exact schedule each phone receives | The harness must run the compiler per client to know what each phone plays |
| Server work at Ready | About 9,000 samples × active clips per phone, a few ms | None |

The per-seat schedule keeps the phone page small and lets the harness check what each phone will play. Seat changes after Ready should be rare.

Switching later is cheap. The compiler is one pure function in `lib/`, so the choice is only where it runs.

## 4. Synchronisation

The sync layer follows [AndriiShramko/crowd-light-show](https://github.com/AndriiShramko/crowd-light-show), mainly `public/clocksync.js`, `public/audience.js` and `src/show.js`. The constants below are taken from that repo. This project differs in two ways. The host plays the audio (4.8). Each phone receives its own schedule at Ready (3.3), where the reference sends the whole timeline to every phone on join.

Target: every phone shows a given event within 50 ms of the others at p95. The reference repo's harness asserts the same number.

Each phone estimates its offset from the server clock. The server announces a start time on its own clock, a little in the future. Each phone renders the show locally from its own clock plus the offset, so the network is not needed once the show starts.

### 4.1 Clocks

- The server clock is `performance.now()` in the server process. It is monotonic and independent of wall-clock adjustments.
- The client clock is `performance.now()` in the browser. `Date.now()` is not used, because it can jump when the OS adjusts the wall clock.
- `serverNow() = performance.now() + appliedOffset` on the client.

### 4.2 Offset handshake

1. Client sends `sync { c0 }`, where `c0 = performance.now()`.
2. Server replies right away with `sync { c0, s1 }`, where `s1` is the server clock at reply time.
3. Client records `c1 = performance.now()` on receipt.
4. `rtt = c1 - c0` and `offset = s1 - (c0 + c1) / 2`.
5. Discard samples with `rtt < 0` or `rtt > 4000` ms. These come from a tab that was suspended mid-round.
6. Keep a rolling window of the last 40 samples. The offset estimate is the offset of the sample with the lowest `rtt` in the window. That round spent the least time in queues, so its up and down legs are closest to equal and its offset has the smallest error.

The server does not record a separate receive time. Its handling time is negligible next to network time.

### 4.3 When to ping

| Trigger | Pings |
| --- | --- |
| Socket opens (join or reconnect) | Burst of 14, 80 ms apart |
| Tab returns to visible | Clear all samples, then a burst of 14 |
| Steady state | 1 every 20 s, for the life of the connection |

Each timer is a singleton. A new burst cancels a running one, so reconnects do not stack intervals.

To avoid hundreds of phones connecting at the same moment after a QR scan, each client waits a random 0 to 800 ms before opening the socket.

### 4.4 Ready gate

The clock is ready when all of these hold:

- at least 8 samples in the window,
- the best `rtt` is 400 ms or less,
- the best-offset estimate over the last 3 replies varies by 30 ms or less.

If the clock is not ready 6 s after the first reply and there are at least 6 samples, mark it ready and degraded. A phone that is slightly late is better than one that stays dark for the whole show. The host map shows degraded participants with a warning marker.

A participant becomes `standby` (green) when the clock is ready and the schedule has arrived. The phone stays dark whenever the clock is not ready, including after a resync.

### 4.5 Applying corrections

Steady-state pings update the best estimate during the show. A sudden change in the applied offset would show as a visible jump, so the client moves `appliedOffset` toward the estimate gradually:

- A correction of 8 ms or less is applied at once.
- A larger correction moves at 0.15 ms per ms of real time (150 ms per second) until it catches up.
- The first estimate after a reset is applied at once.

### 4.6 Start

1. Host clicks Start.
2. Server sets `T0 = serverClock() + startLeadMs`.
3. Server broadcasts `start { T0 }` to every participant and the host.
4. The session state stores `T0`, so a late joiner or a reconnecting phone receives it in `welcome` and joins at the current position.

The reference repo uses `startLeadMs = 900`. That works because each phone already holds its timeline. This project computes schedules at Ready, so every standby phone also has its schedule before Start, and 900 ms is enough. Make it configurable. If the venue network is slow, raise it to 2000 ms.

### 4.7 Playback loop

The loop runs in `requestAnimationFrame`. It re-arms first, so an exception later in the frame does not stop it.

```ts
function render() {
  requestAnimationFrame(render)
  if (!clock.ready || T0 == null) return paint("#000")
  const showMs = clock.serverNow() - T0
  paint(lookup(schedule, showMs))   // a cursor that moves forward, or binary search
}
```

Do not schedule one `setTimeout` per event. Timers drift and browsers throttle them. The loop reads the clock every frame, so a late frame still shows the correct colour for that moment.

### 4.8 Audio on the host

This differs from the reference repo, where each phone can play the track. Here the host machine plays audio through the venue PA.

The host page runs the same `ClockSync` against the server. It starts an `AudioBufferSourceNode` at the `AudioContext` time that matches `T0`, minus `AudioContext.outputLatency` where the browser reports it. Bluetooth speakers add 100 to 300 ms that browsers often do not report, so the host screen has a manual audio offset slider (±500 ms).

### 4.9 Device constraints

| Constraint | Handling |
| --- | --- |
| Screen sleeps | Screen Wake Lock API after the Ready tap. Requires HTTPS. Where it is missing or refused (plain-HTTP LAN links), play a tiny muted looping video (`public/keep-awake.mp4`) instead. Retake on return to visible and on every tap. Show a "keep your screen on" hint if both fail. |
| Fullscreen | Fullscreen API on Android. Leaving fullscreen needs no permission, and re-entering needs a tap, so after Ready any tap re-enters it and standby shows "Tap the screen to go fullscreen". iPhone Safari has no element fullscreen, so use a black full-viewport page. |
| Low power mode | iOS caps rAF at 30 fps, which adds up to 33 ms. Accept it. |
| Backgrounded tab | rAF stops and the clock state is stale. On return, clear samples, burst, stay dark until ready again. |
| Display latency | Phones differ by 1 to 3 display frames (16 to 50 ms). This cannot be corrected. |
| Brightness | Browsers can neither set nor read screen brightness. The ready screen tells participants to turn it up. |

## 5. Architecture and protocol

### 5.1 Components

One Next.js app (App Router, TypeScript) run by a custom Node server. Next.js route handlers cannot accept WebSocket upgrades, so `server.ts` creates the HTTP server, passes HTTP requests to Next, and handles upgrades on `/ws` with the `ws` library.

| Component | Stack | Notes |
| --- | --- | --- |
| Custom server | `server.ts`: `http.createServer` + `next()` request handler + `ws` on `/ws` | One process. Holds live sessions in memory. Run with `tsx server.ts` in dev and as a compiled build in prod. |
| Storage | SQLite (`better-sqlite3`) for shows, local disk (`data/audio/`) for audio files | Enough for a hackathon. |
| Host pages | React client components, HTML canvas, wavesurfer.js for the waveform | Editor, show list, host screen. |
| Participant page | One client component with no extra dependencies | Loads on venue wifi. |
| Shared code | `lib/`: types, schedule compiler, `ClockSync` | Imported by the server, the editor preview, and the test harness. |

Routes:

| Path | Purpose |
| --- | --- |
| `/` | Show list |
| `/shows/[id]/edit` | Editor (2.1) |
| `/sessions/[code]/host` | Host screen: venue map, QR code, Start/Stop (2.2) |
| `/j/[code]` | Participant page (2.3). The QR code points here. |
| `/api/shows`, `/api/shows/[id]` | Show CRUD (route handlers) |
| `/api/audio` | Audio upload and download |
| `/ws` | WebSocket for participants and the host (5.2) |

Next.js constraints:

- **No serverless hosting.** A custom server and in-memory sessions rule out Vercel. Run `node` on a VM, or locally behind a tunnel.
- **Upgrade routing.** The `ws` upgrade handler must ignore paths other than `/ws` and hand them to `app.getUpgradeHandler()`. Without that, dev-mode HMR (`/_next/webpack-hmr`) stops working.
- **One session store.** Next bundles route handlers apart from `server.ts`, so a module-level `Map` can end up as two copies. Keep the session store on `globalThis` if a route handler needs to read it. A simpler option is to keep all session logic in the WebSocket layer and have route handlers touch only SQLite.
- **Bundle size.** The Next.js and React runtime adds about 90 KB gzipped to the participant page (estimate, check with `next build` output). That is acceptable on venue wifi. If it becomes a problem, serve `/j/[code]` as a static HTML page with a plain script from `public/`.

HTTPS is required for wake lock and for phones to trust the QR link. For local demos, run behind a tunnel (cloudflared or ngrok) or deploy to a host with TLS.

Cloudflare quick tunnels (`trycloudflare.com`, no account) allow 200 requests in flight and return 429 beyond that. Each WebSocket is a long-lived request, so assume it holds a slot. Quick tunnels are fine for development with a few phones. For a show, use a named Cloudflare tunnel on an account, or a VM with TLS.

### 5.2 WebSocket messages

All messages are JSON with a `type` field.

Participant to server:

| Type | Payload | When |
| --- | --- | --- |
| `join` | `{ code }` | Page load |
| `seat` | `{ x, y }` | Tap on venue |
| `ready` | `{}` | Tap Ready |
| `sync` | `{ c0 }` | Handshake |

Server to participant:

| Type | Payload | When |
| --- | --- | --- |
| `welcome` | `{ participantId, venue, state }` | After join. `state` includes `T0` if a show is running |
| `sync` | `{ c0, s1 }` | Handshake reply |
| `schedule` | `{ events, durationMs }` | After ready |
| `start` | `{ T0 }` | Host starts |
| `stop` | `{}` | Host stops |

Host to server: `host { showId }` to create a session, `start`, `stop`, and `positioning { config }` to set the camera seat sizes (2.4). The server sends `positioning { config }` to every participant and host when they change, and includes the current sizes in `welcome` and `session`.

Server to host: `session { code, joinUrl }`, `participants { list: [{ id, x, y, state, rttMs, degraded }] }` throttled to 4 updates per second, `start { T0 }`. The host also sends and receives `sync` messages for its own clock.

### 5.3 Participant states

| State | Meaning | Host map colour |
| --- | --- | --- |
| `connected` | Joined, no seat yet | Grey |
| `seated` | Seat chosen, not ready | Yellow |
| `syncing` | Ready tapped, clock not ready or schedule pending | Blue |
| `standby` | Clock ready (4.4) and schedule received | Green, with a warning marker if degraded |
| `playing` | Show running | Green, or the participant's current colour on the map |
| `disconnected` | Socket closed. Removed after 60 s | Red |

A participant only turns green once both the handshake and the schedule are done. Green means the phone can play the show without further network traffic.

## 6. Test harness

The harness simulates participants so sync can be tested without a room full of phones.

### 6.1 Simulated clients

A Node CLI, `scripts/sim.ts` (run with `tsx`), that imports `lib/` directly and:

1. Opens N WebSocket connections to a session (default 500).
2. Picks random seats inside the venue polygons.
3. Runs the full participant flow: join, seat, ready, handshake, schedule, standby.
4. On `start`, records for each schedule event the true time it would render. Each client runs the same `ClockSync` module as the browser, so the harness tests the real sync code.

Each simulated client gets injected faults:

| Fault | Default range |
| --- | --- |
| Clock offset | ±10 s from the real clock |
| Clock drift | ±50 ppm |
| One-way latency | 20 to 200 ms, asymmetric up and down |
| Jitter | ±30 ms per message |
| Packet delay spikes | 2% of messages delayed 500 ms |
| Disconnect and reconnect | 1% of clients, mid-show |

All simulated clients run in one process, so the harness knows the true time and measures each client's error directly. The reference repo's `test/sync_harness.mjs` runs N headless browsers that share the host's clock, so it tests the protocol without clock skew. Injecting offset and drift here covers that gap.

### 6.2 Output

- Sync error per event: `renderedTrueTime - (T0 + event.tMs)`. Report p50, p95, max across all clients. Fail the run if p95 exceeds 50 ms.
- Time from join to standby, p50 and p95.
- A live view: the host screen's map shows simulated dots in their current colour, so a wave should visibly sweep across.

### 6.3 Other tests

- Unit tests for the schedule compiler: fill, static polygon, moving polygon, layering, fades, seat on a polygon edge.
- Unit tests for the offset estimator with synthetic samples that have known offset and asymmetric latency.
- Playwright: 3 to 5 real browser contexts with mobile emulation run the participant page end to end, following the pattern in the reference repo's `test/sync_harness.mjs` (record the wall-clock time of each colour change, assert p95 spread under 50 ms).
- Unit tests for `ClockSync`: ready gate, degraded fallback after 6 s, slew rate, reset on resync.

### 6.4 Measuring real devices

Line up 5 to 10 phones, run a test show of hard black and white flashes, and film them with a phone slow-motion camera at 240 fps. Each video frame is about 4 ms. Count frames between the first and last phone to change.

## 7. Milestones

1. **Join and standby.** Participant page joins, picks a seat, taps Ready, turns green. Host screen shows dots and QR code. Hardcoded test show.
2. **Sync.** Clock handshake, scheduled start, rAF playback. Simulated-client harness with fault injection and error report. Do this before the editor: it is the riskiest part, and the harness is the only way to test it at scale.
3. **Schedule compiler.** Clip model, compiler, unit tests. Fill and static polygons first, then moving shapes and fades.
4. **Editor.** Venue drawing, audio import and waveform, clip drawing on the timeline, preview.
5. **Save and host.** Show persistence, show list, host flow end to end with audio playback.
6. **Real-device test.** Slow-motion camera measurement on real phones on venue-like wifi.

## 8. Open questions

Decided for the first version:

| Question | Decision |
| --- | --- |
| Participant count | Target 500 per session. One Node process holds that many WebSockets. The join burst is about 3,500 small messages per second each way for 2 s. Venue wifi is the likelier limit: plan for several enterprise access points or mobile data. |
| Colours | Any colour, picked per clip. |
| Venue shapes | Rectangles and straight-edged polygons. Approximate curves with polygons. |
| Seat outside every shape | Snap to the nearest point on the nearest shape edge. |
| Host authentication | None. |
| Editing during a live session | Not allowed. The session uses a snapshot of the show taken at host time. |

Still open:

- Is the venue wifi reliable enough, or do participants need to use mobile data? Sync works on either, but mobile data has higher and more variable latency, so convergence takes longer.
