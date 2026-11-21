import { DEVICE_TEST_SHOW } from "./device-test-show";
import { MIXTAPE_SHOW } from "./mixtape-show";
import { TEST_SHOW } from "./test-show";
import type { Show } from "./types";

/**
 * Shows built into the app rather than stored in SQLite. They are listed as
 * read-only on the show list and can be hosted like saved shows, which is
 * handy for sync testing without audio.
 */
export type BuiltinShow = {
  show: Show;
  /** One line for the show list. */
  note: string;
  /** Turn the host's click track on by default. */
  clickTrack: boolean;
};

export const BUILTIN_SHOWS: readonly BuiltinShow[] = [
  {
    show: TEST_SHOW,
    note: "White wave, left to right. No audio, for sync testing.",
    clickTrack: false,
  },
  {
    show: DEVICE_TEST_SHOW,
    note: "Full-venue white flash every second for 60 s. For filming phones (docs/device-test.md).",
    clickTrack: true,
  },
  {
    show: MIXTAPE_SHOW,
    note: "Poster boy, phonk and Reckless, 40 s each. Lights generated per song, with audio.",
    clickTrack: false,
  },
];

/** The built-in show with this id, if any. */
export function builtinShow(id: string): Show | undefined {
  return BUILTIN_SHOWS.find((b) => b.show.id === id)?.show;
}

/** Whether the host's click track starts on for this show. */
export function clickTrackByDefault(showId: string): boolean {
  return BUILTIN_SHOWS.find((b) => b.show.id === showId)?.clickTrack ?? false;
}
