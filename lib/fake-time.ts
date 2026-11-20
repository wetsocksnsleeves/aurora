import type { ClockSyncEnv, TimerHandle } from "./clock-sync";

/**
 * Fake local clock and timers for tests and the sim harness. Time only moves
 * through `advance`, which runs due timers in time order. Implements
 * `ClockSyncEnv`, so it can drive `ClockSync` and the page clients.
 */
export class FakeTime implements ClockSyncEnv {
  t: number;
  private nextId = 1;
  private timers = new Map<
    number,
    { at: number; fn: () => void; every: number | null }
  >();

  constructor(start = 0) {
    this.t = start;
  }

  now = (): number => this.t;

  setTimeout = (fn: () => void, ms: number): TimerHandle => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn, every: null });
    return id;
  };

  setInterval = (fn: () => void, ms: number): TimerHandle => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.t + ms, fn, every: ms });
    return id;
  };

  clear = (handle: TimerHandle): void => {
    this.timers.delete(handle as number);
  };

  clearTimeout = this.clear;
  clearInterval = this.clear;

  /** Runs due timers in time order, then leaves the clock at `t + ms`. */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let nextId: number | null = null;
      let nextAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= end && timer.at < nextAt) {
          nextId = id;
          nextAt = timer.at;
        }
      }
      if (nextId === null) break;
      const timer = this.timers.get(nextId)!;
      this.t = timer.at;
      if (timer.every === null) this.timers.delete(nextId);
      else timer.at += timer.every;
      timer.fn();
    }
    this.t = end;
  }

  get intervalCount(): number {
    return [...this.timers.values()].filter((x) => x.every !== null).length;
  }

  get timeoutCount(): number {
    return [...this.timers.values()].filter((x) => x.every === null).length;
  }
}
