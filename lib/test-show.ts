import type { Point, Schedule, ScheduleEvent, Show, Venue } from "./types";

/**
 * A hardcoded show used until the schedule compiler and show storage exist
 * (DEVELOPMENT.md chunks 1 to 9). `testSchedule(seat)` flashes white with a
 * delay proportional to `seat.x`, so the crowd shows a left-to-right wave.
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

/** One wave every period. */
export const TEST_WAVE_PERIOD_MS = 2_000;
/** Time for the wave to cross from x = 0 to x = 1. */
export const TEST_WAVE_SWEEP_MS = 1_000;
/** How long each seat stays white per wave. */
export const TEST_FLASH_MS = 250;
export const TEST_WAVE_COUNT = 10;
export const TEST_SHOW_DURATION_MS = TEST_WAVE_PERIOD_MS * TEST_WAVE_COUNT;

export const TEST_SHOW: Show = {
  id: TEST_SHOW_ID,
  name: "Test wave",
  venue: TEST_VENUE,
  audio: { fileId: "", durationMs: TEST_SHOW_DURATION_MS },
  clips: [],
  createdAt: "2026-11-20T00:00:00.000Z",
  updatedAt: "2026-11-20T00:00:00.000Z",
};

const BLACK = "#000000";
const WHITE = "#ffffff";

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
