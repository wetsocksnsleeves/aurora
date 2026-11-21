"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { coverUrl, listRecentMusic } from "@/components/editor/api";
import { formatTime } from "@/components/editor/snap";
import {
  useEditorSelector,
  useEditorStore,
} from "@/components/editor/store-context";
import { BUILTIN_TRACKS } from "@/lib/builtin-tracks";
import type { Show } from "@/lib/types";
import type { Toast } from "./edit-actions";
import { pickMusic } from "./music";
import styles from "./room.module.css";

type Track = Show["audio"];

/** The built-in tracks as show audio (without their file paths). */
const BUILTIN: readonly Track[] = BUILTIN_TRACKS.map(
  ({ fileId, durationMs, title, artist }) => ({
    fileId,
    durationMs,
    ...(title ? { title } : {}),
    ...(artist ? { artist } : {}),
  }),
);

const OpenContext = createContext<() => void>(() => {});

/**
 * Opens the music chooser: upload a file, or pick a track used before. Must
 * be called from a click, since uploading opens the file picker.
 */
export function useMusicChooser(): () => void {
  return useContext(OpenContext);
}

/**
 * Holds the chooser and the recently used tracks for everything inside it.
 * With nothing used before, opening it goes straight to the file picker.
 */
export function MusicChooserProvider({
  toast,
  children,
}: {
  toast: Toast;
  children: ReactNode;
}) {
  const store = useEditorStore();
  const [open, setOpen] = useState(false);
  // null until the first answer arrives.
  const [recent, setRecent] = useState<Track[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRecent(await listRecentMusic());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    // Fetch once up front, so the first click knows whether there's a list.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const openChooser = useCallback(() => {
    const current = store.getState().show.audio.fileId;
    const others = recent?.concat(BUILTIN).filter((t) => t.fileId !== current);
    if (others && others.length === 0) {
      // Nothing to choose from: skip the dialog. Still inside the click, so
      // the browser lets the file picker open.
      pickMusic(store, toast);
      return;
    }
    setOpen(true);
    void refresh();
  }, [store, toast, recent, refresh]);

  const choose = useCallback(
    (track: Track) => {
      store.dispatch({ type: "setShowAudio", audio: track });
      toast(`Using “${track.title ?? "Untitled track"}”`);
      setOpen(false);
    },
    [store, toast],
  );

  return (
    <OpenContext.Provider value={openChooser}>
      {children}
      {open ? (
        <ChooserDialog
          recent={recent}
          error={error}
          onUpload={() => {
            setOpen(false);
            pickMusic(store, toast);
          }}
          onChoose={choose}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </OpenContext.Provider>
  );
}

function ChooserDialog({
  recent,
  error,
  onUpload,
  onChoose,
  onClose,
}: {
  recent: Track[] | null;
  error: string | null;
  onUpload: () => void;
  onChoose: (track: Track) => void;
  onClose: () => void;
}) {
  const current = useEditorSelector((s) => s.show.audio.fileId);
  const uploadRef = useRef<HTMLButtonElement>(null);
  // Built-in tracks not already listed as recently used, by file or as an
  // uploaded copy of the same song.
  const builtin = BUILTIN.filter(
    (b) =>
      !recent?.some(
        (t) =>
          t.fileId === b.fileId ||
          (t.title === b.title && t.artist === b.artist),
      ),
  );

  useEffect(() => {
    uploadRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <>
      <div className={styles.dialogBackdrop} onClick={onClose} />
      <div
        className={styles.musicDialog}
        role="dialog"
        aria-modal="true"
        aria-label="Choose music"
      >
        <div className={styles.musicHead}>
          <b>Music</b>
          <button
            type="button"
            className={styles.musicClose}
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <button
          ref={uploadRef}
          type="button"
          className={styles.musicUpload}
          onClick={onUpload}
        >
          <b>Upload a file</b>
          <span>mp3, wav or m4a</span>
        </button>
        <p className={styles.label}>Recently used</p>
        {recent === null && !error ? (
          <p className={styles.note}>Loading…</p>
        ) : null}
        {error ? <p className={styles.error}>{error}</p> : null}
        {recent?.length === 0 ? (
          <p className={styles.note}>Music you add to a show appears here.</p>
        ) : null}
        {recent?.length ? (
          <TrackList tracks={recent} current={current} onChoose={onChoose} />
        ) : null}
        {builtin.length ? (
          <>
            <p className={styles.label}>Built in</p>
            <TrackList tracks={builtin} current={current} onChoose={onChoose} />
          </>
        ) : null}
      </div>
    </>
  );
}

function TrackList({
  tracks,
  current,
  onChoose,
}: {
  tracks: readonly Track[];
  current: string;
  onChoose: (track: Track) => void;
}) {
  return (
    <ul className={styles.musicList}>
      {tracks.map((track) => {
        const isCurrent = track.fileId === current;
        return (
          <li key={track.fileId}>
            <button
              type="button"
              disabled={isCurrent}
              aria-current={isCurrent || undefined}
              onClick={() => onChoose(track)}
            >
              <TrackCover fileId={track.fileId} size={40} />
              <span className={styles.trackText}>
                <b>{track.title ?? "Untitled track"}</b>
                {track.artist ? <span>{track.artist}</span> : null}
              </span>
              <span className={styles.musicMeta}>
                {isCurrent
                  ? "In this show"
                  : track.durationMs > 0
                    ? formatTime(track.durationMs).replace(/\.\d+$/, "")
                    : ""}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The track's embedded cover art, or a music note when it has none. */
export function TrackCover({ fileId, size }: { fileId: string; size: number }) {
  // Remember failures per file, so a new track gets a fresh try.
  const [failed, setFailed] = useState<string | null>(null);
  const style = useMemo(() => ({ width: size, height: size }), [size]);
  return (
    <span className={styles.trackCover} style={style} aria-hidden="true">
      {failed === fileId ? (
        <svg
          viewBox="0 0 24 24"
          width={size / 2}
          height={size / 2}
          fill="currentColor"
        >
          <path d="M9 18.5a2.5 2.5 0 1 1-2.5-2.5c.17 0 .34.02.5.05V5.5l12-2.5v12.5a2.5 2.5 0 1 1-2.5-2.5c.17 0 .34.02.5.05V7.1L9 8.8z" />
        </svg>
      ) : (
        // A same-origin API image whose size is fixed by CSS; next/image
        // would add nothing here.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={coverUrl(fileId)} alt="" onError={() => setFailed(fileId)} />
      )}
    </span>
  );
}
