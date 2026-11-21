"use client";

import { Inter, Space_Grotesk } from "next/font/google";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  HostClient,
  browserHostDeps,
  createHostedSession,
  readHostToken,
  type HostSnapshot,
} from "@/app/sessions/host-client";
import { listShows } from "@/components/editor/api";
import { ClipInspector } from "@/components/editor/ClipInspector";
import type { Size } from "@/components/editor/geometry";
import {
  handleEditorKey,
  isTypingTarget,
  timelineKeys,
} from "@/components/editor/keyboard";
import { saveEditorShow } from "@/components/editor/save";
import {
  createEditorStore,
  initialEditorState,
  isDirty,
  type EditorStore,
} from "@/components/editor/store";
import {
  EditorStoreProvider,
  useEditorStore,
} from "@/components/editor/store-context";
import { Timeline } from "@/components/editor/Timeline";
import { VENUE_TOOLS, toolHandlers } from "@/components/editor/tools";
import {
  AudioUpload,
  PlayButton,
  SnapControls,
  TimeReadout,
  ZoomControl,
} from "@/components/editor/Transport";
import { VenueCanvas } from "@/components/editor/VenueCanvas";
import { clickTimesForShow } from "@/lib/audio-schedule";
import {
  BUILTIN_SHOWS,
  builtinShow,
  clickTrackByDefault,
} from "@/lib/builtin-shows";
import { showDurationMs } from "@/lib/compile";
import { countByState } from "@/lib/host-map";
import type { SessionMessage } from "@/lib/protocol";
import { CrowdCanvas } from "./CrowdCanvas";
import { CrowdCard } from "./CrowdCard";
import { ROOM_LAYERS } from "./room-layers";
import { Settings } from "./Settings";
import { ShowPicker } from "./ShowPicker";
import { ToolRail } from "./ToolRail";
import { useHostAudio, type HostAudioControls } from "./use-host-audio";
import styles from "./room.module.css";

const body = Inter({ subsets: ["latin"], weight: ["300", "400", "500"] });
const wordmark = Space_Grotesk({ subsets: ["latin"], weight: "700" });

/** localStorage key holding this laptop's room code. */
const ROOM_KEY = "lightshow-room";
/** Edits wait this long before they are saved and sent to the phones. */
const AUTOSAVE_MS = 800;
/** A failed save is retried after this long. */
const RETRY_MS = 3_000;

/**
 * The laptop screen (SPEC 2.5): one room that phones join once, with the
 * editor and the live view merged. The room keeps its code across reloads
 * and server restarts (its host token is in localStorage), so the host can
 * swap shows and edit while phones stay connected.
 */
export function RoomApp() {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(async (fresh: boolean) => {
    setError(null);
    const deps = browserHostDeps();
    const stored = fresh ? null : readRoomCode();
    if (stored && readHostToken(deps.storage, stored)) {
      setCode(stored);
      return;
    }
    setCode(null);
    try {
      const shows = await listShows().catch(() => []);
      const showId = shows[0]?.id ?? BUILTIN_SHOWS[0]!.show.id;
      const created = await createHostedSession(showId, deps);
      writeRoomCode(created);
      setCode(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    // Opening the room on mount; state is set after the awaits.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void open(false);
  }, [open]);

  if (code) {
    return <Room key={code} code={code} onLost={() => void open(true)} />;
  }
  return (
    <main className={`${styles.room} ${body.className}`}>
      <div className={styles.message}>
        <span className={`${styles.mark} ${wordmark.className}`}>
          lightshow
        </span>
        {error ? (
          <>
            <p role="alert">Could not open a room: {error}</p>
            <button
              type="button"
              className={styles.primary}
              onClick={() => void open(false)}
            >
              Try again
            </button>
          </>
        ) : (
          <p>Opening your room…</p>
        )}
      </div>
    </main>
  );
}

function readRoomCode(): string | null {
  try {
    return window.localStorage.getItem(ROOM_KEY);
  } catch {
    return null;
  }
}

function writeRoomCode(code: string): void {
  try {
    window.localStorage.setItem(ROOM_KEY, code);
  } catch {
    // Storage blocked: the next visit opens a new room.
  }
}

/** Everything the studio needs from the room connection. */
type RoomProps = {
  client: HostClient;
  snapshot: HostSnapshot;
  session: SessionMessage;
  audio: HostAudioControls;
  clickOn: boolean;
  setClickOn: (on: boolean) => void;
  onNewRoom: () => void;
};

function Room({ code, onLost }: { code: string; onLost: () => void }) {
  const [client] = useState(() => new HostClient(code, browserHostDeps));
  const snapshot = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot,
  );

  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);

  // A tab back from hidden resyncs its clock (SPEC 4.3, 4.9).
  useEffect(() => {
    const onVisibility = () =>
      client.setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [client]);

  // This laptop lost the room (token gone, or the room no longer exists):
  // open a fresh one.
  const { fatal, session, T0, clockReady } = snapshot;
  useEffect(() => {
    if (fatal) onLost();
  }, [fatal, onLost]);

  const show = session?.show ?? null;
  // Click track: null until the host toggles it, then their choice.
  const [clickChoice, setClickChoice] = useState<boolean | null>(null);
  const clickOn = clickChoice ?? clickTrackByDefault(session?.showId ?? "");
  const clickTimesMs = useMemo(
    () => (clickOn && show ? clickTimesForShow(show) : null),
    [clickOn, show],
  );
  const audio = useHostAudio(client, show, T0, clockReady, clickTimesMs);

  if (!session) {
    return (
      <main className={`${styles.room} ${body.className}`}>
        <div className={styles.message}>
          <span className={`${styles.mark} ${wordmark.className}`}>
            lightshow
          </span>
          <p>Connecting…</p>
        </div>
      </main>
    );
  }
  return (
    <ShowStudio
      key={session.showId}
      client={client}
      snapshot={snapshot}
      session={session}
      audio={audio}
      clickOn={clickOn}
      setClickOn={setClickChoice}
      onNewRoom={onLost}
    />
  );
}

/** One editor store per loaded show. */
function ShowStudio(props: RoomProps) {
  const [store] = useState(() => {
    const state = initialEditorState(props.session.show);
    return createEditorStore({ ...state, tool: "shape" });
  });
  return (
    <EditorStoreProvider store={store}>
      <Studio {...props} />
    </EditorStoreProvider>
  );
}

function Studio({
  client,
  snapshot,
  session,
  audio,
  clickOn,
  setClickOn,
  onNewRoom,
}: RoomProps) {
  const store = useEditorStore();
  const readOnly = builtinShow(session.showId) !== undefined;
  const { participants, T0, clockReady, connection } = snapshot;
  const playing = T0 !== null;
  const liveShow = playing && clockReady ? session.show : null;
  const locked = playing || readOnly;
  const sync = useShowSync(store, client, session, readOnly, playing);
  const counts = useMemo(() => countByState(participants), [participants]);
  const canvasSize = useRef<Size>({ width: 0, height: 0 });

  usePlayheadFollowsShow(store, client, liveShow, T0);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void sync.flush();
        return;
      }
      if (isTypingTarget(e.target) || playing) return;
      const key = e.key.toLowerCase();
      // The room has no venue to draw: skip the venue tool shortcuts.
      if (VENUE_TOOLS.some((id) => toolHandlers[id].shortcut === key)) return;
      const handled = readOnly
        ? timelineKeys(store)(e)
        : handleEditorKey(e, store, canvasSize.current, [timelineKeys(store)]);
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store, sync, playing, readOnly]);

  const screenHref = `/sessions/${session.code}/screen?join=${encodeURIComponent(session.joinUrl)}`;
  const inRoom = counts.total - counts.disconnected;

  return (
    <main
      className={`${styles.room} ${body.className}`}
      data-playing={playing || undefined}
    >
      <header className={styles.bar}>
        <div className={styles.left}>
          <span className={`${styles.mark} ${wordmark.className}`}>
            lightshow
          </span>
          <ShowPicker
            currentId={session.showId}
            readOnly={readOnly}
            disabled={playing || connection !== "open"}
            beforeSwitch={sync.flush}
            onLoad={(id) => client.loadShow(id)}
          />
        </div>
        <div className={styles.actions}>
          <span className={styles.pill} data-testid="room-count">
            <i aria-hidden />
            {inRoom} {inRoom === 1 ? "phone" : "phones"}
            <span>in the room</span>
          </span>
          <a
            className={styles.ghost}
            href={screenHref}
            target="_blank"
            rel="noreferrer"
          >
            Open big screen
          </a>
          <Settings
            client={client}
            session={session}
            audio={audio}
            clickOn={clickOn}
            setClickOn={setClickOn}
            onNewRoom={onNewRoom}
          />
        </div>
      </header>

      <div className={styles.studio}>
        <ToolRail disabled={locked} />
        <section className={styles.stage} aria-label="Room">
          <VenueCanvas
            layers={ROOM_LAYERS}
            className={styles.roomFrame}
            onResize={(size) => {
              canvasSize.current = size;
            }}
          >
            <CrowdCanvas
              client={client}
              participants={participants}
              liveShow={liveShow}
              T0={T0}
            />
            <div className={styles.screenBar} aria-hidden />
            <p className={styles.screenTag}>Screen</p>
            {locked ? <div className={styles.lock} /> : null}
          </VenueCanvas>
        </section>
        <aside className={styles.side}>
          <CrowdCard
            client={client}
            snapshot={snapshot}
            counts={counts}
            show={session.show}
            ready={sync.state === "synced" || sync.state === "error"}
            onStart={() => {
              // The click is the gesture that lets the AudioContext run.
              void audio.audio.unlock();
              client.startShow();
            }}
          />
          {playing ? (
            <p className={styles.note}>
              Edits are paused while the show plays. Stop it to keep editing.
            </p>
          ) : readOnly ? (
            <p className={styles.note}>
              This is a built-in test show, so it can’t be edited. Pick New show
              to make your own.
            </p>
          ) : (
            <ClipInspector />
          )}
        </aside>
        <section
          className={styles.timeline}
          data-locked={locked || undefined}
          aria-label="Timeline"
        >
          <div className={styles.transport}>
            {playing ? null : <PlayButton />}
            <TimeReadout />
            <ZoomControl />
            {readOnly ? null : <SnapControls />}
            <span className={styles.spacer} />
            <SyncStatus
              state={sync.state}
              error={sync.error}
              readOnly={readOnly}
            />
            {locked ? null : <AudioUpload />}
          </div>
          <Timeline />
        </section>
      </div>
    </main>
  );
}

type SyncState = "synced" | "saving" | "updating" | "queued" | "error";

const SYNC_TEXT: Record<Exclude<SyncState, "error">, string> = {
  synced: "Saved · phones up to date",
  saving: "Saving…",
  updating: "Updating phones…",
  queued: "Saved · phones update after the show",
};

function SyncStatus({
  state,
  error,
  readOnly,
}: {
  state: SyncState;
  error: string | null;
  readOnly: boolean;
}) {
  if (readOnly) return <span className={styles.status}>Test show</span>;
  return (
    <span
      className={styles.status}
      data-error={state === "error" || undefined}
      role="status"
    >
      {state === "error"
        ? `Couldn’t save: ${error ?? "unknown error"}`
        : SYNC_TEXT[state]}
    </span>
  );
}

/**
 * Autosave: edits are saved `AUTOSAVE_MS` after they stop, then loaded into
 * the room so every phone recompiles (SPEC 2.5). While a show plays the room
 * refuses loads, so the reload waits for Stop. `flush` saves now, for
 * switching shows and Cmd+S.
 */
function useShowSync(
  store: EditorStore,
  client: HostClient,
  session: SessionMessage,
  readOnly: boolean,
  playing: boolean,
): { state: SyncState; error: string | null; flush: () => Promise<void> } {
  const [state, setState] = useState<SyncState>("synced");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const playingRef = useRef(playing);
  const queued = useRef(false);
  const showId = session.showId;
  // `flush` re-arms itself through this, as a callback can't name itself.
  const flushRef = useRef<() => Promise<void>>(async () => {});
  const schedule = useCallback((ms: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flushRef.current(), ms);
  }, []);

  const load = useCallback(() => {
    if (playingRef.current || !client.loadShow(showId)) {
      queued.current = true;
      setState("queued");
      return;
    }
    queued.current = false;
    setState("updating");
  }, [client, showId]);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (readOnly || !isDirty(store.getState())) return;
    setState("saving");
    await saveEditorShow(store);
    const after = store.getState();
    if (after.saveStatus === "error") {
      setError(after.saveError);
      setState("error");
      schedule(RETRY_MS);
      return;
    }
    setError(null);
    if (isDirty(after)) {
      // Edited while saving: go round again.
      schedule(AUTOSAVE_MS);
    }
    load();
  }, [store, readOnly, load, schedule]);

  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  // Save a moment after the show changes.
  useEffect(() => {
    let revision = store.getState().revision;
    const unsubscribe = store.subscribe(() => {
      const next = store.getState().revision;
      if (next === revision || readOnly) return;
      revision = next;
      setState("saving");
      schedule(AUTOSAVE_MS);
    });
    return () => {
      unsubscribe();
      window.clearTimeout(timer.current);
    };
  }, [store, readOnly, schedule]);

  // A reload held back by a running show goes out on Stop.
  useEffect(() => {
    playingRef.current = playing;
    if (!playing && queued.current) load();
  }, [playing, load]);

  // The room answers a load with a new session message.
  useEffect(() => {
    // Clearing "updating" when the room's answer arrives.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((s) => (s === "updating" ? "synced" : s));
  }, [session]);

  // Warn before closing the tab with an edit not yet saved.
  useEffect(() => {
    if (state !== "saving") return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [state]);

  return { state, error, flush };
}

/** While the show plays, the editor's playhead follows it on every frame. */
function usePlayheadFollowsShow(
  store: EditorStore,
  client: HostClient,
  liveShow: SessionMessage["show"] | null,
  T0: number | null,
) {
  useEffect(() => {
    if (!liveShow || T0 === null) return;
    store.dispatch({ type: "setPlaying", playing: false });
    const durationMs = showDurationMs(liveShow);
    let raf = 0;
    const follow = () => {
      raf = requestAnimationFrame(follow);
      const showMs = client.clock.serverNow() - T0;
      const timeMs = Math.min(Math.max(0, showMs), durationMs);
      store.dispatch({ type: "seek", timeMs });
    };
    raf = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(raf);
  }, [store, client, liveShow, T0]);
}
