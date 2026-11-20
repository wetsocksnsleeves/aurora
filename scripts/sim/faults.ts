/**
 * Fault model for the simulated-client harness (SPEC 6.1) and the seeded
 * random numbers that drive it.
 */

export type Range = { min: number; max: number };

/**
 * How one-way latency is drawn:
 *
 * - `path` (default): each client draws one base latency from `latencyMs`
 *   for its network path. Every message then adds its own jitter and maybe
 *   a spike, drawn independently per direction, so the up and down legs of
 *   a round differ. On top, `asymmetryMs` gives each client a fixed
 *   difference between its up and down paths.
 * - `message`: every message draws its own latency from `latencyMs`,
 *   independently per direction (then jitter, spikes and the fixed
 *   asymmetry as above). A stress model: a 180 ms spread per message is far
 *   more variable than the ±30 ms jitter SPEC 6.1 lists separately.
 *
 * A fixed up/down difference cannot be seen from round trips by any two-way
 * clock sync (NTP has the same limit): half of it ends up in the offset.
 * `asymmetryMs` is that part, kept small by default; raise it to see how
 * fast it eats the 50 ms budget.
 */
export type LatencyModel = "path" | "message";

export type FaultConfig = {
  /** Each client's local clock is offset by a value in ±this (ms). */
  offsetMs: number;
  /** Each client's local clock runs fast or slow by a value in ±this (ppm). */
  driftPpm: number;
  /** One-way latency (ms): per client, or per message (`latencyModel`). */
  latencyMs: Range;
  latencyModel: LatencyModel;
  /** Each client's up path is slower than its down path by a value in
   * ±this (ms), fixed for the run. */
  asymmetryMs: number;
  /** Each message gets an extra uniform delay in ±this (ms). */
  jitterMs: number;
  /** Fraction of messages that get an extra `spikeMs`. */
  spikeRate: number;
  spikeMs: number;
  /** Fraction of clients that drop their socket mid-show and reconnect. */
  disconnectRate: number;
};

/** SPEC 6.1 defaults. */
export const DEFAULT_FAULTS: FaultConfig = {
  offsetMs: 10_000,
  driftPpm: 50,
  latencyMs: { min: 20, max: 200 },
  latencyModel: "path",
  asymmetryMs: 20,
  jitterMs: 30,
  spikeRate: 0.02,
  spikeMs: 500,
  disconnectRate: 0.01,
};

/** No faults at all: loopback latency, a perfect clock, no drops. */
export const NO_FAULTS: FaultConfig = {
  offsetMs: 0,
  driftPpm: 0,
  latencyMs: { min: 0, max: 0 },
  latencyModel: "path",
  asymmetryMs: 0,
  jitterMs: 0,
  spikeRate: 0,
  spikeMs: 0,
  disconnectRate: 0,
};

/** mulberry32: small, fast, seedable. Returns a 0..1 generator. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function uniform(random: () => number, min: number, max: number) {
  return min + (max - min) * random();
}

export type Direction = "up" | "down";

/** One client's fixed faults, drawn once at the start of a run. */
export type ClientFaults = {
  /** Local clock = true clock * (1 + driftPpm / 1e6) + offsetMs. */
  offsetMs: number;
  driftPpm: number;
  /** Up minus down path latency, fixed for the client. */
  asymmetryMs: number;
  /** Base one-way latency in the `path` model, else null. */
  pathMs: number | null;
  /** Draws the one-way delay for the next message in `direction`. */
  delay(direction: Direction): number;
};

export function drawClientFaults(
  config: FaultConfig,
  random: () => number,
): ClientFaults {
  const { latencyMs: lat } = config;
  const offsetMs = uniform(random, -config.offsetMs, config.offsetMs);
  const driftPpm = uniform(random, -config.driftPpm, config.driftPpm);
  const pathMs = uniform(random, lat.min, lat.max);
  const asymmetryMs = uniform(random, -config.asymmetryMs, config.asymmetryMs);
  return {
    offsetMs,
    driftPpm,
    asymmetryMs,
    pathMs: config.latencyModel === "path" ? pathMs : null,
    delay(direction) {
      const base =
        config.latencyModel === "path"
          ? pathMs
          : uniform(random, lat.min, lat.max);
      const skew = (direction === "up" ? 1 : -1) * (asymmetryMs / 2);
      const jitter = uniform(random, -config.jitterMs, config.jitterMs);
      const spike = random() < config.spikeRate ? config.spikeMs : 0;
      return Math.max(0, base + skew + jitter + spike);
    },
  };
}

/** Parses `20-200` or `150` (a fixed value) into a range. */
export function parseRange(text: string): Range {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?\s*$/.exec(text);
  if (!match) throw new Error(`expected a range like 20-200, got "${text}"`);
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : Number(match[2]);
  if (max < min) throw new Error(`range "${text}" has max below min`);
  return { min, max };
}
