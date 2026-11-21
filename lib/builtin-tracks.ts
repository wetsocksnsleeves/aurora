import type { Show } from "./types";

/**
 * Music shipped with the app, offered in the music chooser on every install.
 * The files live in `public/builtin-audio/` and are served through the same
 * `/api/audio/<fileId>` route as uploads (`BUILTIN_AUDIO` in the audio store).
 */
export type BuiltinTrack = Show["audio"] & {
  /** Path from the working directory to the bundled file. */
  path: string;
};

export const BUILTIN_TRACKS: readonly BuiltinTrack[] = [
  {
    fileId: "3d5e4cc9-f73c-4005-851e-094ff829d7a6.mp3",
    path: "public/builtin-audio/gigachad-theme.mp3",
    durationMs: 146_332,
    title: "GigaChad Theme - Phonk House Version",
    artist: "g3ox_em",
  },
];
