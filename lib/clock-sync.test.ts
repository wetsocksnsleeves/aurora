import { describe, expect, it } from "vitest";
import { CLOCK_SYNC, ClockSync, type ClockSyncState } from "./clock-sync";
import { FakeTime } from "./fake-time";

/** Seeded PRNG (mulberry32), so the latency tests are repeatable. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Setup {
  time: FakeTime;
  clock: ClockSync;
  sent: number[];
  changes: ClockSyncState[];
  /** Feeds a reply with the given RTT and offset, arriving now. */
  reply(rtt: number, offset: number): void;
}

function setup(): Setup {
  const time = new FakeTime();
  const sent: number[] = [];
  const changes: ClockSyncState[] = [];
  const clock = new ClockSync({
    now: time.now,
    send: (c0) => sent.push(c0),
    setTimeout: time.setTimeout,
    clearTimeout: time.clear,
    setInterval: time.setInterval,
    clearInterval: time.clear,
    onChange: (s) => changes.push(s),
  });
  const reply = (rtt: number, offset: number) => {
    const c1 = time.now();
    const c0 = c1 - rtt;
    clock.onReply(c0, offset + (c0 + c1) / 2);
  };
  return { time, clock, sent, changes, reply };
}

/**
 * Connects a ClockSync to a simulated server whose clock reads
 * `local + trueOffset`, with per-message one-way delays from `up` and `down`.
 */
function network(
  trueOffset: number,
  up: () => number,
  down: () => number,
): { time: FakeTime; clock: ClockSync } {
  const time = new FakeTime();
  const clock: ClockSync = new ClockSync({
    now: time.now,
    send: (c0) => {
      time.setTimeout(() => {
        const s1 = time.now() + trueOffset;
        time.setTimeout(() => clock.onReply(c0, s1), down());
      }, up());
    },
    setTimeout: time.setTimeout,
    clearTimeout: time.clear,
    setInterval: time.setInterval,
    clearInterval: time.clear,
  });
  return { time, clock };
}

describe("ClockSync samples (4.2)", () => {
  it("computes rtt and offset from c0, s1 and the receive time", () => {
    const { time, clock } = setup();
    time.advance(1000);
    clock.onReply(900, 5000);
    expect(clock.bestRtt).toBe(100);
    expect(clock.estimatedOffset).toBe(5000 - (900 + 1000) / 2);
    expect(clock.sampleCount).toBe(1);
  });

  it("has no estimate before the first sample", () => {
    const { clock } = setup();
    expect(clock.bestRtt).toBeNull();
    expect(clock.estimatedOffset).toBeNull();
    expect(clock.offset).toBe(0);
    expect(clock.ready).toBe(false);
  });

  it("discards samples with negative rtt or rtt over 4000 ms", () => {
    const { time, clock, reply } = setup();
    time.advance(10_000);
    reply(-1, 0);
    reply(4001, 0);
    expect(clock.sampleCount).toBe(0);
    reply(4000, 0);
    expect(clock.sampleCount).toBe(1);
  });

  it("keeps a window of 40 and takes the offset of the lowest-rtt sample", () => {
    const { time, clock, reply } = setup();
    time.advance(10_000);
    reply(10, 111); // best, but drops out once 40 more arrive
    for (let i = 0; i < 39; i++) reply(50 + i, 200 + i);
    expect(clock.sampleCount).toBe(40);
    expect(clock.bestRtt).toBe(10);
    expect(clock.estimatedOffset).toBe(111);

    reply(60, 999);
    expect(clock.sampleCount).toBe(CLOCK_SYNC.windowSize);
    expect(clock.bestRtt).toBe(50);
    expect(clock.estimatedOffset).toBe(200);
  });
});

describe("ClockSync offset estimator with asymmetric latency", () => {
  it("is off by exactly (up - down) / 2 when the legs are fixed", () => {
    const trueOffset = 7_654.25;
    const { time, clock } = network(
      trueOffset,
      () => 20,
      () => 120,
    );
    clock.start();
    time.advance(3000);
    expect(clock.bestRtt).toBe(140);
    expect(clock.estimatedOffset).toBeCloseTo(trueOffset + (20 - 120) / 2, 9);
  });

  it("recovers a known offset when queueing delay is random and asymmetric", () => {
    const errors: number[] = [];
    for (let seed = 1; seed <= 50; seed++) {
      const r = rng(seed);
      const trueOffset = (r() - 0.5) * 20_000; // within +-10 s, as in 6.1
      // A fixed 25 ms each way, plus random queueing that differs per leg
      // and per message: up to 180 ms up and 60 ms down.
      const { time, clock } = network(
        trueOffset,
        () => 25 + 180 * r() ** 3,
        () => 25 + 60 * r() ** 3,
      );
      clock.start();
      time.advance(30_000);

      expect(clock.ready).toBe(true);
      expect(clock.degraded).toBe(false);
      errors.push(Math.abs((clock.estimatedOffset ?? NaN) - trueOffset));
      // serverNow() tracks the simulated server clock just as closely.
      expect(
        Math.abs(clock.serverNow() - (time.now() + trueOffset)),
      ).toBeCloseTo(errors.at(-1) ?? NaN, 6);
    }
    errors.sort((a, b) => a - b);
    expect(errors[errors.length >> 1]).toBeLessThan(2);
    expect(errors.at(-1)).toBeLessThan(10);
  });

  it("beats the mean of all samples under one-sided spikes", () => {
    const r = rng(42);
    const trueOffset = 3000;
    const offsets: number[] = [];
    const time = new FakeTime();
    const clock: ClockSync = new ClockSync({
      now: time.now,
      send: (c0) => {
        // 1 in 4 uplink messages hits a 300 ms spike.
        const up = 30 + (r() < 0.25 ? 300 : 10 * r());
        const down = 30 + 10 * r();
        time.setTimeout(() => {
          const s1 = time.now() + trueOffset;
          time.setTimeout(() => {
            const c1 = time.now();
            offsets.push(s1 - (c0 + c1) / 2);
            clock.onReply(c0, s1);
          }, down);
        }, up);
      },
      setTimeout: time.setTimeout,
      clearTimeout: time.clear,
      setInterval: time.setInterval,
      clearInterval: time.clear,
    });
    clock.start();
    time.advance(2000);

    const mean = offsets.reduce((a, b) => a + b, 0) / offsets.length;
    const bestErr = Math.abs((clock.estimatedOffset ?? NaN) - trueOffset);
    expect(bestErr).toBeLessThan(10);
    expect(bestErr).toBeLessThan(Math.abs(mean - trueOffset));
  });
});

describe("ClockSync ready gate (4.4)", () => {
  it("becomes ready at the 8th stable sample with a low rtt", () => {
    const { time, clock, changes, reply } = setup();
    time.advance(1000);
    for (let i = 0; i < 7; i++) {
      reply(50, 500);
      time.advance(80);
    }
    expect(clock.ready).toBe(false);
    reply(50, 500);
    expect(clock.ready).toBe(true);
    expect(clock.degraded).toBe(false);
    expect(changes).toEqual([{ ready: true, degraded: false, bestRtt: 50 }]);
  });

  it("is not ready while the best rtt is over 400 ms", () => {
    const { time, clock, reply } = setup();
    time.advance(1000);
    for (let i = 0; i < 20; i++) {
      reply(401, 500);
      time.advance(100);
    }
    expect(clock.ready).toBe(false);
    reply(400, 500);
    expect(clock.ready).toBe(true);
  });

  it("is not ready while the best offset over the last 3 replies varies by more than 30 ms", () => {
    const { time, clock, reply } = setup();
    time.advance(1000);
    // Each reply is a new best whose offset jumps by 40 ms.
    for (let i = 0; i < 10; i++) {
      reply(200 - i * 10, i * 40);
      time.advance(80);
    }
    expect(clock.sampleCount).toBe(10);
    expect(clock.ready).toBe(false);

    // Two worse replies leave the best at offset 360, but the window of 3
    // still includes the jump from 320.
    reply(300, 0);
    expect(clock.ready).toBe(false);
    reply(300, 0);
    expect(clock.ready).toBe(true);
    expect(clock.estimatedOffset).toBe(360);
  });

  it("allows a spread of exactly 30 ms", () => {
    const { time, clock, reply } = setup();
    time.advance(1000);
    for (let i = 0; i < 6; i++) reply(100, 0);
    reply(90, 15);
    expect(clock.ready).toBe(false); // 7 samples
    reply(80, 30);
    expect(clock.ready).toBe(true); // last 3 best offsets: 0, 15, 30
  });

  it("stays ready when later replies would fail the gate", () => {
    const { time, clock, reply } = setup();
    time.advance(1000);
    for (let i = 0; i < 8; i++) reply(50, 0);
    expect(clock.ready).toBe(true);
    reply(10, 100);
    reply(5, 200);
    expect(clock.ready).toBe(true);
  });
});

describe("ClockSync degraded fallback (4.4)", () => {
  it("marks the clock ready and degraded 6 s after the first reply", () => {
    const { time, clock, changes, reply } = setup();
    time.advance(500);
    for (let i = 0; i < 6; i++) {
      reply(450, 0);
      time.advance(100);
    }
    time.advance(CLOCK_SYNC.degradedAfterMs - 600 - 1);
    expect(clock.ready).toBe(false);
    time.advance(1);
    expect(clock.ready).toBe(true);
    expect(clock.degraded).toBe(true);
    expect(changes).toEqual([{ ready: true, degraded: true, bestRtt: 450 }]);
  });

  it("waits for the 6th sample if fewer than 6 have arrived by then", () => {
    const { time, clock, reply } = setup();
    for (let i = 0; i < 5; i++) {
      reply(450, 0);
      time.advance(100);
    }
    time.advance(10_000);
    expect(clock.ready).toBe(false);
    reply(450, 0);
    expect(clock.ready).toBe(true);
    expect(clock.degraded).toBe(true);
  });

  it("clears degraded once the strict gate passes", () => {
    const { time, clock, changes, reply } = setup();
    for (let i = 0; i < 6; i++) reply(450, 0);
    time.advance(CLOCK_SYNC.degradedAfterMs);
    expect(clock.degraded).toBe(true);
    for (let i = 0; i < 3; i++) reply(100, 0);
    expect(clock.ready).toBe(true);
    expect(clock.degraded).toBe(false);
    expect(changes.map((c) => [c.ready, c.degraded])).toEqual([
      [true, true],
      [true, false],
    ]);
  });

  it("still fires after a stop and restart", () => {
    const { time, clock, reply } = setup();
    for (let i = 0; i < 6; i++) reply(450, 0);
    time.advance(1000);
    clock.stop();
    time.advance(1000);
    clock.start();
    time.advance(CLOCK_SYNC.degradedAfterMs - 2000);
    expect(clock.ready).toBe(true);
    expect(clock.degraded).toBe(true);
  });
});

describe("ClockSync slew (4.5)", () => {
  it("applies the first estimate at once", () => {
    const { time, clock, reply } = setup();
    time.advance(1000);
    reply(50, 5000);
    expect(clock.offset).toBe(5000);
    expect(clock.serverNow()).toBe(6000);
  });

  it("applies a correction of 8 ms or less at once", () => {
    const { time, clock, reply } = setup();
    time.advance(1000);
    reply(50, 5000);
    reply(40, 5008);
    expect(clock.offset).toBe(5008);
    reply(30, 5000);
    expect(clock.offset).toBe(5000);
  });

  it("moves a larger correction at 0.15 ms per ms", () => {
    const { time, clock, reply } = setup();
    time.advance(1000);
    reply(50, 5000);
    reply(40, 5100);
    expect(clock.estimatedOffset).toBe(5100);
    expect(clock.offset).toBe(5000);
    time.advance(100);
    expect(clock.offset).toBeCloseTo(5015, 9);
    time.advance(400);
    expect(clock.offset).toBeCloseTo(5075, 9);
    time.advance(1000);
    expect(clock.offset).toBe(5100);

    // And downwards.
    reply(30, 4900);
    time.advance(1000);
    expect(clock.offset).toBeCloseTo(4950, 9);
    time.advance(1000);
    expect(clock.offset).toBe(4900);
  });

  it("keeps serverNow() monotonic while slewing backwards", () => {
    const { time, clock, reply } = setup();
    time.advance(1000);
    reply(50, 5000);
    reply(40, 4000);
    let last = clock.serverNow();
    for (let i = 0; i < 100; i++) {
      time.advance(16);
      const t = clock.serverNow();
      expect(t).toBeGreaterThan(last);
      last = t;
    }
  });

  it("snaps when a new estimate lands within 8 ms of the slewing offset", () => {
    const { time, clock, reply } = setup();
    time.advance(1000);
    reply(50, 0);
    reply(40, 100);
    time.advance(200); // applied is now 30
    expect(clock.offset).toBeCloseTo(30, 9);
    reply(30, 35);
    expect(clock.offset).toBe(35);
  });

  it("retargets from the current applied offset", () => {
    const { time, clock, reply } = setup();
    time.advance(1000);
    reply(50, 0);
    reply(40, 100);
    time.advance(200); // applied is 30
    reply(30, -100);
    expect(clock.offset).toBeCloseTo(30, 9);
    time.advance(100);
    expect(clock.offset).toBeCloseTo(15, 9);
  });
});

describe("ClockSync ping schedule (4.3)", () => {
  it("sends a burst of 14 pings 80 ms apart, then one every 20 s", () => {
    const { time, clock, sent } = setup();
    time.advance(1000);
    clock.start();
    time.advance(13 * 80);
    expect(sent).toEqual(
      Array.from(
        { length: 14 },
        (_, i) => 1000 + i * CLOCK_SYNC.burstIntervalMs,
      ),
    );
    time.advance(CLOCK_SYNC.steadyIntervalMs * 3);
    expect(sent.length).toBe(17);
    expect(sent.slice(14)).toEqual([1, 2, 3].map((k) => 2040 + k * 20_000));
  });

  it("never stacks intervals after repeated onOpen", () => {
    const { time, clock, sent } = setup();
    for (let i = 0; i < 5; i++) {
      clock.onOpen();
      expect(time.intervalCount).toBe(1);
      time.advance(40);
    }
    // The last burst runs to the end; earlier ones were cancelled.
    time.advance(13 * 80);
    expect(time.intervalCount).toBe(1); // the steady interval
    const afterBurst = sent.length;
    expect(afterBurst).toBe(4 + 14);

    time.advance(60_000);
    expect(sent.length).toBe(afterBurst + 3);

    // A reconnect during steady state replaces the steady interval.
    clock.onOpen();
    expect(time.intervalCount).toBe(1);
    time.advance(13 * 80 + 50_000);
    expect(time.intervalCount).toBe(1);
    expect(sent.length).toBe(afterBurst + 3 + 14 + 2);
  });

  it("stop() cancels every timer", () => {
    const { time, clock, sent, reply } = setup();
    clock.start();
    reply(450, 0); // arms the 6 s fallback timer
    expect(time.timeoutCount).toBe(1);
    clock.stop();
    expect(time.intervalCount).toBe(0);
    expect(time.timeoutCount).toBe(0);
    const n = sent.length;
    time.advance(100_000);
    expect(sent.length).toBe(n);
  });
});

describe("ClockSync resync on visibility (4.3, 4.9)", () => {
  it("clears samples, goes not ready, bursts, and applies the next estimate at once", () => {
    const { time, clock, sent, changes, reply } = setup();
    clock.start();
    for (let i = 0; i < 8; i++) reply(50, 1000);
    expect(clock.ready).toBe(true);
    time.advance(30_000);
    const n = sent.length;

    clock.onVisible();
    expect(clock.ready).toBe(false);
    expect(clock.degraded).toBe(false);
    expect(clock.sampleCount).toBe(0);
    expect(clock.bestRtt).toBeNull();
    expect(changes.at(-1)).toEqual({
      ready: false,
      degraded: false,
      bestRtt: null,
    });
    // The old offset stays in use until a new estimate arrives.
    expect(clock.offset).toBe(1000);

    time.advance(13 * 80);
    expect(sent.length).toBe(n + 14);
    expect(time.intervalCount).toBe(1);

    // A far-off first estimate after the reset is not slewed.
    reply(50, 1500);
    expect(clock.offset).toBe(1500);

    // The ready gate starts over: 8 fresh samples are needed.
    for (let i = 0; i < 6; i++) reply(50, 1500);
    expect(clock.ready).toBe(false);
    reply(50, 1500);
    expect(clock.ready).toBe(true);
  });

  it("restarts the 6 s fallback from the first reply after the reset", () => {
    const { time, clock, reply } = setup();
    for (let i = 0; i < 6; i++) reply(450, 0);
    time.advance(5000);
    clock.onVisible();
    time.advance(2000); // the old deadline has passed
    expect(clock.ready).toBe(false);
    for (let i = 0; i < 6; i++) reply(450, 0);
    time.advance(CLOCK_SYNC.degradedAfterMs - 1);
    expect(clock.ready).toBe(false);
    time.advance(1);
    expect(clock.degraded).toBe(true);
  });
});
