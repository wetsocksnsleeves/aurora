import type { ScheduleEvent } from "./types";

/**
 * Participant playback (SPEC 4.7) as pure functions, so the page's
 * requestAnimationFrame loop stays a few lines and the lookup is unit tested.
 */

/** Colour shown before `T0`, while the clock is not ready, and between events. */
export const DARK = "#000000";

/**
 * Index of the last event with `tMs <= showMs`, or -1 if there is none
 * (before the first event). Binary search; `events` must be sorted by `tMs`.
 */
export function eventIndexAt(
  events: readonly ScheduleEvent[],
  showMs: number,
): number {
  let lo = 0;
  let hi = events.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid]!.tMs <= showMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Forward steps a cursor takes before it falls back to a binary search. */
const MAX_LINEAR_STEPS = 8;

/**
 * A cursor into one schedule's events. Frames move forward in time, so the
 * usual step is zero or one event ahead. A jump back (the applied offset
 * slewed backwards, or a stop and restart) or far ahead (a late joiner,
 * a tab back from hidden) re-seeks with a binary search.
 */
export class ScheduleCursor {
  private index = -1;

  constructor(readonly events: readonly ScheduleEvent[]) {}

  /** The colour at `showMs`: the last event at or before it, else `DARK`. */
  colorAt(showMs: number): string {
    const events = this.events;
    let i = this.index;
    if (i >= 0 && events[i]!.tMs > showMs) {
      i = eventIndexAt(events, showMs);
    } else {
      let steps = 0;
      while (i + 1 < events.length && events[i + 1]!.tMs <= showMs) {
        if (++steps > MAX_LINEAR_STEPS) {
          i = eventIndexAt(events, showMs);
          break;
        }
        i += 1;
      }
    }
    this.index = i;
    return i >= 0 ? events[i]!.color : DARK;
  }

  /** The cursor's current event index, for tests. */
  get position(): number {
    return this.index;
  }
}

export type PlaybackInput = {
  /** `ClockSync.ready`. */
  clockReady: boolean;
  /** Server-clock start time, or null when no show runs. */
  T0: number | null;
  /** The participant's schedule, or null while pending. */
  schedule: { events: readonly ScheduleEvent[]; durationMs: number } | null;
  /** `ClockSync.serverNow()` this frame. */
  serverNow: number;
};

export type PlaybackFrame =
  /** Paint black: no show, clock not ready, no schedule, or before `T0`. */
  | { kind: "dark" }
  | { kind: "color"; color: string; showMs: number }
  /** Past `durationMs`: show the "Show over" screen. */
  | { kind: "over" };

/**
 * What to show this frame (SPEC 4.7). `cursor` must be a cursor over
 * `input.schedule.events`; the caller swaps it when the schedule changes.
 */
export function playbackFrame(
  input: PlaybackInput,
  cursor: ScheduleCursor | null,
): PlaybackFrame {
  if (!input.clockReady || input.T0 === null || !input.schedule || !cursor) {
    return { kind: "dark" };
  }
  const showMs = input.serverNow - input.T0;
  if (showMs >= input.schedule.durationMs) return { kind: "over" };
  if (showMs < 0) return { kind: "dark" };
  return { kind: "color", color: cursor.colorAt(showMs), showMs };
}
