import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STOP_TIMEOUT_MS, record } from "./recorder";

/** A stand-in MediaRecorder. `silentStop`: never fires "stop", like Safari can. */
function fakeRecorder(silentStop: boolean) {
  return class {
    state: RecordingState = "inactive";
    mimeType = "video/mp4";
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    start() {
      this.state = "recording";
      this.ondataavailable?.({ data: new Blob(["frames"]) });
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["more"]) });
      if (!silentStop) this.onstop?.();
    }
  } as unknown as typeof MediaRecorder;
}

describe("record", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("finishes when the recorder says it stopped", async () => {
    const run = record({} as MediaStream, "video/mp4", fakeRecorder(false));
    const blob = await run.finish();
    expect(blob.size).toBe("framesmore".length);
  });

  it("doesn't hang when the recorder never says it stopped", async () => {
    const run = record({} as MediaStream, "video/mp4", fakeRecorder(true));
    const done = run.finish();
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS);
    // What it had recorded so far.
    expect((await done).size).toBe("framesmore".length);
  });
});
