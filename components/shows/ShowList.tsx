"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  deleteShow,
  listShows,
  type ShowListItem,
} from "@/components/editor/api";
import { BUILTIN_SHOWS } from "@/lib/builtin-shows";
import { showDurationMs } from "@/lib/compile";
import { clockText } from "@/lib/host-map";
import { CreateShowButton } from "./CreateShowButton";
import { useHostShow } from "./host-show";
import styles from "./ShowList.module.css";

type Load =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; shows: ShowListItem[] };

const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function updatedText(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dateFormat.format(date);
}

/**
 * The show list on `/` (SPEC 2.2): saved shows with Open, Host and Delete,
 * plus the built-in shows, which can only be hosted. Host runs the last
 * saved version of a show: the session keeps a snapshot taken at that
 * moment, so unsaved editor changes and later edits do not reach it.
 */
export function ShowList() {
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const { host, hosting, error: hostError } = useHostShow();

  const refresh = useCallback(async () => {
    try {
      setLoad({ kind: "ready", shows: await listShows() });
    } catch (err) {
      setLoad({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  useEffect(() => {
    // Fetching on mount; setState happens after the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const onDelete = async (show: ShowListItem) => {
    if (!window.confirm(`Delete "${show.name}"? This cannot be undone.`)) {
      return;
    }
    setDeleting(show.id);
    setDeleteError(null);
    try {
      await deleteShow(show.id);
      setLoad((prev) =>
        prev.kind === "ready"
          ? { kind: "ready", shows: prev.shows.filter((s) => s.id !== show.id) }
          : prev,
      );
    } catch (err) {
      setDeleteError(
        `Could not delete "${show.name}": ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setDeleting(null);
    }
  };

  const busy = hosting !== null;

  return (
    <div className={styles.list}>
      <div className={styles.header}>
        <h2 className={styles.heading}>Shows</h2>
        <CreateShowButton
          className={styles.create}
          errorClassName={styles.error}
        />
      </div>
      <p className={styles.note}>
        Host plays the last saved version. Save in the editor first; edits made
        after hosting do not reach a running session.
      </p>

      {hostError ? (
        <p role="alert" className={styles.error}>
          Could not host: {hostError}
        </p>
      ) : null}
      {deleteError ? (
        <p role="alert" className={styles.error}>
          {deleteError}
        </p>
      ) : null}

      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Duration</th>
            <th scope="col">Updated</th>
            <th scope="col">
              <span className={styles.srOnly}>Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {load.kind === "loading" ? (
            <tr>
              <td colSpan={4} className={styles.muted}>
                Loading shows…
              </td>
            </tr>
          ) : load.kind === "error" ? (
            <tr>
              <td colSpan={4} className={styles.error}>
                Could not load shows: {load.message}{" "}
                <button
                  type="button"
                  className={styles.action}
                  onClick={() => void refresh()}
                >
                  Retry
                </button>
              </td>
            </tr>
          ) : load.shows.length === 0 ? (
            <tr>
              <td colSpan={4} className={styles.muted}>
                No saved shows yet. Create one to start.
              </td>
            </tr>
          ) : (
            load.shows.map((show) => (
              <tr key={show.id} data-show-id={show.id}>
                <td className={styles.name}>
                  {show.name}
                  {show.hasAudio ? null : (
                    <span className={styles.tag}>no audio</span>
                  )}
                </td>
                <td className={styles.num}>{clockText(show.durationMs)}</td>
                <td className={styles.muted}>{updatedText(show.updatedAt)}</td>
                <td className={styles.actions}>
                  <Link
                    className={styles.action}
                    href={`/shows/${encodeURIComponent(show.id)}/edit`}
                  >
                    Open
                  </Link>
                  <button
                    type="button"
                    className={`${styles.action} ${styles.host}`}
                    disabled={busy}
                    onClick={() => void host(show.id)}
                  >
                    {hosting === show.id ? "Hosting…" : "Host"}
                  </button>
                  <button
                    type="button"
                    className={`${styles.action} ${styles.danger}`}
                    disabled={deleting === show.id}
                    onClick={() => void onDelete(show)}
                  >
                    {deleting === show.id ? "Deleting…" : "Delete"}
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>

      <h3 className={styles.subheading}>Built-in test shows</h3>
      <table className={styles.table}>
        <tbody>
          {BUILTIN_SHOWS.map((show) => (
            <tr key={show.id} data-show-id={show.id}>
              <td className={styles.name}>
                {show.name}
                <span className={styles.tag}>read-only</span>
              </td>
              <td className={styles.num}>{clockText(showDurationMs(show))}</td>
              <td className={styles.muted}>No audio, for sync testing</td>
              <td className={styles.actions}>
                <button
                  type="button"
                  className={`${styles.action} ${styles.host}`}
                  disabled={busy}
                  onClick={() => void host(show.id)}
                >
                  {hosting === show.id ? "Hosting…" : "Host"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
