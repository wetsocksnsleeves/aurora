import { describe, expect, it } from "vitest";
import { TEST_SHOW, testSchedule } from "@/lib/test-show";
import type { Point } from "@/lib/types";
import {
  DISCONNECT_REMOVAL_MS,
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
  SessionError,
  SessionStore,
  deriveState,
  generateJoinCode,
  type Session,
  type TimedSchedule,
} from "./sessions";

function setup(options: { requireClockSync?: boolean } = {}) {
  let now = 1_000;
  const store = new SessionStore({
    now: () => now,
    // Most tests here are about other facts; the clock gate has its own.
    requireClockSync: options.requireClockSync ?? false,
  });
  const session = store.createSession(TEST_SHOW);
  return {
    store,
    session,
    advance: (ms: number) => (now += ms),
  };
}

const SEAT: Point = { x: 0.25, y: 0.5 };

/** What a reconnecting client sends: the id and token from its welcome. */
function resumeOf(store: SessionStore, session: Session, id: string) {
  const p = store.getParticipant(session, id);
  return { participantId: p.id, resumeToken: p.resumeToken };
}

function scheduleFor(seat: Point): TimedSchedule {
  return { ...testSchedule(seat), durationMs: 20_000 };
}

/** join → seat → ready → schedule. Returns the participant id. */
function toStandby(store: SessionStore, session: Session): string {
  const { participant } = store.join(session);
  store.setSeat(session, participant.id, SEAT);
  const { scheduleVersion } = store.markReady(session, participant.id);
  store.setSchedule(
    session,
    participant.id,
    scheduleFor(SEAT),
    scheduleVersion,
  );
  return participant.id;
}

describe("join codes", () => {
  it("are 6 characters from the unambiguous alphabet", () => {
    for (let i = 0; i < 200; i++) {
      const code = generateJoinCode();
      expect(code).toHaveLength(JOIN_CODE_LENGTH);
      for (const ch of code) expect(JOIN_CODE_ALPHABET).toContain(ch);
    }
    expect(JOIN_CODE_ALPHABET).not.toMatch(/[O0I1]/);
  });

  it("are unique across sessions", () => {
    // A random source that repeats forces the collision retry.
    const values = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1];
    let i = 0;
    const store = new SessionStore({ randomInt: () => values[i++] ?? 2 });
    const a = store.createSession(TEST_SHOW);
    const b = store.createSession(TEST_SHOW);
    expect(a.code).toBe("AAAAAA");
    expect(b.code).toBe("BBBBBB");
  });

  it("look up case-insensitively", () => {
    const { store, session } = setup();
    expect(store.getSession(session.code.toLowerCase())).toBe(session);
    expect(store.getSession("ZZZZZZ")).toBeUndefined();
  });

  it("snapshot the show", () => {
    const { session } = setup();
    expect(session.show).toEqual(TEST_SHOW);
    expect(session.show).not.toBe(TEST_SHOW);
  });
});

describe("participant states (SPEC 5.3)", () => {
  it("connected → seated → syncing → standby", () => {
    const { store, session } = setup();
    const { participant: p } = store.join(session);
    expect(p.state).toBe("connected");

    store.setSeat(session, p.id, SEAT);
    expect(p.state).toBe("seated");

    store.setSeat(session, p.id, { x: 0.3, y: 0.4 });
    expect(p.state).toBe("seated");
    expect(p.seat).toEqual({ x: 0.3, y: 0.4 });

    const version = store.markReady(session, p.id).scheduleVersion;
    expect(p.state).toBe("syncing");

    expect(store.setSchedule(session, p.id, scheduleFor(SEAT), version)).toBe(
      true,
    );
    expect(p.state).toBe("standby");
  });

  it("refuses Ready without a seat", () => {
    const { store, session } = setup();
    const { participant: p } = store.join(session);
    expect(() => store.markReady(session, p.id)).toThrow(SessionError);
    try {
      store.markReady(session, p.id);
    } catch (err) {
      expect((err as SessionError).reason).toBe("no-seat");
    }
    expect(p.state).toBe("connected");
  });

  it("moving the seat after Ready goes back to syncing until the new schedule lands", () => {
    const { store, session } = setup();
    const id = toStandby(store, session);
    const p = store.getParticipant(session, id);
    const before = p.scheduleVersion;

    store.setSeat(session, id, { x: 0.9, y: 0.5 });
    expect(p.state).toBe("syncing");
    expect(p.schedule).toBeNull();
    expect(p.scheduleVersion).toBe(before + 1);

    // The schedule computed for the old seat is stale and dropped.
    expect(store.setSchedule(session, id, scheduleFor(SEAT), before)).toBe(
      false,
    );
    expect(p.state).toBe("syncing");

    const fresh = scheduleFor({ x: 0.9, y: 0.5 });
    expect(store.setSchedule(session, id, fresh, p.scheduleVersion)).toBe(true);
    expect(p.state).toBe("standby");
    expect(p.schedule).toBe(fresh);
  });

  it("standby → playing on start, → standby on stop", () => {
    const { store, session } = setup();
    const ready = toStandby(store, session);
    const { participant: waiting } = store.join(session);

    store.startShow(session, 5_000);
    expect(session.T0).toBe(5_000);
    expect(store.getParticipant(session, ready).state).toBe("playing");
    expect(waiting.state).toBe("connected");

    store.stopShow(session);
    expect(session.T0).toBeNull();
    expect(store.getParticipant(session, ready).state).toBe("standby");
  });

  it("a participant who becomes ready during a show goes straight to playing", () => {
    const { store, session } = setup();
    store.startShow(session, 5_000);
    const id = toStandby(store, session);
    expect(store.getParticipant(session, id).state).toBe("playing");
  });

  it("requires a ready clock by default", () => {
    const store = new SessionStore();
    expect(store.requireClockSync).toBe(true);
  });

  it("requires a ready clock for standby once clock sync is on (chunk 4)", () => {
    const { store, session } = setup({ requireClockSync: true });
    const id = toStandby(store, session);
    const p = store.getParticipant(session, id);
    expect(p.state).toBe("syncing");

    store.setClock(session, id, { ready: true, degraded: true, rttMs: 42 });
    expect(p.state).toBe("standby");
    expect(store.summaries(session)).toEqual([
      { id, x: SEAT.x, y: SEAT.y, state: "standby", rttMs: 42, degraded: true },
    ]);
  });

  it("any state → disconnected when the socket closes", () => {
    const { store, session } = setup();
    const id = toStandby(store, session);
    const p = store.getParticipant(session, id);
    expect(store.disconnect(session, id, p.connectionToken)).toBe(true);
    expect(p.state).toBe("disconnected");
    expect(store.disconnect(session, id, p.connectionToken)).toBe(false);
  });

  it("counts participants by state", () => {
    const { store, session } = setup();
    toStandby(store, session);
    store.join(session);
    const { participant } = store.join(session);
    store.setSeat(session, participant.id, SEAT);
    expect(store.countByState(session)).toEqual({
      connected: 1,
      seated: 1,
      syncing: 0,
      standby: 1,
      playing: 0,
      disconnected: 0,
    });
  });
});

describe("reconnect", () => {
  it("keeps the same participant, seat, ready state and schedule", () => {
    const { store, session } = setup();
    const id = toStandby(store, session);
    const p = store.getParticipant(session, id);
    const schedule = p.schedule;
    const oldToken = p.connectionToken;
    store.disconnect(session, id, oldToken);

    const { participant, resumed } = store.join(
      session,
      resumeOf(store, session, id),
    );
    expect(resumed).toBe(true);
    expect(participant).toBe(p);
    expect(participant.id).toBe(id);
    expect(participant.seat).toEqual(SEAT);
    expect(participant.schedule).toBe(schedule);
    expect(participant.state).toBe("standby");
    expect(participant.connectionToken).toBe(oldToken + 1);
    expect(session.participants.size).toBe(1);
  });

  it("resets the clock, so standby waits for a new handshake (chunk 4)", () => {
    const { store, session } = setup({ requireClockSync: true });
    const id = toStandby(store, session);
    const p = store.getParticipant(session, id);
    store.setClock(session, id, { ready: true, degraded: false, rttMs: 30 });
    expect(p.state).toBe("standby");

    store.disconnect(session, id, p.connectionToken);
    store.join(session, resumeOf(store, session, id));
    expect(p.state).toBe("syncing");
    expect(p.clock.ready).toBe(false);
  });

  it("a seated participant comes back seated", () => {
    const { store, session } = setup();
    const { participant: p } = store.join(session);
    store.setSeat(session, p.id, SEAT);
    store.disconnect(session, p.id, p.connectionToken);
    expect(
      store.join(session, resumeOf(store, session, p.id)).participant.state,
    ).toBe("seated");
  });

  it("rejoining a show in progress comes back playing", () => {
    const { store, session } = setup();
    const id = toStandby(store, session);
    store.startShow(session, 5_000);
    const p = store.getParticipant(session, id);
    store.disconnect(session, id, p.connectionToken);
    expect(p.state).toBe("disconnected");
    store.join(session, resumeOf(store, session, id));
    expect(p.state).toBe("playing");
  });

  it("ignores the close of a socket that was already replaced", () => {
    const { store, session } = setup();
    const { participant: p } = store.join(session);
    const oldToken = p.connectionToken;
    // New socket joins before the old one's close arrives.
    store.join(session, resumeOf(store, session, p.id));
    expect(store.disconnect(session, p.id, oldToken)).toBe(false);
    expect(p.state).toBe("connected");
  });

  it("a wrong or missing resume token gets a new participant and leaves the old one alone", () => {
    const { store, session } = setup();
    const id = toStandby(store, session);
    const p = store.getParticipant(session, id);
    const token = p.connectionToken;

    for (const resumeToken of [undefined, "", "wrong", p.resumeToken + "x"]) {
      const { participant, resumed } = store.join(session, {
        participantId: id,
        resumeToken,
      });
      expect(resumed).toBe(false);
      expect(participant.id).not.toBe(id);
      expect(participant.resumeToken).not.toBe(p.resumeToken);
    }
    expect(p.state).toBe("standby");
    expect(p.connectionToken).toBe(token);
    expect(session.participants.size).toBe(5);
  });

  it("ids are random UUIDs and resume tokens are 16 random bytes", () => {
    const { store, session } = setup();
    const a = store.join(session).participant;
    const b = store.join(session).participant;
    const uuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(a.id).toMatch(uuid);
    expect(b.id).toMatch(uuid);
    expect(a.id).not.toBe(b.id);
    expect(a.resumeToken).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.resumeToken).not.toBe(b.resumeToken);
    expect(store.summaries(session)[0]).not.toHaveProperty("resumeToken");
  });

  it("an unknown participant id gets a new participant", () => {
    const { store, session } = setup();
    const { participant, resumed } = store.join(session, {
      participantId: "gone",
      resumeToken: "x",
    });
    expect(resumed).toBe(false);
    expect(participant.id).not.toBe("gone");
  });
});

describe("removal after 60 s", () => {
  it("removes participants disconnected for 60 s, not before", () => {
    const { store, session, advance } = setup();
    const { participant: p } = store.join(session);
    store.disconnect(session, p.id, p.connectionToken);

    advance(DISCONNECT_REMOVAL_MS - 1);
    expect(store.removeExpired()).toEqual([]);
    expect(session.participants.has(p.id)).toBe(true);

    advance(1);
    expect(store.removeExpired()).toEqual([session]);
    expect(session.participants.has(p.id)).toBe(false);
  });

  it("does not remove a participant who reconnected in time", () => {
    const { store, session, advance } = setup();
    const { participant: p } = store.join(session);
    store.disconnect(session, p.id, p.connectionToken);
    advance(30_000);
    store.join(session, resumeOf(store, session, p.id));
    advance(DISCONNECT_REMOVAL_MS);
    expect(store.removeExpired()).toEqual([]);
    expect(p.state).toBe("connected");
  });

  it("a rejoin after removal gets a new participant", () => {
    const { store, session, advance } = setup();
    const { participant: p } = store.join(session);
    const resume = resumeOf(store, session, p.id);
    store.disconnect(session, p.id, p.connectionToken);
    advance(DISCONNECT_REMOVAL_MS);
    store.removeExpired();
    expect(store.join(session, resume).resumed).toBe(false);
  });
});

describe("deriveState", () => {
  const base = {
    connected: true,
    seat: SEAT,
    readyTapped: true,
    schedule: scheduleFor(SEAT),
    clock: { ready: false, degraded: false, rttMs: null },
  };

  it("disconnected wins over everything", () => {
    expect(deriveState({ ...base, connected: false }, true, false)).toBe(
      "disconnected",
    );
  });

  it("needs the clock only when clock sync is required", () => {
    expect(deriveState(base, false, false)).toBe("standby");
    expect(deriveState(base, false, true)).toBe("syncing");
  });
});
