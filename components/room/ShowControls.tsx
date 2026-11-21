"use client";

import { useEffect, useRef } from "react";
import type { HostClient, HostSnapshot } from "@/app/sessions/host-client";
import { showDurationMs } from "@/lib/compile";
import { clockText, type StateCounts } from "@/lib/host-map";
import type { Show } from "@/lib/types";
import styles from "./room.module.css";

/**
 * Start and Stop, in the top bar. While the show plays its clock sits
 * beside Stop, written every frame through a ref rather than React state.
 */
export function ShowControls({
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
  const { T0, clockReady, connection } = snapshot;
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
          ? `Starting in ${Math.ceil(-showMs / 1000)}`
          : `${clockText(Math.min(showMs, durationMs))} / ${clockText(durationMs)}`;
      if (text !== last && clockRef.current) {
        clockRef.current.textContent = text;
        last = text;
      }
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [client, T0, clockReady, durationMs]);

  if (T0 !== null) {
    return (
      <span className={styles.showControls}>
        <span className={styles.liveClock}>
          <i aria-hidden />
          <span ref={clockRef}>Playing</span>
        </span>
        <button
          type="button"
          className={styles.stop}
          disabled={connection !== "open"}
          onClick={() => client.stopShow()}
        >
          Stop
        </button>
      </span>
    );
  }

  const why =
    connection !== "open"
      ? "Reconnecting to the room"
      : durationMs === 0
        ? "Add an effect first"
        : counts.standby === 0
          ? "No phones are ready yet"
          : !ready
            ? "Sending your latest edits to the phones"
            : undefined;
  return (
    <span className={styles.showControls}>
      {snapshot.lastError ? (
        <span className={styles.error} role="alert">
          {snapshot.lastError}
        </span>
      ) : null}
      <button
        type="button"
        className={styles.start}
        disabled={why !== undefined}
        title={why ?? `Play the show on ${counts.standby} phones`}
        onClick={onStart}
      >
        <span className={styles.playGlyph} aria-hidden />
        Start show
      </button>
    </span>
  );
}
