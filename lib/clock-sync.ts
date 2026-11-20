/**
 * Client-side estimate of the server clock (SPEC 4.2 to 4.5).
 *
 * No browser or Node globals: the local clock, the send function and the
 * timer functions are passed in, so the browser, the host page and the
 * simulated-client harness all run this same code over their own clocks.
 */

/** Tuning constants from SPEC section 4. The sim harness reads these. */
export const CLOCK_SYNC = {
  /** Replies with an RTT above this came from a suspended tab (4.2). */
  maxRttMs: 4000,
  /** Rolling window of samples (4.2). */
  windowSize: 40,
  /** Pings per burst on open and on return to visible (4.3). */
  burstCount: 14,
  burstIntervalMs: 80,
  /** Steady-state ping period after a burst (4.3). */
  steadyIntervalMs: 20_000,
  /** Ready gate (4.4). */
  readyMinSamples: 8,
  readyMaxRttMs: 400,
  readyStabilityReplies: 3,
  readyMaxSpreadMs: 30,
  /** Degraded fallback (4.4). */
  degradedAfterMs: 6000,
  degradedMinSamples: 6,
  /** Slew of the applied offset (4.5). */
  slewSnapMs: 8,
  slewRateMsPerMs: 0.15,
} as const;

/** Opaque timer handle. Node returns an object, browsers a number. */
export type TimerHandle = unknown;

export interface ClockSyncState {
  ready: boolean;
  degraded: boolean;
  bestRtt: number | null;
}

export interface ClockSyncDeps {
  /** Local monotonic clock in ms, `performance.now()` in the browser. */
  now(): number;
  /** Sends `sync { c0 }` to the server. */
  send(c0: number): void;
  // Timer functions. They are called without a receiver (a browser throws
  // "Illegal invocation" if `setTimeout` is called on another object), so
  // passing the browser's own `setTimeout` etc. directly is fine. Method
  // syntax keeps the parameter types bivariant, so Node's and the DOM's
  // signatures both fit.
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
  /** Called when `ready` or `degraded` changes. */
  onChange?: (state: ClockSyncState) => void;
}

export interface ClockSample {
  rtt: number;
  offset: number;
}

export class ClockSync {
  /** Called when `ready` or `degraded` changes. Can be replaced at any time. */
  onChange: ((state: ClockSyncState) => void) | null;

  private readonly deps: ClockSyncDeps;

  private samples: ClockSample[] = [];
  /** Best-offset estimate after each of the most recent accepted replies. */
  private recentBest: number[] = [];
  /** Local time of the first accepted reply since the last reset. */
  private firstReplyAt: number | null = null;

  private _ready = false;
  private _degraded = false;

  // Slew state (4.5). The applied offset is computed lazily from these, so
  // no timer is needed: it moves from `slewFrom` at `slewStartAt` towards
  // `target` at `slewRateMsPerMs`.
  private target: number | null = null;
  private slewFrom = 0;
  private slewStartAt = 0;
  /** True until the first estimate after a reset has been applied. */
  private snapNext = true;

  private burstTimer: TimerHandle | null = null;
  private steadyTimer: TimerHandle | null = null;
  private degradedTimer: TimerHandle | null = null;

  constructor(deps: ClockSyncDeps) {
    this.deps = deps;
    this.onChange = deps.onChange ?? null;
  }

  // --- State -------------------------------------------------------------

  /** True once the ready gate (4.4) passes, or the degraded fallback fires. */
  get ready(): boolean {
    return this._ready;
  }

  /** True when ready only through the 6 s fallback (4.4). */
  get degraded(): boolean {
    return this._degraded;
  }

  /** Lowest RTT in the window, or null with no samples. */
  get bestRtt(): number | null {
    const best = this.best();
    return best ? best.rtt : null;
  }

  /** Offset of the lowest-RTT sample in the window, or null with no samples. */
  get estimatedOffset(): number | null {
    const best = this.best();
    return best ? best.offset : null;
  }

  /** The applied offset that `serverNow()` uses, after slewing (4.5). */
  get offset(): number {
    return this.appliedAt(this.deps.now());
  }

  /** Number of samples in the window. */
  get sampleCount(): number {
    return this.samples.length;
  }

  /** Estimated server clock: local clock plus the applied offset (4.1). */
  serverNow(): number {
    const t = this.deps.now();
    return t + this.appliedAt(t);
  }

  // --- Lifecycle -----------------------------------------------------------

  /** Socket opened (join or reconnect): burst of pings, then steady pings. */
  start(): void {
    this.burst();
    // A stop() may have cancelled the degraded fallback timer; re-arm it for
    // whatever time is left.
    if (this.firstReplyAt !== null && !this._ready) this.armDegradedTimer();
  }

  /** Alias for `start()`, for wiring to a socket's open event. */
  onOpen(): void {
    this.start();
  }

  /** Tab returned to visible: clear all samples, go not-ready, burst (4.3). */
  onVisible(): void {
    this.reset();
    this.start();
  }

  /** Socket closed: cancel every timer. Samples are kept for a reconnect. */
  stop(): void {
    this.clearBurst();
    this.clearSteady();
    this.clearDegradedTimer();
  }

  /** Handles a `sync { c0, s1 }` reply from the server (4.2). */
  onReply(c0: number, s1: number): void {
    const c1 = this.deps.now();
    const rtt = c1 - c0;
    if (!(rtt >= 0 && rtt <= CLOCK_SYNC.maxRttMs)) return;

    const offset = s1 - (c0 + c1) / 2;
    this.samples.push({ rtt, offset });
    if (this.samples.length > CLOCK_SYNC.windowSize) this.samples.shift();

    const best = this.best() ?? { rtt, offset };
    this.recentBest.push(best.offset);
    if (this.recentBest.length > CLOCK_SYNC.readyStabilityReplies) {
      this.recentBest.shift();
    }
    this.setTarget(best.offset, c1);

    if (this.firstReplyAt === null) {
      this.firstReplyAt = c1;
      this.armDegradedTimer();
    }
    this.evaluate();
  }

  // --- Internals -----------------------------------------------------------

  private best(): ClockSample | null {
    let best: ClockSample | null = null;
    for (const s of this.samples) if (!best || s.rtt < best.rtt) best = s;
    return best;
  }

  private appliedAt(t: number): number {
    if (this.target === null) return this.slewFrom;
    const diff = this.target - this.slewFrom;
    const moved =
      CLOCK_SYNC.slewRateMsPerMs * Math.max(0, t - this.slewStartAt);
    if (Math.abs(diff) <= moved) return this.target;
    return this.slewFrom + Math.sign(diff) * moved;
  }

  private setTarget(estimate: number, t: number): void {
    const current = this.appliedAt(t);
    this.target = estimate;
    if (
      this.snapNext ||
      Math.abs(estimate - current) <= CLOCK_SYNC.slewSnapMs
    ) {
      this.slewFrom = estimate;
      this.snapNext = false;
    } else {
      this.slewFrom = current;
    }
    this.slewStartAt = t;
  }

  /** Strict ready gate from 4.4. */
  private gatePasses(): boolean {
    const best = this.best();
    if (!best) return false;
    if (this.samples.length < CLOCK_SYNC.readyMinSamples) return false;
    if (best.rtt > CLOCK_SYNC.readyMaxRttMs) return false;
    if (this.recentBest.length < CLOCK_SYNC.readyStabilityReplies) return false;
    const spread = Math.max(...this.recentBest) - Math.min(...this.recentBest);
    return spread <= CLOCK_SYNC.readyMaxSpreadMs;
  }

  /**
   * Updates ready/degraded. Ready is sticky until the next reset.
   * `fallbackDue` is set by the 6 s timer, so a timer that fires a fraction
   * of a millisecond early by the injected clock still counts.
   */
  private evaluate(fallbackDue = false): void {
    if (this.gatePasses()) {
      // Also lifts a degraded clock to a fully ready one.
      this.clearDegradedTimer();
      this.setState(true, false);
      return;
    }
    if (this._ready) return;
    if (
      this.firstReplyAt !== null &&
      (fallbackDue ||
        this.deps.now() - this.firstReplyAt >= CLOCK_SYNC.degradedAfterMs) &&
      this.samples.length >= CLOCK_SYNC.degradedMinSamples
    ) {
      this.setState(true, true);
    }
  }

  private setState(ready: boolean, degraded: boolean): void {
    if (ready === this._ready && degraded === this._degraded) return;
    this._ready = ready;
    this._degraded = degraded;
    this.onChange?.({ ready, degraded, bestRtt: this.bestRtt });
  }

  private reset(): void {
    this.samples = [];
    this.recentBest = [];
    this.firstReplyAt = null;
    this.clearDegradedTimer();
    // Keep the old applied offset for serverNow() until a new estimate
    // arrives, then apply that estimate at once (4.5).
    this.slewFrom = this.appliedAt(this.deps.now());
    this.target = null;
    this.snapNext = true;
    this.setState(false, false);
  }

  private ping(): void {
    this.deps.send(this.deps.now());
  }

  private burst(): void {
    this.clearBurst();
    this.clearSteady();
    let sent = 0;
    const tick = () => {
      this.ping();
      sent += 1;
      if (sent >= CLOCK_SYNC.burstCount) {
        this.clearBurst();
        this.startSteady();
      }
    };
    const every = this.deps.setInterval;
    this.burstTimer = every(tick, CLOCK_SYNC.burstIntervalMs);
    tick();
  }

  private startSteady(): void {
    this.clearSteady();
    const every = this.deps.setInterval;
    this.steadyTimer = every(() => this.ping(), CLOCK_SYNC.steadyIntervalMs);
  }

  private armDegradedTimer(): void {
    this.clearDegradedTimer();
    if (this.firstReplyAt === null) return;
    const remaining =
      this.firstReplyAt + CLOCK_SYNC.degradedAfterMs - this.deps.now();
    const after = this.deps.setTimeout;
    this.degradedTimer = after(
      () => {
        this.degradedTimer = null;
        this.evaluate(true);
      },
      Math.max(0, remaining),
    );
  }

  private clearBurst(): void {
    if (this.burstTimer === null) return;
    const cancel = this.deps.clearInterval;
    cancel(this.burstTimer);
    this.burstTimer = null;
  }

  private clearSteady(): void {
    if (this.steadyTimer === null) return;
    const cancel = this.deps.clearInterval;
    cancel(this.steadyTimer);
    this.steadyTimer = null;
  }

  private clearDegradedTimer(): void {
    if (this.degradedTimer === null) return;
    const cancel = this.deps.clearTimeout;
    cancel(this.degradedTimer);
    this.degradedTimer = null;
  }
}
