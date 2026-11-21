import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { PositioningConfig, Show } from "@/lib/types";
import { dbPath } from "./data-dir";
import { emptyShowInput, type ShowInput } from "./show-validation";

export type ShowSummary = Pick<
  Show,
  "id" | "name" | "createdAt" | "updatedAt"
> & {
  /** `showDurationMs(show)`: the audio length or the last clip end, if later. */
  durationMs: number;
  /** The show has an audio file. */
  hasAudio: boolean;
};

type Handle = { path: string; db: Database.Database };

// Next bundles each route handler separately, and dev mode re-evaluates
// modules on change. Keeping the handle on globalThis means one connection
// per process instead of one per bundle or per reload.
const holder = globalThis as typeof globalThis & { __lightshowDb?: Handle };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS shows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS shows_updated_at ON shows (updated_at);
  CREATE TABLE IF NOT EXISTS rooms (
    code TEXT PRIMARY KEY,
    host_token TEXT NOT NULL,
    show_id TEXT NOT NULL,
    positioning TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

/** Open (or reuse) the database at `dbPath()`, creating the schema on first use. */
export function getDb(): Database.Database {
  const file = dbPath();
  const existing = holder.__lightshowDb;
  if (existing && existing.path === file && existing.db.open)
    return existing.db;
  if (existing?.db.open) existing.db.close();

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  holder.__lightshowDb = { path: file, db };
  return db;
}

/** Close the shared connection. Tests call this between temp databases. */
export function closeDb(): void {
  const existing = holder.__lightshowDb;
  if (existing?.db.open) existing.db.close();
  holder.__lightshowDb = undefined;
}

type ShowRow = {
  id: string;
  name: string;
  data: string;
  created_at: string;
  updated_at: string;
};

function rowToShow(row: ShowRow): Show {
  const body = JSON.parse(row.data) as Pick<Show, "venue" | "audio" | "clips">;
  return {
    id: row.id,
    name: row.name,
    venue: body.venue,
    audio: body.audio,
    clips: body.clips,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function showData(show: Pick<Show, "venue" | "audio" | "clips">): string {
  return JSON.stringify({
    venue: show.venue,
    audio: show.audio,
    clips: show.clips,
  });
}

type SummaryRow = Omit<ShowRow, "data"> & {
  audio_ms: number | null;
  clips_end_ms: number | null;
  audio_file: string | null;
};

/**
 * All shows, most recently updated first. Summaries only: SQLite reads the
 * duration and audio id out of the JSON, so the show bodies are not parsed.
 */
export function listShows(): ShowSummary[] {
  const rows = getDb()
    .prepare(
      `SELECT id, name, created_at, updated_at,
        json_extract(data, '$.audio.durationMs') AS audio_ms,
        json_extract(data, '$.audio.fileId') AS audio_file,
        (SELECT MAX(json_extract(c.value, '$.endMs'))
           FROM json_each(data, '$.clips') AS c) AS clips_end_ms
      FROM shows ORDER BY updated_at DESC, id`,
    )
    .all() as SummaryRow[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    durationMs: Math.max(0, r.audio_ms ?? 0, r.clips_end_ms ?? 0),
    hasAudio: typeof r.audio_file === "string" && r.audio_file !== "",
  }));
}

type AudioRow = {
  file_id: string;
  duration_ms: number | null;
  title: string | null;
  artist: string | null;
};

/**
 * The music used by saved shows, most recently updated show first, one entry
 * per file. A title or artist missing from the newest show that uses a file
 * is taken from an older one.
 */
export function listRecentAudio(limit = 12): Show["audio"][] {
  const rows = getDb()
    .prepare(
      `SELECT json_extract(data, '$.audio.fileId') AS file_id,
        json_extract(data, '$.audio.durationMs') AS duration_ms,
        json_extract(data, '$.audio.title') AS title,
        json_extract(data, '$.audio.artist') AS artist
      FROM shows
      WHERE file_id IS NOT NULL AND file_id != ''
      ORDER BY updated_at DESC, id`,
    )
    .all() as AudioRow[];
  const byFile = new Map<string, Show["audio"]>();
  for (const r of rows) {
    if (typeof r.file_id !== "string") continue;
    const seen = byFile.get(r.file_id);
    if (!seen && byFile.size >= limit) continue;
    const track = seen ?? { fileId: r.file_id, durationMs: 0 };
    track.durationMs ||= Math.max(0, r.duration_ms ?? 0);
    if (!track.title && typeof r.title === "string") track.title = r.title;
    if (!track.artist && typeof r.artist === "string") track.artist = r.artist;
    byFile.set(r.file_id, track);
  }
  return [...byFile.values()];
}

export function getShow(id: string): Show | null {
  const row = getDb().prepare("SELECT * FROM shows WHERE id = ?").get(id) as
    ShowRow | undefined;
  return row ? rowToShow(row) : null;
}

/** Create a show. Missing fields get the defaults from `emptyShowInput`. */
export function createShow(input: Partial<ShowInput> = {}): Show {
  const now = new Date().toISOString();
  const show: Show = {
    ...emptyShowInput(),
    ...input,
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
  getDb()
    .prepare(
      "INSERT INTO shows (id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(show.id, show.name, showData(show), show.createdAt, show.updatedAt);
  return show;
}

/** Merge `patch` over the stored show. Returns null if the show does not exist. */
export function updateShow(id: string, patch: Partial<ShowInput>): Show | null {
  const db = getDb();
  const update = db.transaction((): Show | null => {
    const current = getShow(id);
    if (!current) return null;
    const next: Show = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    db.prepare(
      "UPDATE shows SET name = ?, data = ?, updated_at = ? WHERE id = ?",
    ).run(next.name, showData(next), next.updatedAt, id);
    return next;
  });
  return update();
}

/** Returns false if there was no such show. */
export function deleteShow(id: string): boolean {
  return getDb().prepare("DELETE FROM shows WHERE id = ?").run(id).changes > 0;
}

// ---------------------------------------------------------------------------
// Rooms (SPEC 2.5): a host's session, kept so phones can rejoin the same room
// after a server restart.
// ---------------------------------------------------------------------------

export type RoomRecord = {
  code: string;
  hostToken: string;
  showId: string;
  positioning: PositioningConfig;
};

type RoomRow = {
  code: string;
  host_token: string;
  show_id: string;
  positioning: string;
};

export function getRoom(code: string): RoomRecord | null {
  const row = getDb()
    .prepare(
      "SELECT code, host_token, show_id, positioning FROM rooms WHERE code = ?",
    )
    .get(code) as RoomRow | undefined;
  if (!row) return null;
  return {
    code: row.code,
    hostToken: row.host_token,
    showId: row.show_id,
    positioning: JSON.parse(row.positioning) as PositioningConfig,
  };
}

export function saveRoom(room: RoomRecord): void {
  getDb()
    .prepare(
      `INSERT INTO rooms (code, host_token, show_id, positioning, updated_at)
       VALUES (@code, @hostToken, @showId, @positioning, @updatedAt)
       ON CONFLICT(code) DO UPDATE SET
         show_id = excluded.show_id,
         positioning = excluded.positioning,
         updated_at = excluded.updated_at`,
    )
    .run({
      code: room.code,
      hostToken: room.hostToken,
      showId: room.showId,
      positioning: JSON.stringify(room.positioning),
      updatedAt: new Date().toISOString(),
    });
}
