"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { DARK, ScheduleCursor, playbackFrame } from "@/lib/playback";
import type { ParticipantClient } from "./participant-client";
import styles from "./participant.module.css";

/**
 * The show itself (SPEC 4.7): a full-viewport colour fill painted from a
 * requestAnimationFrame loop. Each frame reads the clock, so a late frame
 * still shows the right colour for its moment; no timers per event. The
 * colour is written to the element's style directly, never through React
 * state, so a frame costs one lookup and at most one style write.
 *
 * `over` (past `durationMs`) is the only thing that re-renders: it swaps the
 * fill for the "Show over" screen. `overMessage` is that screen.
 */
export function Playback({
  client,
  overMessage,
}: {
  client: ParticipantClient;
  overMessage: ReactNode;
}) {
  const fill = useRef<HTMLElement>(null);
  const [over, setOver] = useState(false);

  useEffect(() => {
    let raf = 0;
    let cursor: ScheduleCursor | null = null;
    let painted = "";
    let wasOver = false;

    const paint = (color: string) => {
      if (color === painted || !fill.current) return;
      fill.current.style.backgroundColor = color;
      painted = color;
    };

    const render = () => {
      // Re-arm first, so an exception later in the frame does not stop the
      // loop (SPEC 4.7).
      raf = requestAnimationFrame(render);
      const s = client.getSnapshot();
      if (s.schedule && cursor?.events !== s.schedule.events) {
        cursor = new ScheduleCursor(s.schedule.events);
      }
      const frame = playbackFrame(
        {
          clockReady: client.clock.ready,
          T0: s.T0,
          schedule: s.schedule,
          serverNow: client.clock.serverNow(),
        },
        cursor,
      );
      const isOver = frame.kind === "over";
      if (isOver !== wasOver) {
        wasOver = isOver;
        setOver(isOver);
      }
      paint(frame.kind === "color" ? frame.color : DARK);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [client]);

  return (
    <>
      <main
        ref={fill}
        className={styles.playing}
        data-screen="playing"
        hidden={over}
        aria-label="Light show"
      />
      {over ? overMessage : null}
    </>
  );
}
