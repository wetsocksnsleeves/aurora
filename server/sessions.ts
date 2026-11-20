import { randomInt, randomUUID } from "node:crypto";
import type { ErrorReason, ParticipantSummary } from "@/lib/protocol";
import type { ParticipantState, Point, Schedule, Show } from "@/lib/types";

/**
 * In-memory session store (SPEC 2.2, 5.3). Holds no sockets, so it can be
 * unit tested on its own. `server/ws.ts` maps sockets to participants.
 *
 * A participant's state is derived from facts (connected, seat, ready tapped,
 * schedule, clock, show running) by `deriveState`, and recomputed after every
 * change, so the 5.3 table is enforced in one place.
 */

/** No O/0 or I/1, so codes read aloud or off a screen are unambiguous. */
export const JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const JOIN_CODE_LENGTH = 6;

/** Disconnected participants are removed after this long (SPEC 5.3). */
export const DISCONNECT_REMOVAL_MS = 60_000;

/** A participant's schedule plus the show length, as sent in `schedule`. */
export type TimedSchedule = Schedule & { durationMs: number };

/** Clock status a participant reports (SPEC 4.4). Filled in by chunk 4. */
export type ClockStatus = {
  ready: boolean;
  degraded: boolean;
  rttMs: number | null;
};

export type Participant = {
  id: string;
  /** Derived. Do not set directly; call a store method. */
  state: ParticipantState;
  seat: Point | null;
  /** The participant tapped Ready. Survives reconnects. */
  readyTapped: boolean;
  /** The last schedule computed for the current seat, or null if pending. */
  schedule: TimedSchedule | null;
  /**
   * Bumped on every change that makes the schedule stale (ready, seat move).
   * An async compile only lands if the version still matches.
   */
  scheduleVersion: number;
  clock: ClockStatus;
  connected: boolean;
  /** Bumped on every (re)connect, so a stale socket cannot disconnect a newer one. */
  connectionToken: number;
  disconnectedAt: number | null;
  joinedAt: number;
};

export type Session = {
  code: string;
  showId: string;
  /** Snapshot of the show taken at host time (SPEC section 8). */
  show: Show;
  createdAt: number;
  /** Server-clock start time while a show runs, else null (SPEC 4.6). */
  T0: number | null;
  participants: Map<string, Participant>;
};

/** Thrown by store methods. `reason` maps onto the protocol `error` message. */
export class SessionError extends Error {
  constructor(
    readonly reason: ErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "SessionError";
  }
}

export type SessionStoreOptions = {
  /** Clock for joinedAt and disconnect expiry. Defaults to `Date.now`. */
  now?: () => number;
  /** Random integer in [0, max). Defaults to `crypto.randomInt`. */
  randomInt?: (max: number) => number;
  /** Id generator. Defaults to `crypto.randomUUID`. */
  newId?: () => string;
  /**
   * Standby also requires a ready clock (SPEC 4.4). False until the clock
   * handshake lands in chunk 4, so standby means "schedule sent" for now.
   */
  requireClockSync?: boolean;
};

const INITIAL_CLOCK: ClockStatus = {
  ready: false,
  degraded: false,
  rttMs: null,
};

/** Apply the SPEC 5.3 table to a participant's facts. */
export function deriveState(
  p: Pick<
    Participant,
    "connected" | "seat" | "readyTapped" | "schedule" | "clock"
  >,
  showRunning: boolean,
  requireClockSync: boolean,
): ParticipantState {
  if (!p.connected) return "disconnected";
  if (!p.seat) return "connected";
  if (!p.readyTapped) return "seated";
  const clockOk = p.clock.ready || !requireClockSync;
  if (!p.schedule || !clockOk) return "syncing";
  return showRunning ? "playing" : "standby";
}

/** A random join code, e.g. "K7QF2M". */
export function generateJoinCode(
  random: (max: number) => number = randomInt,
): string {
  let code = "";
  for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
    code += JOIN_CODE_ALPHABET[random(JOIN_CODE_ALPHABET.length)];
  }
  return code;
}

/** Trim and upper-case, so "k7qf2m" and "K7QF2M" find the same session. */
export function normalizeJoinCode(code: string): string {
  return code.trim().toUpperCase();
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly now: () => number;
  private readonly randomInt: (max: number) => number;
  private readonly newId: () => string;
  readonly requireClockSync: boolean;

  constructor(options: SessionStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.randomInt = options.randomInt ?? randomInt;
    this.newId = options.newId ?? randomUUID;
    this.requireClockSync = options.requireClockSync ?? false;
  }

  // -- Sessions -------------------------------------------------------------

  /** Create a session for a snapshot of `show` with a fresh join code. */
  createSession(show: Show): Session {
    let code = generateJoinCode(this.randomInt);
    while (this.sessions.has(code)) code = generateJoinCode(this.randomInt);
    const session: Session = {
      code,
      showId: show.id,
      show: structuredClone(show),
      createdAt: this.now(),
      T0: null,
      participants: new Map(),
    };
    this.sessions.set(code, session);
    return session;
  }

  /** Look up a session. Case-insensitive. */
  getSession(code: string): Session | undefined {
    return this.sessions.get(normalizeJoinCode(code));
  }

  /** Like `getSession` but throws `unknown-session`. */
  requireSession(code: string): Session {
    const session = this.getSession(code);
    if (!session) {
      throw new SessionError("unknown-session", `no session "${code}"`);
    }
    return session;
  }

  deleteSession(code: string): boolean {
    return this.sessions.delete(normalizeJoinCode(code));
  }

  listSessions(): Session[] {
    return [...this.sessions.values()];
  }

  // -- Participants ---------------------------------------------------------

  /**
   * A participant joins, or rejoins with the id from a previous `welcome`.
   * Rejoining keeps the seat, ready state and schedule. The clock must sync
   * again on the new connection. An unknown id (for example removed after
   * 60 s) gets a new participant.
   */
  join(
    session: Session,
    participantId?: string,
  ): { participant: Participant; resumed: boolean } {
    const existing = participantId
      ? session.participants.get(participantId)
      : undefined;
    if (existing) {
      existing.connected = true;
      existing.connectionToken += 1;
      existing.disconnectedAt = null;
      existing.clock = { ...INITIAL_CLOCK };
      this.refresh(session, existing);
      return { participant: existing, resumed: true };
    }

    const participant: Participant = {
      id: this.newId(),
      state: "connected",
      seat: null,
      readyTapped: false,
      schedule: null,
      scheduleVersion: 0,
      clock: { ...INITIAL_CLOCK },
      connected: true,
      connectionToken: 1,
      disconnectedAt: null,
      joinedAt: this.now(),
    };
    session.participants.set(participant.id, participant);
    this.refresh(session, participant);
    return { participant, resumed: false };
  }

  getParticipant(session: Session, id: string): Participant {
    const participant = session.participants.get(id);
    if (!participant) {
      throw new SessionError("not-joined", `no participant "${id}"`);
    }
    return participant;
  }

  /**
   * Set or move the seat. After Ready, the schedule becomes stale: it is
   * cleared and `scheduleVersion` bumped, and the caller recomputes it.
   */
  setSeat(session: Session, id: string, seat: Point): Participant {
    const p = this.getParticipant(session, id);
    p.seat = { x: seat.x, y: seat.y };
    if (p.readyTapped) this.invalidateSchedule(p);
    this.refresh(session, p);
    return p;
  }

  /**
   * Participant tapped Ready. Requires a seat. Clears any schedule and bumps
   * `scheduleVersion`; the caller computes the schedule and calls
   * `setSchedule` with that version.
   */
  markReady(session: Session, id: string): Participant {
    const p = this.getParticipant(session, id);
    if (!p.seat) {
      throw new SessionError("no-seat", "choose a seat before Ready");
    }
    p.readyTapped = true;
    this.invalidateSchedule(p);
    this.refresh(session, p);
    return p;
  }

  /**
   * Store a computed schedule. Returns false, and stores nothing, if the
   * participant is gone or `version` is stale (the seat moved meanwhile).
   */
  setSchedule(
    session: Session,
    id: string,
    schedule: TimedSchedule,
    version: number,
  ): boolean {
    const p = session.participants.get(id);
    if (!p || !p.readyTapped || p.scheduleVersion !== version) return false;
    p.schedule = schedule;
    this.refresh(session, p);
    return true;
  }

  /** Record the participant's clock status (chunk 4 sends it). */
  setClock(session: Session, id: string, clock: ClockStatus): Participant {
    const p = this.getParticipant(session, id);
    p.clock = { ...clock };
    this.refresh(session, p);
    return p;
  }

  /**
   * The socket for `token` closed. Ignored if the participant has already
   * reconnected on a newer socket. Returns true if the state changed.
   */
  disconnect(session: Session, id: string, token: number): boolean {
    const p = session.participants.get(id);
    if (!p || p.connectionToken !== token || !p.connected) return false;
    p.connected = false;
    p.disconnectedAt = this.now();
    p.clock = { ...INITIAL_CLOCK };
    this.refresh(session, p);
    return true;
  }

  /**
   * Remove participants disconnected for `DISCONNECT_REMOVAL_MS` or more.
   * Returns the sessions that lost participants, so the caller can notify
   * their hosts. Call it on an interval.
   */
  removeExpired(): Session[] {
    const cutoff = this.now() - DISCONNECT_REMOVAL_MS;
    const changed: Session[] = [];
    for (const session of this.sessions.values()) {
      let removed = false;
      for (const [id, p] of session.participants) {
        if (
          !p.connected &&
          p.disconnectedAt !== null &&
          p.disconnectedAt <= cutoff
        ) {
          session.participants.delete(id);
          removed = true;
        }
      }
      if (removed) changed.push(session);
    }
    return changed;
  }

  // -- Show -----------------------------------------------------------------

  /** Show starts at `T0` (server clock). Standby participants become playing. */
  startShow(session: Session, T0: number): void {
    session.T0 = T0;
    this.refreshAll(session);
  }

  /** Show stopped. Playing participants return to standby. */
  stopShow(session: Session): void {
    session.T0 = null;
    this.refreshAll(session);
  }

  // -- Views ----------------------------------------------------------------

  summaries(session: Session): ParticipantSummary[] {
    return [...session.participants.values()].map(toSummary);
  }

  countByState(session: Session): Record<ParticipantState, number> {
    const counts: Record<ParticipantState, number> = {
      connected: 0,
      seated: 0,
      syncing: 0,
      standby: 0,
      playing: 0,
      disconnected: 0,
    };
    for (const p of session.participants.values()) counts[p.state] += 1;
    return counts;
  }

  // -- Internals ------------------------------------------------------------

  private invalidateSchedule(p: Participant): void {
    p.schedule = null;
    p.scheduleVersion += 1;
  }

  private refresh(session: Session, p: Participant): void {
    p.state = deriveState(p, session.T0 !== null, this.requireClockSync);
  }

  private refreshAll(session: Session): void {
    for (const p of session.participants.values()) this.refresh(session, p);
  }
}

export function toSummary(p: Participant): ParticipantSummary {
  return {
    id: p.id,
    x: p.seat?.x ?? null,
    y: p.seat?.y ?? null,
    state: p.state,
    rttMs: p.clock.rttMs,
    degraded: p.clock.degraded,
  };
}

/**
 * The process-wide store. Kept on `globalThis` because Next bundles route
 * handlers apart from `server.ts`, so a module-level instance could exist
 * twice (SPEC 5.1).
 */
export function getSessionStore(): SessionStore {
  const g = globalThis as typeof globalThis & {
    __auroraSessionStore?: SessionStore;
  };
  g.__auroraSessionStore ??= new SessionStore();
  return g.__auroraSessionStore;
}
