import { describe, expect, it } from "vitest";
import { countByState, participantDots, STATE_COLORS } from "./host-map";
import type { ParticipantSummary } from "./protocol";

const p = (
  id: string,
  overrides: Partial<ParticipantSummary> = {},
): ParticipantSummary => ({
  id,
  x: 0.5,
  y: 0.5,
  state: "seated",
  rttMs: null,
  degraded: false,
  ...overrides,
});

describe("STATE_COLORS", () => {
  it("follows SPEC 5.3", () => {
    expect(STATE_COLORS.connected).toBe("#9ca3af");
    expect(STATE_COLORS.seated).toBe("#facc15");
    expect(STATE_COLORS.syncing).toBe("#3b82f6");
    expect(STATE_COLORS.standby).toBe("#22c55e");
    expect(STATE_COLORS.playing).toBe(STATE_COLORS.standby);
    expect(STATE_COLORS.disconnected).toBe("#ef4444");
  });
});

describe("countByState", () => {
  it("counts every state, including zeros", () => {
    const counts = countByState([
      p("a", { state: "connected", x: null, y: null }),
      p("b", { state: "standby" }),
      p("c", { state: "standby" }),
      p("d", { state: "disconnected" }),
    ]);
    expect(counts).toEqual({
      total: 4,
      connected: 1,
      seated: 0,
      syncing: 0,
      standby: 2,
      playing: 0,
      disconnected: 1,
    });
  });
});

describe("participantDots", () => {
  it("colours seated participants by state and skips unseated ones", () => {
    const dots = participantDots([
      p("a", { state: "connected", x: null, y: null }),
      p("b", { state: "seated", x: 0.1, y: 0.2 }),
      p("c", { state: "standby", degraded: true, rttMs: 41.6 }),
      p("d", { state: "disconnected" }),
    ]);
    expect(dots.map((d) => [d.id, d.color, d.warning])).toEqual([
      ["b", STATE_COLORS.seated, false],
      ["c", STATE_COLORS.standby, true],
      ["d", STATE_COLORS.disconnected, false],
    ]);
    expect(dots[0]).toMatchObject({ x: 0.1, y: 0.2 });
    expect(dots[1]!.title).toBe("Ready (degraded clock), 42 ms RTT");
  });

  it("accepts a colour override", () => {
    const dots = participantDots([p("a", { state: "playing" })], () => "#f0f");
    expect(dots[0]!.color).toBe("#f0f");
  });
});
