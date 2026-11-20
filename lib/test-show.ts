import type {
  Clip,
  Point,
  Schedule,
  ScheduleEvent,
  Show,
  Venue,
} from "./types";

/**
 * A hardcoded show for development and the sync tests. Its clips are white
 * vertical bands that sweep left to right, so the crowd shows a wave. The
 * server compiles it like any other show. `testSchedule(seat)` is the same
 * wave computed directly; the compiler's output matches it to within one
 * 20 ms sample.
 */

/** `showId` to send in `host` to get a session for the test show. */
export const TEST_SHOW_ID = "test";

/** Two seating blocks either side of a centre aisle, stage at the top. */
export const TEST_VENUE: Venue = {
  shapes: [
    {
      id: "left",
      points: [
        { x: 0.05, y: 0.2 },
        { x: 0.45, y: 0.2 },
        { x: 0.45, y: 0.9 },
        { x: 0.05, y: 0.9 },
      ],
    },
    {
      id: "right",
      points: [
        { x: 0.55, y: 0.2 },
        { x: 0.95, y: 0.2 },
        { x: 0.95, y: 0.9 },
        { x: 0.55, y: 0.9 },
      ],
    },
  ],
};

const BLACK = "#000000";
const WHITE = "#ffffff";

/** One wave every period. */
export const TEST_WAVE_PERIOD_MS = 2_000;
/** Time for the wave to cross from x = 0 to x = 1. */
export const TEST_WAVE_SWEEP_MS = 1_000;
/** How long each seat stays white per wave. */
export const TEST_FLASH_MS = 250;
export const TEST_WAVE_COUNT = 10;
export const TEST_SHOW_DURATION_MS = TEST_WAVE_PERIOD_MS * TEST_WAVE_COUNT;

/**
 * One clip per wave: a band `TEST_FLASH_MS` of sweep wide that starts just
 * left of x = 0 and moves right at 1 venue width per `TEST_WAVE_SWEEP_MS`, so
 * a seat at x is lit from `x * sweep` for `TEST_FLASH_MS`.
 */
function waveClips(): Clip[] {
  const width = TEST_FLASH_MS / TEST_WAVE_SWEEP_MS;
  const durationMs = TEST_WAVE_SWEEP_MS + TEST_FLASH_MS;
  return Array.from({ length: TEST_WAVE_COUNT }, (_, wave) => ({
    id: `wave-${wave}`,
    layer: 0,
    startMs: wave * TEST_WAVE_PERIOD_MS,
    endMs: wave * TEST_WAVE_PERIOD_MS + durationMs,
    color: WHITE,
    fadeInMs: 0,
    fadeOutMs: 0,
    shape: {
      kind: "polygon",
      // The trailing (left) edge is pulled in a hair so a seat's flash ends
      // on time instead of one sample late (polygon edges count as inside).
      points: [
        { x: -width + 1e-4, y: -1 },
        { x: 0, y: -1 },
        { x: 0, y: 2 },
        { x: -width + 1e-4, y: 2 },
      ],
      moveTo: { x: durationMs / TEST_WAVE_SWEEP_MS, y: 0 },
    },
  }));
}

export const TEST_SHOW: Show = {
  id: TEST_SHOW_ID,
  name: "Test wave",
  venue: TEST_VENUE,
  audio: { fileId: "", durationMs: TEST_SHOW_DURATION_MS },
  clips: waveClips(),
  createdAt: "2026-11-20T00:00:00.000Z",
  updatedAt: "2026-11-20T00:00:00.000Z",
};

/**
 * Schedule for one seat: black, then a white flash in every wave period,
 * delayed by `seat.x * TEST_WAVE_SWEEP_MS`. Events are sorted by `tMs`.
 */
export function testSchedule(seat: Point): Schedule {
  const x = Math.min(1, Math.max(0, seat.x));
  const delayMs = Math.round(x * TEST_WAVE_SWEEP_MS);
  const events: ScheduleEvent[] = [{ tMs: 0, color: BLACK }];
  for (let wave = 0; wave < TEST_WAVE_COUNT; wave++) {
    const onMs = wave * TEST_WAVE_PERIOD_MS + delayMs;
    if (onMs === 0) events.pop();
    events.push({ tMs: onMs, color: WHITE });
    events.push({ tMs: onMs + TEST_FLASH_MS, color: BLACK });
  }
  return { events };
}
