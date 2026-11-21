/**
 * Maths for starting the host's audio on the same clock as the phones
 * (SPEC 4.8). Pure: the host page samples `clock.serverNow()` and
 * `AudioContext.currentTime` together and passes them in.
 *
 * Show time `t` plays on the phones when the server clock reads `T0 + t`.
 * The sample for show time `t` must therefore reach the speakers then, so it
 * is handed to the `AudioContext` at
 *
 *   ctxTime + (T0 + t - serverNow) / 1000 - outputLatency + manualOffsetMs / 1000
 *
 * `outputLatency` is what the browser reports (0 if it reports nothing).
 * `manualOffsetMs` is the host's slider: positive plays the audio later,
 * negative earlier (use negative to cancel unreported Bluetooth delay).
 */

/** The manual offset slider runs from -500 to +500 ms (SPEC 4.8). */
export const AUDIO_OFFSET_LIMIT_MS = 500;

/** localStorage key for the manual offset. */
export const AUDIO_OFFSET_STORAGE_KEY = "lightshow.audioOffsetMs";

export type AudioClockSample = {
  /** Server-clock start time of the show. */
  T0: number;
  /** `clock.serverNow()`, sampled together with `ctxTimeS`. */
  serverNowMs: number;
  /** `AudioContext.currentTime`, in seconds. */
  ctxTimeS: number;
  /** `AudioContext.outputLatency` in seconds, or 0 when not reported. */
  outputLatencyS: number;
  /** Manual offset from the slider. Clamped to ±`AUDIO_OFFSET_LIMIT_MS`. */
  manualOffsetMs: number;
};

/** Clamp to ±`AUDIO_OFFSET_LIMIT_MS`; anything not finite becomes 0. */
export function clampAudioOffsetMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(
    Math.min(AUDIO_OFFSET_LIMIT_MS, Math.max(-AUDIO_OFFSET_LIMIT_MS, value)),
  );
}

/** Parse a stored offset; missing or garbage gives 0. */
export function parseAudioOffsetMs(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw.trim() === "") return 0;
  return clampAudioOffsetMs(Number(raw));
}

/** `AudioContext` time (s) at which to schedule the sound for show time `showMs`. */
export function contextTimeForShowMs(
  showMs: number,
  sample: AudioClockSample,
): number {
  const delayMs = sample.T0 + showMs - sample.serverNowMs;
  const latencyS = Number.isFinite(sample.outputLatencyS)
    ? Math.max(0, sample.outputLatencyS)
    : 0;
  return (
    sample.ctxTimeS +
    delayMs / 1000 -
    latencyS +
    clampAudioOffsetMs(sample.manualOffsetMs) / 1000
  );
}

/** Arguments for `AudioBufferSourceNode.start(whenS, offsetS)`. */
export type AudioStart = { whenS: number; offsetS: number };

/**
 * When and where in the buffer to start the track.
 *
 * - Before the show (`delayMs` ahead, after corrections): start at the
 *   matching context time from the top of the buffer.
 * - Joining mid-show (the start time is already past): start now, skipping
 *   into the buffer by however late we are, corrections included.
 *
 * `leadS` is a small margin for the mid-show case: the node is scheduled
 * `leadS` ahead of `ctxTimeS` (and the offset grows to match), so the time
 * the context takes to reach `start()` does not shift the audio. Pass 0 to
 * start exactly at `ctxTimeS`.
 *
 * Returns null when the track has already finished.
 */
export function audioStart(
  sample: AudioClockSample,
  bufferDurationS: number,
  leadS = 0,
): AudioStart | null {
  const atS = contextTimeForShowMs(0, sample);
  const earliestS = sample.ctxTimeS + Math.max(0, leadS);
  if (atS >= earliestS) return { whenS: atS, offsetS: 0 };
  const offsetS = earliestS - atS;
  if (offsetS >= bufferDurationS) return null;
  return { whenS: earliestS, offsetS };
}

/**
 * Show times for the host's click track: the start of every clip, sorted,
 * without repeats. For the device test show that is each flash.
 */
export function clickTimesForShow(show: {
  clips: readonly { startMs: number }[];
}): number[] {
  return [...new Set(show.clips.map((c) => c.startMs))].sort((a, b) => a - b);
}

/**
 * Context times for clicks at the given show times. Clicks that would sound
 * before `ctxTimeS + leadS` are dropped (they are in the past).
 */
export function clickContextTimes(
  showTimesMs: readonly number[],
  sample: AudioClockSample,
  leadS = 0,
): number[] {
  const earliestS = sample.ctxTimeS + Math.max(0, leadS);
  const out: number[] = [];
  for (const t of showTimesMs) {
    const at = contextTimeForShowMs(t, sample);
    if (at >= earliestS) out.push(at);
  }
  return out;
}

/**
 * Above this, the host reschedules the track (see `audioDriftMs`). The
 * context clock jitters by a few ms per read, so stay well clear of that.
 */
export const AUDIO_RESYNC_THRESHOLD_MS = 15;

/**
 * How far the audio has slipped since it was scheduled, in ms. `originS` is
 * the context time that show time 0 was mapped to when the track was
 * scheduled; a fresh `sample` maps it again. Positive means the audio now
 * plays late, negative early.
 *
 * The context clock can stall: Chrome loses about 30 ms when output first
 * starts after silence, and an underrun loses more. Clock-sync corrections
 * move `serverNow` too. A track scheduled once would carry those errors for
 * the rest of the show, so the host checks this every few hundred ms.
 */
export function audioDriftMs(
  originS: number,
  sample: AudioClockSample,
): number {
  return (originS - contextTimeForShowMs(0, sample)) * 1000;
}
