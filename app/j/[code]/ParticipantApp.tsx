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
import { cameraSupported, requestMotionPermission } from "./camera-seat";
import {
  KeepAwakeVideo,
  enterFullscreen,
  fullscreenSupported,
  isFullscreen,
  requestWakeLock,
  wakeLockSupported,
} from "./device";
import {
  ParticipantClient,
  browserDeps,
  participantScreen,
  type ParticipantSnapshot,
} from "./participant-client";
import { Playback } from "./Playback";
import { SeatScanner } from "./SeatScanner";
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
  // The seat comes from the camera (SPEC 2.4): the motion permission asked
  // for in the tap that opened the scanner, and what it found.
  const [scan, setScan] = useState<Promise<boolean> | null>(null);
  const [cameraFound, setCameraFound] = useState<string | null>(null);
  const keepAwake = useKeepAwake(snapshot.readyTapped);
  const fullscreenLost = useFullscreenLost();

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

  // After Ready, any tap restores fullscreen and the keep-awake if the
  // browser dropped them (back gesture, tab switch, notification). Both
  // need a user gesture, so this cannot happen without a tap (SPEC 4.9).
  const rearm = keepAwake.request;
  useEffect(() => {
    if (!snapshot.readyTapped) return;
    const onTap = () => {
      enterFullscreen();
      rearm();
    };
    document.addEventListener("pointerup", onTap, true);
    return () => document.removeEventListener("pointerup", onTap, true);
  }, [snapshot.readyTapped, rearm]);

  const onCameraFound = useCallback(
    (seat: Point, summary: string) => {
      client.setSeat(seat);
      setCameraFound(summary);
      setScan(null);
    },
    [client],
  );
  const onCameraCancel = useCallback(() => setScan(null), []);

  const onReady = () => {
    // Fullscreen and wake lock need this tap as their user gesture, so both
    // start here, synchronously, before anything else (SPEC 2.3, 4.9).
    enterFullscreen();
    keepAwake.request();
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
      if (scan && snapshot.positioning) {
        return (
          <SeatScanner
            positioning={snapshot.positioning}
            motion={scan}
            onFound={onCameraFound}
            onCancel={onCameraCancel}
          />
        );
      }
      return (
        <SeatFinder
          snapshot={snapshot}
          cameraFound={cameraFound}
          // Motion permission must be asked inside the tap itself (iOS).
          onScan={
            cameraSupported() && snapshot.positioning
              ? () => setScan(requestMotionPermission())
              : null
          }
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
          {fullscreenLost ? (
            <p className={styles.hint}>Tap the screen to go fullscreen.</p>
          ) : null}
          {keepAwake.held ? null : (
            <p className={styles.hint}>
              Keep your screen on: tap it now and then so it doesn’t lock.
            </p>
          )}
          <button
            type="button"
            className={styles.linkButton}
            onClick={() => setEditingSeat(true)}
          >
            Find my seat again
          </button>
        </main>
      );
    case "playing":
      return (
        <Playback
          client={client}
          overMessage={
            <Message screen="over" title="Show over">
              Thanks for being part of it.
            </Message>
          }
        />
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

/**
 * Where the participant is, found with the camera (SPEC 2.4). The map only
 * shows the result; the seat comes from pointing at the big screen.
 */
function SeatFinder({
  snapshot,
  cameraFound,
  onScan,
  editing,
  onReady,
  onDone,
}: {
  snapshot: ParticipantSnapshot;
  /** What the last scan found, in words. */
  cameraFound: string | null;
  /** Opens the camera, or null where the camera can't be used. */
  onScan: (() => void) | null;
  editing: boolean;
  onReady: () => void;
  onDone: () => void;
}) {
  const seat = snapshot.seat;
  return (
    <main className={`${styles.page} ${styles.picker}`} data-screen="seat">
      <header className={styles.header}>
        <h1 className={styles.title}>
          {seat ? "Found you" : "Find your seat"}
        </h1>
        <p className={styles.text}>
          {!onScan
            ? "Finding your seat needs the camera. Open this page from the QR code on the big screen, in your phone's browser."
            : cameraFound
              ? `You're ${cameraFound}. The stage is at the top.`
              : seat
                ? "That's your spot. The stage is at the top."
                : "Point your camera at the big screen and we'll work out where you are."}
        </p>
      </header>
      <div className={styles.map}>
        {snapshot.venue ? (
          <VenueView
            venue={snapshot.venue}
            seat={seat}
            label={seat ? "Seating map with your spot" : "Seating map"}
          />
        ) : null}
      </div>
      <footer className={styles.footer}>
        <ReconnectNote snapshot={snapshot} />
        {onScan && seat ? (
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={onScan}
          >
            Scan again
          </button>
        ) : null}
        {!seat ? (
          <button
            type="button"
            className={styles.button}
            disabled={!onScan}
            onClick={onScan ?? undefined}
          >
            Find my seat
          </button>
        ) : editing ? (
          <button type="button" className={styles.button} onClick={onDone}>
            Done
          </button>
        ) : (
          <button type="button" className={styles.button} onClick={onReady}>
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
 * Keep the screen on once Ready was tapped (SPEC 4.9). Uses the Screen Wake
 * Lock API and falls back to a looping silent video where the API is missing
 * or refused, e.g. over plain HTTP. The browser drops both when the tab is
 * hidden, so take them again on return to visible and on every tap.
 * `held` is false only once both have failed.
 */
function useKeepAwake(active: boolean): { held: boolean; request: () => void } {
  const sentinel = useRef<WakeLockSentinel | null>(null);
  const pending = useRef(false);
  const [status, setStatus] = useState<"trying" | "lock" | "video" | "none">(
    "trying",
  );
  const [video] = useState(
    () =>
      new KeepAwakeVideo((playing) => {
        if (playing) setStatus("video");
        // Pausing it after the lock was taken is not a failure.
        else setStatus((s) => (s === "lock" ? s : "none"));
      }),
  );

  const request = useCallback(() => {
    if (pending.current || (sentinel.current && !sentinel.current.released)) {
      return;
    }
    if (!wakeLockSupported()) {
      video.play();
      return;
    }
    pending.current = true;
    void requestWakeLock().then((lock) => {
      pending.current = false;
      sentinel.current = lock;
      if (!lock) {
        video.play();
        return;
      }
      setStatus("lock");
      if (video.playing) video.dispose();
      lock.addEventListener("release", () => {
        if (sentinel.current !== lock) return;
        sentinel.current = null;
        // Released while still visible (e.g. battery saver): cover with the
        // video until the next tap retries the lock.
        if (document.visibilityState !== "visible") return;
        setStatus("trying");
        video.play();
      });
    });
  }, [video]);

  useEffect(() => {
    if (!active) return;
    // After a reload in standby there is no tap; try anyway (Chrome allows
    // the lock, and muted video may autoplay). The next tap retries.
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
      video.dispose();
    },
    [video],
  );

  return { held: status !== "none", request };
}

function subscribeFullscreen(onChange: () => void): () => void {
  document.addEventListener("fullscreenchange", onChange);
  return () => document.removeEventListener("fullscreenchange", onChange);
}

/** True when this browser has fullscreen but the page is not in it. */
function useFullscreenLost(): boolean {
  return useSyncExternalStore(
    subscribeFullscreen,
    () => fullscreenSupported() && !isFullscreen(),
    () => false,
  );
}
