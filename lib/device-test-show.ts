import type { Clip, Show, Venue } from "./types";

/**
 * Built-in show for measuring real phones (SPEC 6.4, DEVELOPMENT.md chunk
 * 16): the whole venue flashes hard white on black once a second. Every
 * phone shows the same colour at the same show time wherever it sits, so a
 * slow-motion video of a row of phones shows the sync spread directly.
 * No audio file: turn on the host's click track to hear the flashes.
 */

/** `showId` to send in `host` for this show. */
export const DEVICE_TEST_SHOW_ID = "device-test";

/** One second of black after Start, so the first flash is a clean edge. */
export const DEVICE_TEST_LEAD_IN_MS = 1_000;
/** One flash per period (1 Hz). */
export const DEVICE_TEST_PERIOD_MS = 1_000;
/** White for half of each period: both edges can be measured. */
export const DEVICE_TEST_FLASH_MS = 500;
export const DEVICE_TEST_FLASH_COUNT = 60;
export const DEVICE_TEST_DURATION_MS =
  DEVICE_TEST_LEAD_IN_MS + DEVICE_TEST_FLASH_COUNT * DEVICE_TEST_PERIOD_MS;

const WHITE = "#ffffff";

/** One block of seats. Any seat inside it sees every flash. */
export const DEVICE_TEST_VENUE: Venue = {
  shapes: [
    {
      id: "floor",
      points: [
        { x: 0.05, y: 0.15 },
        { x: 0.95, y: 0.15 },
        { x: 0.95, y: 0.9 },
        { x: 0.05, y: 0.9 },
      ],
    },
  ],
};

/** Show time (ms) at which flash `index` (0-based) turns white. */
export function deviceTestFlashMs(index: number): number {
  return DEVICE_TEST_LEAD_IN_MS + index * DEVICE_TEST_PERIOD_MS;
}

function flashClips(): Clip[] {
  return Array.from({ length: DEVICE_TEST_FLASH_COUNT }, (_, i) => ({
    id: `flash-${i + 1}`,
    layer: 0,
    startMs: deviceTestFlashMs(i),
    endMs: deviceTestFlashMs(i) + DEVICE_TEST_FLASH_MS,
    color: WHITE,
    fadeInMs: 0,
    fadeOutMs: 0,
    shape: { kind: "fill" },
  }));
}

export const DEVICE_TEST_SHOW: Show = {
  id: DEVICE_TEST_SHOW_ID,
  name: "Device test (1 Hz flashes)",
  venue: DEVICE_TEST_VENUE,
  audio: { fileId: "", durationMs: DEVICE_TEST_DURATION_MS },
  clips: flashClips(),
  createdAt: "2026-11-21T00:00:00.000Z",
  updatedAt: "2026-11-21T00:00:00.000Z",
};
