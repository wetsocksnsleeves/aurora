import phonk from "./phonk-da-favelada.json";
import { TEST_VENUE } from "./test-show";
import type { Clip, Show } from "./types";

/**
 * Built-in show for "PHONK DA FAVELADA" by 2KE. The clips were generated
 * from the audio by `scripts/light-show.ts` (beats, kicks, snares, loudness).
 * The audio ships in `public/builtin-audio/` and is served through the same
 * `/api/audio/<fileId>` route as uploads (`builtinAudioPath` in the audio store).
 */
export const PHONK_SHOW_ID = "phonk-da-favelada";

/** Fixed id so the audio route can map it to the bundled file. */
export const PHONK_AUDIO_FILE_ID = "6d0f6c5e-3b1a-4c8e-9a52-7f4e1b2d9c30.mp3";

export const PHONK_SHOW: Show = {
  id: PHONK_SHOW_ID,
  name: "PHONK DA FAVELADA",
  venue: TEST_VENUE,
  audio: {
    fileId: PHONK_AUDIO_FILE_ID,
    durationMs: phonk.durationMs,
    title: "PHONK DA FAVELADA",
    artist: "2KE",
  },
  clips: phonk.clips as Clip[],
  createdAt: "2026-11-21T00:00:00.000Z",
  updatedAt: "2026-11-21T00:00:00.000Z",
};
