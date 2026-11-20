import {
  PARTICIPANT_STATES,
  type ParticipantState,
  type Point,
  type ScheduleEvent,
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

/** Clock handshake request (SPEC 4.2). `c0` is the client's `performance.now()`. */
export type SyncRequest = { type: "sync"; c0: number };

/**
 * Host creates a session for a show (`showId`), or re-attaches to an existing
 * session (`code`), for example when the host page reloads.
 */
export type HostMessage =
  { type: "host"; showId: string } | { type: "host"; code: string };

/** Host clicked Start. */
export type StartRequest = { type: "start" };

/** Host clicked Stop. */
export type StopRequest = { type: "stop" };

export type ClientMessage =
  | JoinMessage
  | SeatMessage
  | ReadyMessage
  | SyncRequest
  | HostMessage
  | StartRequest
  | StopRequest;

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
};

/** Clock handshake reply. `s1` is the server clock at reply time. */
export type SyncReply = { type: "sync"; c0: number; s1: number };

/** The participant's own schedule, sent after `ready` and on reconnect. */
export type ScheduleMessage = {
  type: "schedule";
  events: ScheduleEvent[];
  durationMs: number;
};

/** Show starts at `T0` on the server clock. Sent to participants and host. */
export type StartMessage = { type: "start"; T0: number };

export type StopMessage = { type: "stop" };

/**
 * Sent to the host after `host`. `venue` and `T0` are extras beyond SPEC 5.2
 * so a reloaded host page can redraw the map and resume.
 */
export type SessionMessage = {
  type: "session";
  code: string;
  joinUrl: string;
  showId: string;
  venue: Venue;
  T0: number | null;
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
    case "host": {
      const hasShow = v.showId !== undefined;
      const hasCode = v.code !== undefined;
      if (hasShow === hasCode) {
        throw new InvalidMessage("host needs exactly one of `showId`, `code`");
      }
      return hasShow
        ? { type: "host", showId: str(v, "showId", MAX_ID_LENGTH) }
        : { type: "host", code: str(v, "code", 16) };
    }
    case "start":
      return { type: "start" };
    case "stop":
      return { type: "stop" };
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
    case "session":
      return {
        type: "session",
        code: str(v, "code"),
        joinUrl: str(v, "joinUrl"),
        showId: str(v, "showId"),
        venue: venue(v.venue),
        T0: nullableNum(v, "T0"),
      };
    case "participants":
      return {
        type: "participants",
        list: arr(v, "list").map(participantSummary),
      };
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
