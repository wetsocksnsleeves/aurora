"use client";

import { useEffect, useRef } from "react";
import type { HostClient, HostSnapshot } from "@/app/sessions/host-client";
import { showDurationMs } from "@/lib/compile";
import { clockText, type StateCounts } from "@/lib/host-map";
import type { Show } from "@/lib/types";
import styles from "./room.module.css";

/**
 * Who is in the room and the show's Start and Stop. While the show plays,
 * the clock is written every frame through a ref, not React state.
 */
export function CrowdCard({
  client,
  snapshot,
  counts,
  show,
  ready,
  onStart,
}: {
  client: HostClient;
  snapshot: HostSnapshot;
  counts: StateCounts;
  show: Show;
  /** The phones have the latest edits, so Start plays what is on screen. */
  ready: boolean;
  onStart: () => void;
}) {
  const { T0, clockReady, connection, lastError } = snapshot;
  const clockRef = useRef<HTMLSpanElement>(null);
  const durationMs = showDurationMs(show);

  useEffect(() => {
    if (T0 === null || !clockReady) return;
    let raf = 0;
    let last = "";
    const render = () => {
      raf = requestAnimationFrame(render);
      const showMs = client.clock.serverNow() - T0;
      const text =
        showMs < 0
          ? `-${Math.ceil(-showMs / 1000)}`
          : clockText(Math.min(showMs, durationMs));
      if (text !== last && clockRef.current) {
        clockRef.current.textContent = text;
        last = text;
      }
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [client, T0, clockReady, durationMs]);

  const error = lastError ? (
    <p className={styles.error} role="alert">
      {lastError}
    </p>
  ) : null;

  if (T0 !== null) {
    return (
      <section className={styles.card} aria-label="Show">
        <p className={styles.label}>Playing</p>
        <div className={styles.stat}>
          <span ref={clockRef}>0:00</span>
          <small>/ {clockText(durationMs)}</small>
        </div>
        <p className={styles.note}>
          {counts.playing} {counts.playing === 1 ? "phone" : "phones"} in the
          show
        </p>
        <button
          type="button"
          className={styles.stop}
          disabled={connection !== "open"}
          onClick={() => client.stopShow()}
        >
          Stop
        </button>
        {error}
      </section>
    );
  }

  const waiting = counts.total - counts.disconnected - counts.standby;
  return (
    <section className={styles.card} aria-label="Crowd">
      <p className={styles.label}>Crowd</p>
      <div className={styles.stat} data-testid="ready-count">
        {counts.standby}
        <small>ready</small>
      </div>
      <p className={styles.note}>
        {durationMs === 0
          ? "Add a clip to have something to play."
          : counts.total === 0
            ? "Open the big screen. Phones join by scanning it."
            : waiting > 0
              ? `${waiting} still finding their seat`
              : "Everyone is ready"}
      </p>
      <button
        type="button"
        className={styles.start}
        disabled={
          connection !== "open" ||
          counts.standby === 0 ||
          durationMs === 0 ||
          !ready
        }
        title={
          ready ? undefined : "Waiting for the phones to get the latest edits"
        }
        onClick={onStart}
      >
        Start show
      </button>
      {error}
    </section>
  );
}
