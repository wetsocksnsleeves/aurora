"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { VenueView } from "@/components/venue/VenueView";
import type { Point } from "@/lib/types";
import { pickSeat } from "@/lib/venue-geometry";
import { enterFullscreen, requestWakeLock, wakeLockSupported } from "./device";
import {
  ParticipantClient,
  browserDeps,
  participantScreen,
  type ParticipantSnapshot,
} from "./participant-client";
import styles from "./participant.module.css";

/**
 * The participant page (SPEC 2.3): one client component, no UI libraries.
 * All socket work is in `ParticipantClient`; this only renders its snapshot.
 */
export function ParticipantApp({ code }: { code: string }) {
  const [client] = useState(() => new ParticipantClient(code, browserDeps));
  const snapshot = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot,
  );
  const [editingSeat, setEditingSeat] = useState(false);
  const [missedTap, setMissedTap] = useState(false);
  const wakeLock = useWakeLock(snapshot.readyTapped);

  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);

  const onTap = useCallback(
    (point: Point) => {
      const venue = client.getSnapshot().venue;
      if (!venue) return;
      const seat = pickSeat(venue, point);
      setMissedTap(seat === null);
      if (seat) client.setSeat(seat);
    },
    [client],
  );

  const onReady = () => {
    // Fullscreen and wake lock need this tap as their user gesture, so both
    // start here, synchronously, before anything else (SPEC 2.3, 4.9).
    enterFullscreen();
    wakeLock.request();
    client.ready();
  };

  let screen = participantScreen(snapshot);
  if (editingSeat && (screen === "syncing" || screen === "standby")) {
    screen = "seat";
  }

  switch (screen) {
    case "connecting":
      return (
        <Message screen={screen} title="Connecting…">
          Joining show {code}
        </Message>
      );
    case "not-found":
      return (
        <Message screen={screen} title="Show not found">
          No show is running with code {code}. Check the code on the big screen
          and scan again.
        </Message>
      );
    case "replaced":
      return (
        <Message screen={screen} title="Open in another tab">
          This show is open in another tab. Use that one, or reload this page to
          move here.
        </Message>
      );
    case "seat":
      return (
        <SeatPicker
          snapshot={snapshot}
          onTap={onTap}
          missedTap={missedTap}
          editing={snapshot.readyTapped}
          onReady={onReady}
          onDone={() => setEditingSeat(false)}
        />
      );
    case "syncing":
      return (
        <main
          className={`${styles.page} ${styles.syncing}`}
          data-screen="syncing"
        >
          <div className={styles.spinner} aria-hidden />
          <h1 className={styles.title}>Getting in sync…</h1>
          <p className={styles.text}>Keep this page open.</p>
          <ReconnectNote snapshot={snapshot} />
        </main>
      );
    case "standby":
      return (
        <main
          className={`${styles.page} ${styles.standby}`}
          data-screen="standby"
        >
          <h1 className={styles.bigTitle}>You’re in</h1>
          <p className={styles.text}>
            Turn your screen brightness all the way up and keep this page open.
            The show starts on its own.
          </p>
          {wakeLock.held ? null : (
            <p className={styles.hint}>
              Keep your screen on: tap it now and then so it doesn’t lock.
            </p>
          )}
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => setEditingSeat(true)}
          >
            Change seat
          </button>
        </main>
      );
    case "playing":
      // Chunk 5 paints the schedule colours here.
      return (
        <main
          className={`${styles.page} ${styles.playing}`}
          data-screen="playing"
        />
      );
    case "over":
      return (
        <Message screen={screen} title="Show over">
          Thanks for being part of it.
        </Message>
      );
  }
}

function Message({
  screen,
  title,
  children,
}: {
  screen: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <main className={styles.page} data-screen={screen}>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.text}>{children}</p>
    </main>
  );
}

function SeatPicker({
  snapshot,
  onTap,
  missedTap,
  editing,
  onReady,
  onDone,
}: {
  snapshot: ParticipantSnapshot;
  onTap: (point: Point) => void;
  missedTap: boolean;
  editing: boolean;
  onReady: () => void;
  onDone: () => void;
}) {
  return (
    <main className={`${styles.page} ${styles.picker}`} data-screen="seat">
      <header className={styles.header}>
        <h1 className={styles.title}>Where are you sitting?</h1>
        <p className={styles.text}>
          {missedTap
            ? "Tap inside the seating area."
            : snapshot.seat
              ? "Tap again to move your spot."
              : "Tap your spot on the map. The stage is at the top."}
        </p>
      </header>
      <div className={styles.map}>
        {snapshot.venue ? (
          <VenueView
            venue={snapshot.venue}
            seat={snapshot.seat}
            onTap={onTap}
            label="Seating map. Tap where you are sitting."
          />
        ) : null}
      </div>
      <footer className={styles.footer}>
        <ReconnectNote snapshot={snapshot} />
        {editing ? (
          <button type="button" className={styles.button} onClick={onDone}>
            Done
          </button>
        ) : (
          <button
            type="button"
            className={styles.button}
            disabled={!snapshot.seat}
            onClick={onReady}
          >
            Ready
          </button>
        )}
      </footer>
    </main>
  );
}

function ReconnectNote({ snapshot }: { snapshot: ParticipantSnapshot }) {
  if (snapshot.connection !== "reconnecting") return null;
  return <p className={styles.hint}>Reconnecting…</p>;
}

/**
 * Hold a screen wake lock once Ready was tapped. The browser drops it when
 * the tab is hidden, so take it again on return to visible (SPEC 4.9).
 */
function useWakeLock(active: boolean): { held: boolean; request: () => void } {
  const sentinel = useRef<WakeLockSentinel | null>(null);
  const pending = useRef(false);
  const [held, setHeld] = useState(true);

  const request = useCallback(() => {
    if (pending.current || (sentinel.current && !sentinel.current.released)) {
      return;
    }
    if (!wakeLockSupported()) return;
    pending.current = true;
    void requestWakeLock().then((lock) => {
      pending.current = false;
      sentinel.current = lock;
      setHeld(lock !== null);
      lock?.addEventListener("release", () => {
        if (sentinel.current === lock) sentinel.current = null;
      });
    });
  }, []);

  useEffect(() => {
    if (!active) return;
    // After a reload in standby there is no tap; try anyway (Chrome allows
    // it without a gesture). If refused, the page shows a hint.
    request();
    const onVisible = () => {
      if (document.visibilityState === "visible") request();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [active, request]);

  useEffect(
    () => () => {
      void sentinel.current?.release().catch(() => {});
      sentinel.current = null;
    },
    [],
  );

  return { held: held && wakeLockSupported(), request };
}
