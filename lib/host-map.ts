import { colorAt } from "./compile";
import type { ParticipantSummary } from "./protocol";
import { PARTICIPANT_STATES, type ParticipantState, type Show } from "./types";

/**
 * Pure helpers for the host map (SPEC 2.2, 5.3): dot colours by state,
 * counts per state, and the dot list for `VenueView`.
 */

/** Host map colour per participant state (SPEC 5.3). */
export const STATE_COLORS: Record<ParticipantState, string> = {
  connected: "#9ca3af", // grey
  seated: "#facc15", // yellow
  syncing: "#3b82f6", // blue
  standby: "#22c55e", // green
  playing: "#22c55e", // green; `liveDotColor` shows the show colour instead
  disconnected: "#ef4444", // red
};

export const STATE_LABELS: Record<ParticipantState, string> = {
  connected: "Joined",
  seated: "Seated",
  syncing: "Syncing",
  standby: "Ready",
  playing: "Playing",
  disconnected: "Disconnected",
};

export type StateCounts = Record<ParticipantState, number> & { total: number };

export function countByState(list: readonly ParticipantSummary[]): StateCounts {
  const counts = { total: list.length } as StateCounts;
  for (const state of PARTICIPANT_STATES) counts[state] = 0;
  for (const p of list) counts[p.state] += 1;
  return counts;
}

/** A dot for `VenueView` (structurally `VenueDot`). */
export type HostDot = {
  id: string;
  x: number;
  y: number;
  color: string;
  warning: boolean;
  title: string;
};

/**
 * One dot per seated participant. Participants without a seat have no
 * position and are left out (they still count in `countByState`). The warning
 * marker shows a degraded clock (SPEC 4.4, 5.3). `colorOf` lets the host
 * override a dot's colour, e.g. with the live show colour while playing.
 */
export function participantDots(
  list: readonly ParticipantSummary[],
  colorOf: (p: ParticipantSummary) => string = (p) => STATE_COLORS[p.state],
): HostDot[] {
  const dots: HostDot[] = [];
  for (const p of list) {
    if (p.x === null || p.y === null) continue;
    const rtt = p.rttMs === null ? "" : `, ${Math.round(p.rttMs)} ms RTT`;
    dots.push({
      id: p.id,
      x: p.x,
      y: p.y,
      color: colorOf(p),
      warning: p.degraded,
      title: `${STATE_LABELS[p.state]}${p.degraded ? " (degraded clock)" : ""}${rtt}`,
    });
  }
  return dots;
}

/**
 * `colorOf` for `participantDots` while a show runs: a playing participant's
 * dot shows the colour its phone shows at `showMs` (`colorAt` on the show
 * snapshot), everyone else keeps their state colour. Cheap enough to call for
 * every dot on every frame.
 */
export function liveDotColor(
  show: Show,
  showMs: number,
): (p: ParticipantSummary) => string {
  return (p) =>
    p.state === "playing" && p.x !== null && p.y !== null
      ? colorAt(show, { x: p.x, y: p.y }, showMs)
      : STATE_COLORS[p.state];
}

/** Host status line while a show is scheduled or running. */
export function showStatus(showMs: number, durationMs: number): string {
  if (showMs < 0) return `Starting in ${(-showMs / 1000).toFixed(1)} s`;
  if (showMs >= durationMs) return "Show over";
  return `Playing ${clockText(showMs)} / ${clockText(durationMs)}`;
}

/** `m:ss`, rounded down to the second. */
export function clockText(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
