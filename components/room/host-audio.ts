import {
  AUDIO_RESYNC_THRESHOLD_MS,
  audioDriftMs,
  audioStart,
  clickContextTimes,
  contextTimeForShowMs,
  type AudioClockSample,
} from "@/lib/audio-schedule";

/**
 * The host machine's audio (SPEC 4.8): decodes the show's track into an
 * `AudioBuffer` on page load and starts an `AudioBufferSourceNode` at the
 * `AudioContext` time that matches `T0` (maths in `lib/audio-schedule.ts`).
 * Optionally schedules a click (a short oscillator beep) at given show
 * times, so the manual offset can be tuned by ear against flashing phones.
 *
 * Browsers keep a new `AudioContext` suspended until a user gesture, so the
 * host page calls `unlock()` from the Start click or an "Enable audio"
 * button. Scheduling waits until the context runs.
 */

export type AudioLoadState =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "ready"; durationS: number }
  | { kind: "error"; message: string };

export type HostAudioSnapshot = {
  load: AudioLoadState;
  /** `AudioContext.state`, or "none" before the context exists. */
  context: AudioContextState | "none";
  /** What the last `play()` scheduled, for display and debugging. */
  scheduled: ScheduledRun | null;
};

export type ScheduledRun = {
  T0: number;
  /** The clock sample the schedule was computed from. */
  sample: AudioClockSample;
  /** Track start, or null if there is no track or it was already over. */
  track: { whenS: number; offsetS: number } | null;
  clicks: number;
  /** How many times the drift check rescheduled this show's audio. */
  resyncs: number;
};

export type PlayOptions = {
  T0: number;
  /** `clock.serverNow()` of the host's `ClockSync`. */
  serverNow: () => number;
  manualOffsetMs: number;
  /** Show length; the track and clicks stop there. */
  showDurationMs: number;
  /** Show times to click at, or null for no click track. */
  clickTimesMs: readonly number[] | null;
};

/** Mid-show starts are scheduled this far ahead (see `audioStart`). */
const START_LEAD_S = 0.03;
const CLICK_LENGTH_S = 0.03;
const CLICK_HZ = 1_000;
/** How often the drift check runs while audio is scheduled. */
const DRIFT_CHECK_MS = 250;
/** Drift must exceed the threshold this many checks in a row. */
const DRIFT_CHECKS_TO_RESYNC = 2;

type Run = {
  gain: GainNode;
  nodes: AudioScheduledSourceNode[];
  /** Context time that show time 0 maps to. */
  originS: number;
  /** Context time of the show's end. */
  endS: number;
  options: PlayOptions;
  watchdog: ReturnType<typeof setInterval>;
  overThreshold: number;
};

export class HostAudio {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private loadedUrl: string | null = null;
  private loadToken = 0;
  private run: Run | null = null;
  private snapshot: HostAudioSnapshot = {
    load: { kind: "none" },
    context: "none",
    scheduled: null,
  };
  private readonly subscribers = new Set<() => void>();

  getSnapshot = (): HostAudioSnapshot => this.snapshot;

  subscribe = (onChange: () => void): (() => void) => {
    this.subscribers.add(onChange);
    return () => this.subscribers.delete(onChange);
  };

  /** The context, created on first use. Starts suspended without a gesture. */
  context(): AudioContext {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: "interactive" });
      ctx.onstatechange = () => {
        if (this.ctx === ctx) this.update({ context: ctx.state });
      };
      this.ctx = ctx;
      this.update({ context: ctx.state });
    }
    return this.ctx;
  }

  /** Fetch and decode the track at `url`; null means the show has no audio. */
  async load(url: string | null): Promise<void> {
    if (url === this.loadedUrl) return;
    this.loadedUrl = url;
    this.buffer = null;
    const token = ++this.loadToken;
    if (!url) {
      this.update({ load: { kind: "none" } });
      return;
    }
    this.update({ load: { kind: "loading" } });
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
      const bytes = await res.arrayBuffer();
      const buffer = await this.context().decodeAudioData(bytes);
      if (token !== this.loadToken) return;
      this.buffer = buffer;
      this.update({ load: { kind: "ready", durationS: buffer.duration } });
    } catch (err) {
      if (token !== this.loadToken) return;
      this.update({
        load: {
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  /** Resume the context. Call from a click handler (a user gesture). */
  async unlock(): Promise<void> {
    const ctx = this.context();
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        // Still suspended; the page keeps offering "Enable audio".
      }
    }
    this.update({ context: ctx.state });
  }

  get running(): boolean {
    return this.ctx?.state === "running";
  }

  /**
   * Schedule the track (and clicks) for a show starting at `T0`, replacing
   * anything scheduled before. Does nothing while the context is suspended.
   */
  play(options: PlayOptions, resyncs = 0): ScheduledRun | null {
    this.stop();
    const ctx = this.ctx;
    if (!ctx || ctx.state !== "running") return null;

    // Sample both clocks together.
    const sample: AudioClockSample = {
      T0: options.T0,
      serverNowMs: options.serverNow(),
      ctxTimeS: ctx.currentTime,
      outputLatencyS: ctx.outputLatency || 0,
      manualOffsetMs: options.manualOffsetMs,
    };
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    // Where show end lands on the context clock; nothing plays past it.
    const endS = contextTimeForShowMs(options.showDurationMs, sample);
    const run: Run = {
      gain,
      nodes: [],
      originS: contextTimeForShowMs(0, sample),
      endS,
      options,
      watchdog: setInterval(() => this.checkDrift(run), DRIFT_CHECK_MS),
      overThreshold: 0,
    };

    let track: ScheduledRun["track"] = null;
    if (this.buffer) {
      const start = audioStart(sample, this.buffer.duration, START_LEAD_S);
      if (start) {
        const source = ctx.createBufferSource();
        source.buffer = this.buffer;
        source.connect(gain);
        source.start(start.whenS, start.offsetS);
        if (endS > start.whenS) source.stop(endS);
        run.nodes.push(source);
        track = start;
      }
    }

    let clicks = 0;
    if (options.clickTimesMs) {
      for (const at of clickContextTimes(
        options.clickTimesMs,
        sample,
        START_LEAD_S,
      )) {
        if (at > endS) continue;
        run.nodes.push(this.click(ctx, gain, at));
        clicks++;
      }
    }

    this.run = run;
    const scheduled: ScheduledRun = {
      T0: options.T0,
      sample,
      track,
      clicks,
      resyncs,
    };
    this.update({ scheduled });
    return scheduled;
  }

  /** Stop and drop everything scheduled. */
  stop(): void {
    const run = this.run;
    this.run = null;
    if (run) {
      clearInterval(run.watchdog);
      for (const node of run.nodes) {
        try {
          node.stop();
        } catch {
          // Never started or already stopped.
        }
      }
      run.gain.disconnect();
    }
    if (this.snapshot.scheduled) this.update({ scheduled: null });
  }

  /** Release the context. A later `load()` or `context()` starts afresh. */
  close(): void {
    this.stop();
    this.loadToken++;
    this.loadedUrl = null;
    this.buffer = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.update({ load: { kind: "none" }, context: "none" });
  }

  /**
   * Reschedule when the audio has slipped against the show clock: the
   * context clock stalled (Chrome drops ~30 ms when output starts after
   * silence) or the clock-sync estimate moved. See `audioDriftMs`.
   */
  private checkDrift(run: Run): void {
    const ctx = this.ctx;
    if (run !== this.run || !ctx || ctx.state !== "running") return;
    if (ctx.currentTime > run.endS) {
      clearInterval(run.watchdog);
      return;
    }
    const driftMs = audioDriftMs(run.originS, {
      T0: run.options.T0,
      serverNowMs: run.options.serverNow(),
      ctxTimeS: ctx.currentTime,
      outputLatencyS: ctx.outputLatency || 0,
      manualOffsetMs: run.options.manualOffsetMs,
    });
    if (Math.abs(driftMs) <= AUDIO_RESYNC_THRESHOLD_MS) {
      run.overThreshold = 0;
      return;
    }
    run.overThreshold += 1;
    if (run.overThreshold < DRIFT_CHECKS_TO_RESYNC) return;
    const resyncs = (this.snapshot.scheduled?.resyncs ?? 0) + 1;
    console.info(
      `aurora: audio ${driftMs > 0 ? "late" : "early"} by ${Math.abs(driftMs).toFixed(1)} ms, rescheduling`,
    );
    this.play(run.options, resyncs);
  }

  /** A short beep at context time `at`. */
  private click(
    ctx: AudioContext,
    out: AudioNode,
    at: number,
  ): AudioScheduledSourceNode {
    const osc = ctx.createOscillator();
    osc.frequency.value = CLICK_HZ;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, 0);
    env.gain.setValueAtTime(0.6, at);
    env.gain.exponentialRampToValueAtTime(0.001, at + CLICK_LENGTH_S);
    osc.connect(env).connect(out);
    osc.start(at);
    osc.stop(at + CLICK_LENGTH_S + 0.01);
    return osc;
  }

  private update(patch: Partial<HostAudioSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const fn of this.subscribers) fn();
  }
}
