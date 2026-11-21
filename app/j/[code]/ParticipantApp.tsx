"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { Point, PositioningConfig } from "@/lib/types";
import { cameraSupported, requestMotionPermission } from "./camera-seat";
import { enterFullscreen, requestWakeLock, wakeLockSupported } from "./device";
import {
  ParticipantClient,
  browserDeps,
  participantScreen,
  type ParticipantSnapshot,
} from "./participant-client";
import { Playback } from "./Playback";
import { SeatScanner } from "./SeatScanner";
import styles from "./participant.module.css";
import { Label, LedLoader, RoomView, Shell, Stat } from "./visuals";

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
  // How the last scan knew the camera's field of view, for the result screen.
  const [lensNote, setLensNote] = useState<string | null>(null);
  const wakeLock = useWakeLock(snapshot.readyTapped);

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

  const onCameraFound = useCallback(
    (seat: Point, lens: string) => {
      client.setSeat(seat);
      setLensNote(lens);
      setScan(null);
    },
    [client],
  );
  const onCameraCancel = useCallback(() => setScan(null), []);

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
        <Shell screen={screen}>
          <LedLoader />
          <Label>Connecting</Label>
        </Shell>
      );
    case "not-found":
      return (
        <Message screen={screen} title="Show not found">
          This show isn’t running any more. Scan the code on the big screen
          again.
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
          lensNote={lensNote}
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
        <Shell screen="syncing">
          <LedLoader />
          <h1 className={styles.title}>Getting in sync</h1>
          <Label>Keep this page open</Label>
          <ReconnectNote snapshot={snapshot} />
        </Shell>
      );
    case "standby":
      return (
        <Shell
          screen="standby"
          tone="ready"
          actions={
            <button
              type="button"
              className={styles.secondary}
              onClick={() => setEditingSeat(true)}
            >
              Find my seat again
            </button>
          }
        >
          <div className={styles.readyMark} aria-hidden>
            {Array.from({ length: 9 }, (_, i) => (
              <i key={i} />
            ))}
          </div>
          <h1 className={styles.hero}>You’re in</h1>
          <ol className={styles.steps}>
            <li>Turn your brightness all the way up</li>
            <li>Hold your phone up</li>
            <li>Enjoy the show</li>
          </ol>
        </Shell>
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
    <Shell screen={screen}>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.text}>{children}</p>
    </Shell>
  );
}

/** Metres from the screen for a venue point (the inverse of the camera's mapping). */
function metres(seat: Point, config: PositioningConfig) {
  return {
    back: seat.y * config.venueDepthM,
    across: (seat.x - 0.5) * config.venueWidthM,
  };
}

/**
 * Finding the participant's spot with the camera (SPEC 2.4). Before a scan:
 * what to point at. After: where they are, in the room and in metres.
 */
function SeatFinder({
  snapshot,
  lensNote,
  onScan,
  editing,
  onReady,
  onDone,
}: {
  snapshot: ParticipantSnapshot;
  /** How the last scan knew the camera's field of view. */
  lensNote: string | null;
  /** Opens the camera, or null where the camera can't be used. */
  onScan: (() => void) | null;
  editing: boolean;
  onReady: () => void;
  onDone: () => void;
}) {
  const { seat, positioning } = snapshot;

  if (!seat || !positioning) {
    return (
      <Shell
        screen="seat"
        actions={
          <button
            type="button"
            className={styles.primary}
            disabled={!onScan}
            onClick={onScan ?? undefined}
          >
            Find my seat
          </button>
        }
      >
        <h1 className={styles.title}>Find your seat</h1>
        <p className={styles.text}>
          {onScan
            ? "Point your camera at the big screen."
            : "Finding your seat needs the camera. Open this page from the QR code on the big screen, in your phone’s browser."}
        </p>
        <ReconnectNote snapshot={snapshot} />
      </Shell>
    );
  }

  const { back, across } = metres(seat, positioning);
  return (
    <Shell
      screen="seat"
      actions={
        <>
          {onScan ? (
            <button type="button" className={styles.secondary} onClick={onScan}>
              Scan again
            </button>
          ) : null}
          {editing ? (
            <button type="button" className={styles.primary} onClick={onDone}>
              Done
            </button>
          ) : (
            <button type="button" className={styles.primary} onClick={onReady}>
              Ready
            </button>
          )}
        </>
      }
    >
      <h1 className={styles.title}>Found you</h1>
      <RoomView
        back={back}
        across={across}
        // The target spans about 65% of the screen's width.
        screenWidthM={positioning.targetWidthM / 0.65}
      />
      <div className={styles.stats}>
        <Stat value={back.toFixed(1)} unit="m" caption="From the screen" />
        <Stat
          value={Math.abs(across).toFixed(1)}
          unit="m"
          caption={
            Math.abs(across) < 0.3
              ? "Centre"
              : across < 0
                ? "Left of centre"
                : "Right of centre"
          }
        />
      </div>
      {lensNote ? <p className={styles.fine}>{lensNote}</p> : null}
      <ReconnectNote snapshot={snapshot} />
    </Shell>
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
