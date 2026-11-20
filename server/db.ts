import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Show } from "@/lib/types";
import { dbPath } from "./data-dir";
import { emptyShowInput, type ShowInput } from "./show-validation";

export type ShowSummary = Pick<Show, "id" | "name" | "createdAt" | "updatedAt">;

type Handle = { path: string; db: Database.Database };

// Next bundles each route handler separately, and dev mode re-evaluates
// modules on change. Keeping the handle on globalThis means one connection
// per process instead of one per bundle or per reload.
const holder = globalThis as typeof globalThis & { __auroraDb?: Handle };

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS shows (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS shows_updated_at ON shows (updated_at);
`;

/** Open (or reuse) the database at `dbPath()`, creating the schema on first use. */
export function getDb(): Database.Database {
  const file = dbPath();
  const existing = holder.__auroraDb;
  if (existing && existing.path === file && existing.db.open)
    return existing.db;
  if (existing?.db.open) existing.db.close();

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  holder.__auroraDb = { path: file, db };
  return db;
}

/** Close the shared connection. Tests call this between temp databases. */
export function closeDb(): void {
  const existing = holder.__auroraDb;
  if (existing?.db.open) existing.db.close();
  holder.__auroraDb = undefined;
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

/** All shows, most recently updated first. Summaries only, no show JSON. */
export function listShows(): ShowSummary[] {
  const rows = getDb()
    .prepare(
      "SELECT id, name, created_at, updated_at FROM shows ORDER BY updated_at DESC, id",
    )
    .all() as Omit<ShowRow, "data">[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
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
