import mixtape from "./mixtape.json";
import { TEST_VENUE } from "./test-show";
import type { Clip, Show } from "./types";

/**
 * Built-in show that plays about 40 s of three songs in different genres:
 * 2hollis "poster boy", 2KE "PHONK DA FAVELADA" and chandol "Reckless".
 * Each song's lights were generated from the whole track, then the loudest
 * stretch around a drop was cut out and joined by `scripts/mixtape.ts`,
 * which also wrote the audio. `sections` in the JSON says where each song
 * sits.
 */
export const MIXTAPE_SHOW_ID = "mixtape";

/** Fixed id so the audio route can map it to the bundled file. */
export const MIXTAPE_AUDIO_FILE_ID = "d4d476f2-4280-4821-bce3-c9abc634d244.mp3";

export const MIXTAPE_SHOW: Show = {
  id: MIXTAPE_SHOW_ID,
  name: "Mixtape",
  venue: TEST_VENUE,
  audio: {
    fileId: MIXTAPE_AUDIO_FILE_ID,
    durationMs: mixtape.durationMs,
    title: "Mixtape",
    artist: "2hollis, 2KE, chandol",
  },
  clips: mixtape.clips as Clip[],
  createdAt: "2026-11-21T00:00:00.000Z",
  updatedAt: "2026-11-21T00:00:00.000Z",
};
