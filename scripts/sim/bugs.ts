import { ClockSync } from "@/lib/clock-sync";

/**
 * Deliberate bugs for the harness's self-test: a run with one of these must
 * fail, or the harness is not measuring anything. Each patches
 * `ClockSync.prototype` for the length of one run, so the browser code
 * itself never carries a bug flag.
 *
 * - `no-slew`: the applied offset never slews towards a new estimate. Only
 *   corrections of 8 ms or less (the snap threshold) are ever applied, so
 *   a client stays on whatever its first, often poor, estimate was.
 * - `offset-formula`: the offset is computed as `s1 - c0` instead of
 *   `s1 - (c0 + c1) / 2`, so it is off by half the round trip.
 */
export const BUGS = ["no-slew", "offset-formula"] as const;
export type BugName = (typeof BUGS)[number];

/** The private members the patches reach into. */
type ClockSyncInternals = {
  appliedAt(t: number): number;
  slewFrom: number;
  deps: { now(): number };
  onReply(c0: number, s1: number): void;
};

/** Applies `bug` and returns a function that removes it. */
export function injectBug(bug: BugName): () => void {
  // TypeScript `private` is compile-time only; the members exist at runtime.
  const proto = ClockSync.prototype as unknown as ClockSyncInternals;
  switch (bug) {
    case "no-slew": {
      const original = proto.appliedAt;
      proto.appliedAt = function (this: ClockSyncInternals) {
        return this.slewFrom;
      };
      return () => void (proto.appliedAt = original);
    }
    case "offset-formula": {
      const original = proto.onReply;
      proto.onReply = function (this: ClockSyncInternals, c0, s1) {
        // ClockSync computes s1' - (c0 + c1) / 2; with this s1' that is
        // exactly s1 - c0.
        const c1 = this.deps.now();
        original.call(this, c0, s1 + (c1 - c0) / 2);
      };
      return () => void (proto.onReply = original);
    }
  }
}
