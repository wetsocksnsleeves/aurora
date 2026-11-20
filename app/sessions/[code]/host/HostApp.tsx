"use client";

import Link from "next/link";
import QRCode from "qrcode";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { VenueView } from "@/components/venue/VenueView";
import { clickTimesForShow } from "@/lib/audio-schedule";
import { clickTrackByDefault } from "@/lib/builtin-shows";
import { showDurationMs } from "@/lib/compile";
import {
  STATE_COLORS,
  STATE_LABELS,
  countByState,
  liveDotColor,
  participantDots,
  showStatus,
} from "@/lib/host-map";
import type { ParticipantSummary } from "@/lib/protocol";
import { PARTICIPANT_STATES, type Show } from "@/lib/types";
import { HostClient, browserHostDeps } from "../../host-client";
import { AudioPanel, useHostAudio } from "./AudioPanel";
import styles from "./host.module.css";

/**
 * Host screen (SPEC 2.2): the venue with one dot per participant coloured by
 * state (5.3), a QR code for the join URL, the code as text, counts per
 * state, and Start/Stop. While a show runs, playing dots take the colour the
 * phone shows (`colorAt` on the session's show snapshot at the host's own
 * `serverNow() - T0`), repainted every animation frame.
 *
 * The host machine plays the show's audio (SPEC 4.8, `useHostAudio`). Start
 * doubles as the user gesture that lets the browser play sound.
 */
export function HostApp({ code }: { code: string }) {
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

  const { session, participants, fatal, connection, T0, clockReady } = snapshot;
  const show = session?.show ?? null;
  const live = show !== null && T0 !== null && clockReady;
  const dots = useMemo(
    () =>
      participantDots(
        participants,
        // Colour at render time too, so a participants update does not
        // flash the state colour for a frame before the loop repaints.
        live ? liveDotColor(show, client.clock.serverNow() - T0) : undefined,
      ),
    [participants, live, show, T0, client],
  );
  const counts = useMemo(() => countByState(participants), [participants]);
  const mapRef = useRef<HTMLElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  useLiveColors(
    mapRef,
    statusRef,
    client,
    participants,
    live ? show : null,
    T0,
  );
  const qr = useQrSvg(session?.joinUrl ?? null);
  // Click track (chunk 16): null until the host toggles it, then their choice.
  const [clickChoice, setClickChoice] = useState<boolean | null>(null);
  const clickOn = clickChoice ?? clickTrackByDefault(session?.showId ?? "");
  const clickTimesMs = useMemo(
    () => (clickOn && show ? clickTimesForShow(show) : null),
    [clickOn, show],
  );
  const audio = useHostAudio(client, show, T0, clockReady, clickTimesMs);

  if (fatal) {
    return (
      <main className={styles.message}>
        <h1>
          {fatal === "unknown-session"
            ? "Session not found"
            : "Not the host of this session"}
        </h1>
        <p>
          {fatal === "unknown-session"
            ? `No session with code ${code}. The server may have restarted.`
            : `This browser tab did not create session ${code}, so it cannot host it.`}
        </p>
        <Link href="/">Back to the start page</Link>
      </main>
    );
  }

  return (
    <main className={styles.layout}>
      <section className={styles.mapPanel} aria-label="Venue map" ref={mapRef}>
        {session ? (
          <VenueView
            venue={session.venue}
            dots={dots}
            label={`Venue map with ${dots.length} seated participants`}
          />
        ) : (
          <p className={styles.muted}>Connecting…</p>
        )}
      </section>

      <aside className={styles.side}>
        <div className={styles.qr}>
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element -- data URL
            <img src={qr} alt={`QR code for ${session?.joinUrl ?? ""}`} />
          ) : (
            <div className={styles.qrPlaceholder} />
          )}
        </div>
        <p className={styles.scan}>Scan to join, or open</p>
        <p className={styles.url}>{session?.joinUrl ?? "…"}</p>
        <p className={styles.code} aria-label="Join code">
          {code}
        </p>

        <div className={styles.controls}>
          {T0 === null ? (
            <button
              type="button"
              className={styles.start}
              disabled={connection !== "open" || counts.standby === 0}
              onClick={() => {
                // The click is the gesture that lets the AudioContext run.
                void audio.audio.unlock();
                client.startShow();
              }}
            >
              Start
            </button>
          ) : (
            <button
              type="button"
              className={styles.stop}
              disabled={connection !== "open"}
              onClick={() => client.stopShow()}
            >
              Stop
            </button>
          )}
          {T0 === null ? (
            <p className={styles.showStatus}>
              {counts.standby === 0
                ? "Start is enabled once a phone is ready."
                : `${counts.standby} ready`}
            </p>
          ) : (
            // Filled by useLiveColors every frame; React leaves it empty.
            <p className={styles.showStatus} ref={statusRef} />
          )}
          {snapshot.lastError ? (
            <p className={styles.error} role="alert">
              {snapshot.lastError}
            </p>
          ) : null}
        </div>

        <AudioPanel controls={audio}>
          <label className={styles.toggle}>
            <input
              type="checkbox"
              checked={clickOn}
              onChange={(e) => setClickChoice(e.target.checked)}
            />
            Click track: a beep at each clip start
          </label>
          <p className={styles.audioHint}>
            Scheduled like the track. Move the offset until the beeps land on
            the flashes, by ear and on camera.
          </p>
        </AudioPanel>

        <ul className={styles.counts}>
          {PARTICIPANT_STATES.map((state) => (
            <li key={state} data-state={state}>
              <span
                className={styles.swatch}
                style={{ background: STATE_COLORS[state] }}
                aria-hidden
              />
              <span className={styles.countLabel}>{STATE_LABELS[state]}</span>
              <span className={styles.countValue}>{counts[state]}</span>
            </li>
          ))}
          <li className={styles.total} data-state="total">
            <span className={styles.swatch} aria-hidden />
            <span className={styles.countLabel}>Total</span>
            <span className={styles.countValue}>{counts.total}</span>
          </li>
        </ul>
        <p className={styles.legend}>
          <span className={styles.warningIcon} aria-hidden>
            ▲
          </span>{" "}
          marks a phone whose clock sync is degraded.
        </p>
        {connection !== "open" ? (
          <p className={styles.status}>
            {connection === "reconnecting" ? "Reconnecting…" : "Connecting…"}
          </p>
        ) : null}
      </aside>
    </main>
  );
}

/**
 * While `show` is set (a show runs and the host clock is ready), repaint
 * playing dots with their current show colour and update the status line,
 * every animation frame. Writes `fill` on the SVG circles directly: 500 dots
 * through React state at 60 fps would re-render the whole map every frame.
 */
function useLiveColors(
  mapRef: RefObject<HTMLElement | null>,
  statusRef: RefObject<HTMLElement | null>,
  client: HostClient,
  participants: readonly ParticipantSummary[],
  show: Show | null,
  T0: number | null,
) {
  useEffect(() => {
    if (!show || T0 === null) return;
    const durationMs = showDurationMs(show);
    const circles = new Map<string, SVGCircleElement>();
    mapRef.current
      ?.querySelectorAll<SVGCircleElement>("circle[data-dot-id]")
      .forEach((el) => circles.set(el.dataset.dotId ?? "", el));
    const playing = participants.filter(
      (p) => p.state === "playing" && circles.has(p.id),
    );
    let raf = 0;
    let lastStatus = "";
    const render = () => {
      raf = requestAnimationFrame(render);
      const showMs = client.clock.serverNow() - T0;
      const colorOf = liveDotColor(show, showMs);
      for (const p of playing) {
        const el = circles.get(p.id)!;
        const color = colorOf(p);
        if (el.getAttribute("fill") !== color) el.setAttribute("fill", color);
      }
      const status = showStatus(showMs, durationMs);
      if (status !== lastStatus && statusRef.current) {
        statusRef.current.textContent = status;
        lastStatus = status;
      }
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [mapRef, statusRef, client, participants, show, T0]);
}

/** The QR code for `text` as an SVG data URL, or null while rendering. */
function useQrSvg(text: string | null): string | null {
  const [qr, setQr] = useState<{ text: string; url: string } | null>(null);
  useEffect(() => {
    if (!text) return;
    let cancelled = false;
    QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M" })
      .then((svg) => {
        if (cancelled) return;
        setQr({
          text,
          url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [text]);
  return qr && qr.text === text ? qr.url : null;
}
