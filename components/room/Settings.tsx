"use client";

import { useState } from "react";
import type { HostClient } from "@/app/sessions/host-client";
import { AUDIO_OFFSET_LIMIT_MS } from "@/lib/audio-schedule";
import {
  inchesFromTargetWidth,
  targetWidthFromInches,
} from "@/lib/positioning/seat";
import type { SessionMessage } from "@/lib/protocol";
import type { HostAudioControls } from "./use-host-audio";
import styles from "./room.module.css";

const MIN_INCHES = 20;
const MAX_INCHES = 1000;

/**
 * Room settings behind one button: the big screen's size (phones need it to
 * measure distance), the audio delay, the click track, and the room itself.
 */
export function Settings({
  client,
  session,
  audio,
  clickOn,
  setClickOn,
  onNewRoom,
}: {
  client: HostClient;
  session: SessionMessage;
  audio: HostAudioControls;
  clickOn: boolean;
  setClickOn: (on: boolean) => void;
  onNewRoom: () => void;
}) {
  const [open, setOpen] = useState(false);
  const config = session.positioning;
  const inches = Math.round(inchesFromTargetWidth(config.targetWidthM));
  const { offsetMs, setOffsetMs, snapshot } = audio;

  return (
    <div className={styles.settings}>
      <button
        type="button"
        className={styles.ghost}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Settings
      </button>
      {open ? (
        <>
          <div className={styles.backdrop} onClick={() => setOpen(false)} />
          <div className={styles.panel} role="dialog" aria-label="Settings">
            <label className={styles.setting}>
              <span>Screen size</span>
              <span className={styles.inputWithUnit}>
                <input
                  // Remount when the server's value changes, so it shows through.
                  key={inches}
                  type="number"
                  inputMode="numeric"
                  min={MIN_INCHES}
                  max={MAX_INCHES}
                  step={1}
                  defaultValue={inches}
                  aria-label="Screen size in inches"
                  onBlur={(e) => {
                    const value = Number(e.target.value);
                    if (
                      value >= MIN_INCHES &&
                      value <= MAX_INCHES &&
                      value !== inches
                    ) {
                      client.setPositioning({
                        ...config,
                        targetWidthM: targetWidthFromInches(value),
                      });
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                />
                in
              </span>
            </label>
            <p className={styles.hint}>
              Diagonal of the screen showing the big screen page, fullscreen.
              Phones use it to judge how far away they are.
            </p>

            <label className={styles.setting}>
              <span>
                Audio delay{" "}
                <output className={styles.dim}>
                  {offsetMs > 0 ? "+" : ""}
                  {offsetMs} ms
                </output>
              </span>
              <input
                type="range"
                min={-AUDIO_OFFSET_LIMIT_MS}
                max={AUDIO_OFFSET_LIMIT_MS}
                step={5}
                value={offsetMs}
                onChange={(e) => setOffsetMs(Number(e.target.value))}
              />
            </label>
            <p className={styles.hint}>
              Positive plays this laptop’s audio later. Go negative to cancel
              speaker delay (Bluetooth adds 100 to 300 ms).
              {offsetMs !== 0 ? (
                <>
                  {" "}
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => setOffsetMs(0)}
                  >
                    Reset
                  </button>
                </>
              ) : null}
            </p>
            {snapshot.context !== "running" ? (
              <button
                type="button"
                className={styles.ghost}
                onClick={() => void audio.audio.unlock()}
              >
                Enable audio
              </button>
            ) : null}
            {snapshot.load.kind === "error" ? (
              <p className={styles.error}>
                Audio failed to load: {snapshot.load.message}
              </p>
            ) : null}

            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={clickOn}
                onChange={(e) => setClickOn(e.target.checked)}
              />
              Click track: a beep at each clip start
            </label>

            <a
              className={styles.link}
              href="/mock"
              target="_blank"
              rel="noreferrer"
            >
              Open the 3D view
            </a>

            <hr />
            <div className={styles.setting}>
              <span>
                Room <span className={styles.code}>{session.code}</span>
              </span>
              <button
                type="button"
                className={styles.link}
                onClick={() => {
                  if (
                    window.confirm(
                      "Start a new room? Phones in this one will need to scan again.",
                    )
                  ) {
                    onNewRoom();
                  }
                }}
              >
                New room
              </button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
