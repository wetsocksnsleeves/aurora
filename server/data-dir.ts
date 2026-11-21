import path from "node:path";

// The turbopackIgnore comments stop `next build` from treating these runtime
// paths as files to trace, which would pull the whole project into the
// server output. Data lives outside the build and is read at runtime only.

/**
 * Root folder for app data: the SQLite file and uploaded audio.
 * `LIGHTSHOW_DATA_DIR` overrides it, so tests can point at a temp folder.
 */
export function dataDir(): string {
  return path.resolve(
    /*turbopackIgnore: true*/ process.env.LIGHTSHOW_DATA_DIR ?? "data",
  );
}

/** `LIGHTSHOW_DB_PATH` overrides the database file on its own. */
export function dbPath(): string {
  const override = process.env.LIGHTSHOW_DB_PATH;
  return override
    ? path.resolve(/*turbopackIgnore: true*/ override)
    : path.join(/*turbopackIgnore: true*/ dataDir(), "lightshow.db");
}

export function audioDir(): string {
  return path.join(/*turbopackIgnore: true*/ dataDir(), "audio");
}
