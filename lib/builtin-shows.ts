import { TEST_SHOW } from "./test-show";
import type { Show } from "./types";

/**
 * Shows built into the app rather than stored in SQLite. They are listed as
 * read-only on the show list and can be hosted like saved shows, which is
 * handy for sync testing without audio.
 */
export const BUILTIN_SHOWS: readonly Show[] = [TEST_SHOW];

/** The built-in show with this id, if any. */
export function builtinShow(id: string): Show | undefined {
  return BUILTIN_SHOWS.find((show) => show.id === id);
}
