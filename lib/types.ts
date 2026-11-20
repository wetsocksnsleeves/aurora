/**
 * Domain types shared by the server, the browser and the test harness.
 * Shapes follow SPEC 3.2 and 3.3.
 */

/** A point in venue space, normalised to 0..1 on both axes. */
export type Point = { x: number; y: number };

/** One closed polygon. A rectangle is 4 points. */
export type VenueShape = { id: string; points: Point[] };

/** The outline of the seating area, drawn by the host. */
export type Venue = { shapes: VenueShape[] };

export type ClipShape =
  | { kind: "fill" }
  /** `moveTo` is the offset at `endMs`, interpolated linearly from `startMs`. */
  | { kind: "polygon"; points: Point[]; moveTo?: Point };

/** One drawn shape on the timeline. */
export type Clip = {
  id: string;
  /** Higher draws on top. */
  layer: number;
  startMs: number;
  endMs: number;
  /** CSS hex colour, e.g. "#ffffff". */
  color: string;
  fadeInMs: number;
  fadeOutMs: number;
  shape: ClipShape;
};

export type Show = {
  id: string;
  name: string;
  venue: Venue;
  audio: { fileId: string; durationMs: number };
  clips: Clip[];
  /** ISO 8601 timestamps. */
  createdAt: string;
  updatedAt: string;
};

/** One colour change. `tMs` is show time (ms after `T0`). */
export type ScheduleEvent = { tMs: number; color: string };

/** Per-participant list of colour changes, sorted by `tMs` (SPEC 3.3). */
export type Schedule = { events: ScheduleEvent[] };

/** Participant states and their meaning (SPEC 5.3). */
export const PARTICIPANT_STATES = [
  "connected",
  "seated",
  "syncing",
  "standby",
  "playing",
  "disconnected",
] as const;

export type ParticipantState = (typeof PARTICIPANT_STATES)[number];
