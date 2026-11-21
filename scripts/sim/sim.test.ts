import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ClockSync } from "@/lib/clock-sync";
import { decodeFrame, parseSeats } from "@/lib/crowd-stream";
import type { Point } from "@/lib/types";
import { injectBug } from "./bugs";
import {
  DEFAULT_FAULTS,
  NO_FAULTS,
  drawClientFaults,
  parseRange,
  seededRandom,
} from "./faults";
import { DelayQueue } from "./faulty-socket";
import { DEFAULT_SIM_OPTIONS, runSim, toWsUrl, type SimOptions } from "./run";
import { percentile } from "./stats";

describe("DelayQueue", () => {
  afterEach(() => vi.useRealTimers());

  it("never reorders: a short delay waits behind a long one", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const q = new DelayQueue<string>(
      (s) => out.push(s),
      () => Date.now(),
    );
    q.push("slow", 500);
    q.push("fast", 10);
    vi.advanceTimersByTime(100);
    expect(out).toEqual([]);
    vi.advanceTimersByTime(400);
    expect(out).toEqual(["slow", "fast"]);
  });

  it("delivers each item after its own delay when in order", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const q = new DelayQueue<string>(
      (s) => out.push(s),
      () => Date.now(),
    );
    q.push("a", 20);
    q.push("b", 100);
    vi.advanceTimersByTime(20);
    expect(out).toEqual(["a"]);
    vi.advanceTimersByTime(80);
    expect(out).toEqual(["a", "b"]);
  });

  it("drops everything on clear", () => {
    vi.useFakeTimers();
    const out: string[] = [];
    const q = new DelayQueue<string>(
      (s) => out.push(s),
      () => Date.now(),
    );
    q.push("a", 20);
    q.clear();
    vi.advanceTimersByTime(100);
    expect(out).toEqual([]);
    expect(q.size).toBe(0);
  });
});

describe("fault model", () => {
  it("draws client faults within the configured ranges", () => {
    const random = seededRandom(7);
    for (let i = 0; i < 200; i++) {
      const f = drawClientFaults({ ...DEFAULT_FAULTS, spikeRate: 0 }, random);
      expect(Math.abs(f.offsetMs)).toBeLessThanOrEqual(10_000);
      expect(Math.abs(f.driftPpm)).toBeLessThanOrEqual(50);
      const d = f.delay("up");
      // 20..200 path, ±10 asymmetry half, ±30 jitter.
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(240);
    }
  });

  it("adds spikes to about spikeRate of messages", () => {
    const f = drawClientFaults(
      { ...DEFAULT_FAULTS, spikeRate: 0.1 },
      seededRandom(3),
    );
    let spikes = 0;
    for (let i = 0; i < 5000; i++) if (f.delay("down") > 400) spikes++;
    expect(spikes / 5000).toBeGreaterThan(0.08);
    expect(spikes / 5000).toBeLessThan(0.12);
  });

  it("parses ranges", () => {
    expect(parseRange("20-200")).toEqual({ min: 20, max: 200 });
    expect(parseRange("50")).toEqual({ min: 50, max: 50 });
    expect(() => parseRange("200-20")).toThrow();
    expect(() => parseRange("fast")).toThrow();
  });
});

describe("helpers", () => {
  it("takes nearest-rank percentiles", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 100)).toBe(100);
    expect(percentile([], 50)).toBeNaN();
  });

  it("turns a server URL into its WebSocket URL", () => {
    expect(toWsUrl("http://localhost:3000")).toBe("ws://localhost:3000/ws");
    expect(toWsUrl("https://x.example")).toBe("wss://x.example/ws");
    expect(toWsUrl("ws://127.0.0.1:4000/ws")).toBe("ws://127.0.0.1:4000/ws");
  });

  it("injected bugs are removed again", () => {
    const proto = ClockSync.prototype as unknown as Record<string, unknown>;
    const before = proto.appliedAt;
    const restore = injectBug("no-slew");
    expect(proto.appliedAt).not.toBe(before);
    restore();
    expect(proto.appliedAt).toBe(before);
  });
});

/**
 * The fast CI variant of `scripts/sim.ts`: 50 clients with the SPEC 6.1
 * faults play a 6 s show against an in-process server. The full run
 * (500 clients, 20 s show) is `npx tsx scripts/sim.ts`.
 */
describe("simulated clients", () => {
  const base = (patch: Partial<SimOptions> = {}): SimOptions => ({
    ...DEFAULT_SIM_OPTIONS,
    clients: 50,
    seed: 1,
    // Two drops instead of the default one-in-a-hundred, so a 50-client run
    // still exercises reconnect and resume.
    faults: { ...DEFAULT_FAULTS, disconnectRate: 0.04 },
    target: { kind: "local", waves: 3, compile: true, startLeadMs: 900 },
    log: () => {},
    ...patch,
  });

  it("keeps p95 sync error under 50 ms with faults", async () => {
    const report = await runSim(base());
    expect(report.failures).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.standbyAtStart).toBe(50);
    expect(report.syncError.p95).toBeLessThan(50);
    // Every client recorded every event of its 3-wave schedule.
    expect(report.syncError.count).toBe(50 * 7);
    expect(report.reconnects).toEqual({
      planned: 2,
      reconnected: 2,
      resumed: 2,
    });
  }, 60_000);

  it.each(["no-slew", "offset-formula"] as const)(
    "fails with the %s bug injected",
    async (bug) => {
      const report = await runSim(
        base({
          bug,
          target: { kind: "local", waves: 2, compile: false, startLeadMs: 900 },
          faults: { ...DEFAULT_FAULTS, disconnectRate: 0 },
        }),
      );
      expect(report.passed).toBe(false);
      expect(report.syncError.p95).toBeGreaterThan(50);
    },
    60_000,
  );
});

describe("crowd stream", () => {
  it("serves seats and colour frames while a show runs", async () => {
    const frames: Uint8Array[] = [];
    let seats: (Point | null)[] = [];
    let venueShapes = 0;
    let ws: WebSocket | null = null;
    const log = (line: string) => {
      const port = /^stream: ws:\/\/localhost:(\d+)$/.exec(line)?.[1];
      if (!port) return;
      ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.on("message", (data, isBinary) => {
        if (!isBinary) {
          const r = parseSeats(String(data));
          if (r.ok) {
            seats = r.value.seats;
            venueShapes = r.value.venue?.shapes.length ?? venueShapes;
          }
          return;
        }
        const r = decodeFrame(new Uint8Array(data as Buffer), 4);
        if (r.ok) frames.push(r.value.rgb.slice());
      });
    };
    const report = await runSim({
      ...DEFAULT_SIM_OPTIONS,
      clients: 4,
      faults: NO_FAULTS,
      target: { kind: "local", waves: 1, compile: true, startLeadMs: 900 },
      stream: { port: 0 },
      log,
    });
    (ws as WebSocket | null)?.terminate();
    expect(report.passed).toBe(true);
    expect(seats).toHaveLength(4);
    expect(venueShapes).toBeGreaterThan(0);
    expect(seats.every((s) => s !== null)).toBe(true);
    expect(frames.length).toBeGreaterThan(5);
    // Some frame shows the test wave's white flash, which no state colour is.
    const white = (f: Uint8Array, i: number) =>
      f[3 * i] === 255 && f[3 * i + 1] === 255 && f[3 * i + 2] === 255;
    expect(frames.some((f) => [0, 1, 2, 3].some((i) => white(f, i)))).toBe(
      true,
    );
    expect(frames.at(-1)!.length).toBe(12);
  }, 60_000);
});
