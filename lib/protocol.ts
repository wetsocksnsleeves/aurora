import {
  PARTICIPANT_STATES,
  PATTERN_KINDS,
  type Clip,
  type ClipShape,
  type Direction,
  type PatternKind,
  type ParticipantState,
  type Point,
  type PositioningConfig,
  type ScheduleEvent,
  type Show,
  type Venue,
} from "./types";

/**
 * WebSocket messages (SPEC 5.2). Every message is JSON with a `type` field.
 *
 * `ClientMessage` is everything a participant or host sends to the server.
 * `ServerMessage` is everything the server sends to a participant or host.
 * `sync`, `start` and `stop` exist in both directions with different payloads,
 * so always parse with the function for the direction you are receiving.
 */

// ---------------------------------------------------------------------------
// Client to server
// ---------------------------------------------------------------------------

/**
 * Participant joins a session on page load. On reconnect the client sends the
 * `participantId` and `resumeToken` from its last `welcome` (kept in
 * sessionStorage) so the server keeps the same participant (seat, ready
 * state, schedule). Both must match; otherwise the server creates a new
 * participant.
 */
export type JoinMessage = {
  type: "join";
  code: string;
  participantId?: string;
  resumeToken?: string;
};

/** Participant tapped the venue. Normalised 0..1. */
export type SeatMessage = { type: "seat"; x: number; y: number };

/** Participant tapped Ready. */
export type ReadyMessage = { type: "ready" };

/**
 * Clock handshake request (SPEC 4.2). `c0` is the client's `performance.now()`.
 * Participants and hosts may send it, before or after `join`/`host`.
 */
export type SyncRequest = { type: "sync"; c0: number };

/**
 * Not in SPEC 5.2. The participant's `ClockSync` status (SPEC 4.4), sent when
 * it changes and again after every `welcome` (the server resets it on each
 * connection). Standby needs `ready`. `rttMs` is the best RTT, rounded, for
 * the host map.
 */
export type ClockStatusMessage = {
  type: "clock";
  ready: boolean;
  degraded: boolean;
  rttMs: number | null;
};

/**
 * Host creates a session for a show (`showId`), or re-attaches to an existing
 * session (`code`), for example when the host page reloads. Re-attaching
 * needs the `hostToken` from the `session` reply that created the session;
 * without the right one the server answers `error: not-host`.
 */
export type HostMessage =
  | { type: "host"; showId: string }
  | { type: "host"; code: string; hostToken?: string };

/**
 * Host clicked Start. Refused with `no-standby` unless at least one
 * participant is in standby, and with `show-running` while a show runs.
 */
export type StartRequest = { type: "start" };

/** Host clicked Stop. Participants go dark and back to standby. */
export type StopRequest = { type: "stop" };

/**
 * Not in SPEC 5.2. Host set the real-world sizes used to find seats with the
 * phone camera (SPEC 2.4). Host only. The server stores them on the session
 * and sends `positioning` to every participant and host.
 */
export type PositioningRequest = {
  type: "positioning";
  config: PositioningConfig;
};

/**
 * Not in SPEC 5.2. Host loads a show into its room, or reloads it after an
 * edit (SPEC 2.5). Phones stay connected: the server recompiles every
 * schedule from the new show and sends it. Refused with `show-running`
 * while a show plays.
 */
export type LoadShowRequest = { type: "load"; showId: string };

/**
 * Host only: put a participant at `x`, `y` in the room as the host sees it
 * (0..1, fitted to the crowd), for last-minute fixes. Holds until the phone
 * finds its seat again.
 */
export type PlaceRequest = {
  type: "place";
  participantId: string;
  x: number;
  y: number;
};

export type ClientMessage =
  | JoinMessage
  | SeatMessage
  | ReadyMessage
  | SyncRequest
  | ClockStatusMessage
  | HostMessage
  | StartRequest
  | StopRequest
  | PositioningRequest
  | LoadShowRequest
  | PlaceRequest;

export type ClientMessageType = ClientMessage["type"];

// ---------------------------------------------------------------------------
// Server to client
// ---------------------------------------------------------------------------

/** What a participant needs to resume after `welcome`. */
export type WelcomeState = {
  /** The participant's state (SPEC 5.3) at the time of `welcome`. */
  participant: ParticipantState;
  /** The seat chosen before a reconnect, or null. */
  seat: Point | null;
  /** Server-clock start time if a show is running, else null (SPEC 4.6). */
  T0: number | null;
};

export type WelcomeMessage = {
  type: "welcome";
  participantId: string;
  /**
   * Secret that proves this client owns `participantId` on rejoin. Sent only
   * to that participant, never to the host.
   */
  resumeToken: string;
  venue: Venue;
  state: WelcomeState;
  /** Sizes for finding the seat with the camera (SPEC 2.4). */
  positioning: PositioningConfig;
};

/** Clock handshake reply. `s1` is the server clock at reply time. */
export type SyncReply = { type: "sync"; c0: number; s1: number };

/** The participant's own schedule, sent after `ready` and on reconnect. */
export type ScheduleMessage = {
  type: "schedule";
  events: ScheduleEvent[];
  durationMs: number;
};

/**
 * Show starts at `T0` on the server clock (SPEC 4.6), `START_LEAD_MS` after
 * the host clicked Start. Sent to every participant and host. Show time is
 * `serverNow() - T0`.
 */
export type StartMessage = { type: "start"; T0: number };

/** The host stopped the show; `T0` is cleared. Sent to participants and hosts. */
export type StopMessage = { type: "stop" };

/**
 * Sent to the host after `host`. `venue`, `T0` and `show` are extras beyond
 * SPEC 5.2 so a reloaded host page can redraw the map and resume. `show` is
 * the session's show snapshot, so the host can colour playing dots with
 * `colorAt` and (chunk 15) find the audio. `hostToken` is set only in the
 * reply to the `host { showId }` that created the session; keep it
 * (sessionStorage) to re-attach.
 */
export type SessionMessage = {
  type: "session";
  code: string;
  joinUrl: string;
  showId: string;
  venue: Venue;
  T0: number | null;
  show: Show;
  /** Sizes for finding seats with the camera (SPEC 2.4). */
  positioning: PositioningConfig;
  hostToken?: string;
};

/** The session's positioning sizes changed. Sent to participants and hosts. */
export type PositioningMessage = {
  type: "positioning";
  config: PositioningConfig;
};

/** One dot on the host map. `x` and `y` are null until a seat is chosen. */
export type ParticipantSummary = {
  id: string;
  x: number | null;
  y: number | null;
  state: ParticipantState;
  rttMs: number | null;
  degraded: boolean;
};

/** Sent to the host, throttled to 4 per second. Always the full list. */
export type ParticipantsMessage = {
  type: "participants";
  list: ParticipantSummary[];
};

export const ERROR_REASONS = [
  "bad-message",
  "unknown-session",
  "unknown-show",
  "not-joined",
  "not-host",
  "no-seat",
  "unsupported",
  /** `start` with no participant in standby. */
  "no-standby",
  /** `start` while a show is already running. */
  "show-running",
] as const;

export type ErrorReason = (typeof ERROR_REASONS)[number];

/** Not in SPEC 5.2. Tells the client why a message was refused. */
export type ErrorMessage = {
  type: "error";
  reason: ErrorReason;
  message: string;
};

export type ServerMessage =
  | WelcomeMessage
  | SyncReply
  | ScheduleMessage
  | StartMessage
  | StopMessage
  | SessionMessage
  | ParticipantsMessage
  | PositioningMessage
  | ErrorMessage;

export type ServerMessageType = ServerMessage["type"];

/** Pick one member of a message union by its `type`. */
export type MessageOfType<
  M extends { type: string },
  T extends M["type"],
> = Extract<M, { type: T }>;

// ---------------------------------------------------------------------------
// Encoding and parsing
// ---------------------------------------------------------------------------

export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

export type ParseResult<M> =
  { ok: true; message: M } | { ok: false; error: string };

export type MessageDirection = "client" | "server";

/**
 * Parse and validate a raw JSON message. `from` is who sent it: the server
 * parses with "client", browsers and the harness parse with "server".
 * Unknown fields are dropped. Never throws.
 */
export function parseMessage(
  raw: string,
  from: "client",
): ParseResult<ClientMessage>;
export function parseMessage(
  raw: string,
  from: "server",
): ParseResult<ServerMessage>;
export function parseMessage(
  raw: string,
  from: MessageDirection,
): ParseResult<ClientMessage | ServerMessage> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return fail("not valid JSON");
  }
  if (!isRecord(value) || typeof value.type !== "string") {
    return fail("expected an object with a string `type`");
  }
  try {
    const message =
      from === "client" ? toClientMessage(value) : toServerMessage(value);
    return { ok: true, message };
  } catch (err) {
    if (err instanceof InvalidMessage) return fail(err.message);
    throw err;
  }
}

/** Parse a message sent by a participant or host. */
export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  return parseMessage(raw, "client");
}

/** Parse a message sent by the server. */
export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  return parseMessage(raw, "server");
}

// Limits on client input. Generous, but bounded.
const MAX_ID_LENGTH = 128;

function toClientMessage(v: Rec): ClientMessage {
  switch (v.type) {
    case "join": {
      const msg: JoinMessage = { type: "join", code: str(v, "code", 16) };
      if (v.participantId !== undefined && v.participantId !== null) {
        msg.participantId = str(v, "participantId", MAX_ID_LENGTH);
      }
      if (v.resumeToken !== undefined && v.resumeToken !== null) {
        msg.resumeToken = str(v, "resumeToken", MAX_ID_LENGTH);
      }
      return msg;
    }
    case "seat":
      return { type: "seat", x: unit(v, "x"), y: unit(v, "y") };
    case "ready":
      return { type: "ready" };
    case "sync":
      return { type: "sync", c0: num(v, "c0") };
    case "clock": {
      const rttMs = nullableNum(v, "rttMs");
      if (rttMs !== null && rttMs < 0) {
        throw new InvalidMessage("`rttMs` must not be negative");
      }
      return {
        type: "clock",
        ready: bool(v, "ready"),
        degraded: bool(v, "degraded"),
        rttMs,
      };
    }
    case "host": {
      const hasShow = v.showId !== undefined;
      const hasCode = v.code !== undefined;
      if (hasShow === hasCode) {
        throw new InvalidMessage("host needs exactly one of `showId`, `code`");
      }
      if (hasShow) {
        return { type: "host", showId: str(v, "showId", MAX_ID_LENGTH) };
      }
      const msg: HostMessage = { type: "host", code: str(v, "code", 16) };
      if (v.hostToken !== undefined && v.hostToken !== null) {
        msg.hostToken = str(v, "hostToken", MAX_ID_LENGTH);
      }
      return msg;
    }
    case "start":
      return { type: "start" };
    case "stop":
      return { type: "stop" };
    case "positioning":
      return { type: "positioning", config: positioningConfig(v.config) };
    case "load":
      return { type: "load", showId: str(v, "showId", MAX_ID_LENGTH) };
    case "place":
      return {
        type: "place",
        participantId: str(v, "participantId", MAX_ID_LENGTH),
        x: unit(v, "x"),
        y: unit(v, "y"),
      };
    default:
      throw new InvalidMessage(`unknown client message type "${v.type}"`);
  }
}

function toServerMessage(v: Rec): ServerMessage {
  switch (v.type) {
    case "welcome": {
      const state = rec(v, "state");
      return {
        type: "welcome",
        participantId: str(v, "participantId"),
        resumeToken: str(v, "resumeToken"),
        venue: venue(v.venue),
        state: {
          participant: participantState(state, "participant"),
          seat: state.seat == null ? null : point(state.seat),
          T0: nullableNum(state, "T0"),
        },
        positioning: positioningConfig(v.positioning),
      };
    }
    case "sync":
      return { type: "sync", c0: num(v, "c0"), s1: num(v, "s1") };
    case "schedule":
      return {
        type: "schedule",
        events: arr(v, "events").map(scheduleEvent),
        durationMs: num(v, "durationMs"),
      };
    case "start":
      return { type: "start", T0: num(v, "T0") };
    case "stop":
      return { type: "stop" };
    case "session": {
      const msg: SessionMessage = {
        type: "session",
        code: str(v, "code"),
        joinUrl: str(v, "joinUrl"),
        showId: str(v, "showId"),
        venue: venue(v.venue),
        T0: nullableNum(v, "T0"),
        show: show(v.show),
        positioning: positioningConfig(v.positioning),
      };
      if (v.hostToken !== undefined && v.hostToken !== null) {
        msg.hostToken = str(v, "hostToken");
      }
      return msg;
    }
    case "participants":
      return {
        type: "participants",
        list: arr(v, "list").map(participantSummary),
      };
    case "positioning":
      return { type: "positioning", config: positioningConfig(v.config) };
    case "error": {
      const reason = str(v, "reason");
      if (!(ERROR_REASONS as readonly string[]).includes(reason)) {
        throw new InvalidMessage(`unknown error reason "${reason}"`);
      }
      return {
        type: "error",
        reason: reason as ErrorReason,
        message: str(v, "message"),
      };
    }
    default:
      throw new InvalidMessage(`unknown server message type "${v.type}"`);
  }
}

// ---------------------------------------------------------------------------
// Field validators. Each throws InvalidMessage with the field name.
// ---------------------------------------------------------------------------

type Rec = Record<string, unknown>;

class InvalidMessage extends Error {}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rec(v: Rec, key: string): Rec {
  const value = v[key];
  if (!isRecord(value))
    throw new InvalidMessage(`\`${key}\` must be an object`);
  return value;
}

function arr(v: Rec, key: string): unknown[] {
  const value = v[key];
  if (!Array.isArray(value)) {
    throw new InvalidMessage(`\`${key}\` must be an array`);
  }
  return value;
}

function str(v: Rec, key: string, maxLength = Infinity): string {
  const value = v[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidMessage(`\`${key}\` must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new InvalidMessage(`\`${key}\` is longer than ${maxLength}`);
  }
  return value;
}

function num(v: Rec, key: string): number {
  const value = v[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new InvalidMessage(`\`${key}\` must be a finite number`);
  }
  return value;
}

function bool(v: Rec, key: string): boolean {
  const value = v[key];
  if (typeof value !== "boolean") {
    throw new InvalidMessage(`\`${key}\` must be a boolean`);
  }
  return value;
}

function nullableNum(v: Rec, key: string): number | null {
  return v[key] === null || v[key] === undefined ? null : num(v, key);
}

/** A number in 0..1, for normalised coordinates. */
function unit(v: Rec, key: string): number {
  const value = num(v, key);
  if (value < 0 || value > 1) {
    throw new InvalidMessage(`\`${key}\` must be between 0 and 1`);
  }
  return value;
}

/** A real-world length in metres: positive and venue-sized. */
function metres(v: Rec, key: string): number {
  const value = num(v, key);
  if (value <= 0 || value > 1000) {
    throw new InvalidMessage(`\`${key}\` must be between 0 and 1000 metres`);
  }
  return value;
}

function positioningConfig(value: unknown): PositioningConfig {
  if (!isRecord(value)) {
    throw new InvalidMessage("positioning `config` must be an object");
  }
  return {
    targetWidthM: metres(value, "targetWidthM"),
    venueWidthM: metres(value, "venueWidthM"),
    venueDepthM: metres(value, "venueDepthM"),
  };
}

function point(value: unknown): Point {
  if (!isRecord(value)) throw new InvalidMessage("point must be an object");
  return { x: num(value, "x"), y: num(value, "y") };
}

function venue(value: unknown): Venue {
  if (!isRecord(value)) throw new InvalidMessage("`venue` must be an object");
  return {
    shapes: arr(value, "shapes").map((shape) => {
      if (!isRecord(shape)) throw new InvalidMessage("shape must be an object");
      return { id: str(shape, "id"), points: arr(shape, "points").map(point) };
    }),
  };
}

/** A string that may be empty (e.g. a show without audio has fileId ""). */
function text(v: Rec, key: string): string {
  const value = v[key];
  if (typeof value !== "string") {
    throw new InvalidMessage(`\`${key}\` must be a string`);
  }
  return value;
}

function show(value: unknown): Show {
  if (!isRecord(value)) throw new InvalidMessage("`show` must be an object");
  const audio = rec(value, "audio");
  return {
    id: str(value, "id"),
    name: text(value, "name"),
    venue: venue(value.venue),
    audio: {
      fileId: text(audio, "fileId"),
      durationMs: num(audio, "durationMs"),
    },
    clips: arr(value, "clips").map(clip),
    createdAt: text(value, "createdAt"),
    updatedAt: text(value, "updatedAt"),
  };
}

function clip(value: unknown): Clip {
  if (!isRecord(value)) throw new InvalidMessage("clip must be an object");
  const parsed: Clip = {
    id: str(value, "id"),
    layer: num(value, "layer"),
    startMs: num(value, "startMs"),
    endMs: num(value, "endMs"),
    color: str(value, "color"),
    fadeInMs: num(value, "fadeInMs"),
    fadeOutMs: num(value, "fadeOutMs"),
    shape: clipShape(rec(value, "shape")),
  };
  if (value.blink !== undefined && value.blink !== null) {
    const b = rec(value, "blink");
    parsed.blink = {
      periodMs: num(b, "periodMs"),
      duty: num(b, "duty"),
      soft: bool(b, "soft"),
    };
  }
  if (value.label !== undefined && value.label !== null) {
    parsed.label = str(value, "label");
  }
  return parsed;
}

const DIRECTIONS: readonly Direction[] = ["left", "right", "up", "down"];

function clipShape(v: Rec): ClipShape {
  if (v.kind === "fill") return { kind: "fill" };
  if (v.kind === "pattern") {
    const pattern = str(v, "pattern") as PatternKind;
    const direction = str(v, "direction") as Direction;
    if (!PATTERN_KINDS.includes(pattern) || !DIRECTIONS.includes(direction)) {
      throw new InvalidMessage("clip pattern or direction is not known");
    }
    return {
      kind: "pattern",
      pattern,
      direction,
      size: num(v, "size"),
      stepMs: num(v, "stepMs"),
      from: num(v, "from"),
      to: num(v, "to"),
    };
  }
  if (v.kind !== "polygon") {
    throw new InvalidMessage(
      "clip `shape.kind` must be fill, polygon or pattern",
    );
  }
  const shape: ClipShape = {
    kind: "polygon",
    points: arr(v, "points").map(point),
  };
  if (v.moveTo !== undefined && v.moveTo !== null) {
    shape.moveTo = point(v.moveTo);
  }
  return shape;
}

function scheduleEvent(value: unknown): ScheduleEvent {
  if (!isRecord(value)) throw new InvalidMessage("event must be an object");
  return { tMs: num(value, "tMs"), color: str(value, "color") };
}

const STATES: readonly string[] = PARTICIPANT_STATES;

function participantState(v: Rec, key: string): ParticipantState {
  const value = str(v, key);
  if (!STATES.includes(value)) {
    throw new InvalidMessage(`\`${key}\` is not a participant state`);
  }
  return value as ParticipantState;
}

function participantSummary(value: unknown): ParticipantSummary {
  if (!isRecord(value))
    throw new InvalidMessage("participant must be an object");
  return {
    id: str(value, "id"),
    x: nullableNum(value, "x"),
    y: nullableNum(value, "y"),
    state: participantState(value, "state"),
    rttMs: nullableNum(value, "rttMs"),
    degraded: value.degraded === true,
  };
}
