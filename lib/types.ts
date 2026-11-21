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

/** Which way an effect travels. "up" is towards the screen. */
export type Direction = "left" | "right" | "up" | "down";

/** Built-in effects worked out per seat (`lib/patterns.ts`). */
export type PatternKind = "wave" | "split" | "chase" | "sparkle";

export const PATTERN_KINDS: readonly PatternKind[] = [
  "wave",
  "split",
  "chase",
  "sparkle",
];

export type PatternShape = {
  kind: "pattern";
  pattern: PatternKind;
  direction: Direction;
  /** 0..1: band width (wave, split), column width (chase), density (sparkle). */
  size: number;
  /** Ms per step (chase) or per twinkle (sparkle). */
  stepMs: number;
  /**
   * The part of the movement this clip plays, 0..1 over its length (wave,
   * split). A split clip keeps moving from where the first half stopped.
   */
  from: number;
  to: number;
};

export type ClipShape =
  | { kind: "fill" }
  /** `moveTo` is the offset at `endMs`, interpolated linearly from `startMs`. */
  | { kind: "polygon"; points: Point[]; moveTo?: Point }
  | PatternShape;

/**
 * Switch a clip on and off. Phase follows show time, so a blink every beat
 * stays on the beat wherever the clip starts.
 */
export type Blink = {
  periodMs: number;
  /** Share of each period that is on (hard blink). */
  duty: number;
  /** Soft: a pulse that hits at the start of each period and fades out. */
  soft: boolean;
};

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
  blink?: Blink;
  /** Name on the timeline, e.g. "Strobe". Defaults from the shape. */
  label?: string;
};

export type Show = {
  id: string;
  name: string;
  venue: Venue;
  audio: {
    fileId: string;
    durationMs: number;
    /** Track name from the file's tags, or its file name. */
    title?: string;
    /** From the file's tags, when it has one. */
    artist?: string;
  };
  clips: Clip[];
  /** ISO 8601 timestamps. */
  createdAt: string;
  updatedAt: string;
};

/**
 * Real-world sizes for finding seats with the phone camera, set by the host
 * per session. The big screen shows a target whose left and right anchor
 * centres are `targetWidthM` apart; the venue drawing's 0..1 box spans
 * `venueWidthM` across and `venueDepthM` back from the screen, which is
 * centred on the drawing's top edge (the stage).
 */
export type PositioningConfig = {
  targetWidthM: number;
  venueWidthM: number;
  venueDepthM: number;
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
