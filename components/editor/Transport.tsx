"use client";

import { useRef, useState } from "react";
import { uploadAudio } from "./api";
import {
  MAX_BPM,
  MIN_BPM,
  SUBDIVISIONS,
  formatTime,
  type SnapMode,
} from "./snap";
import { MAX_ZOOM_PX_PER_SEC, MIN_ZOOM_PX_PER_SEC } from "./store";
import { useEditorSelector, useEditorStore } from "./store-context";
import styles from "./editor.module.css";

const SNAP_LABELS: Record<SnapMode, string> = {
  off: "Off",
  "100ms": "100 ms",
  "50ms": "50 ms",
  beat: "Beat",
};

/**
 * Timeline controls: play/pause, time readout, zoom, snap grid and audio
 * upload. The room screen lays them out (`components/room/RoomApp.tsx`).
 */

export function PlayButton() {
  const store = useEditorStore();
  const playing = useEditorSelector((s) => s.playing);
  const ready = useEditorSelector((s) => s.audioStatus === "ready");
  return (
    <button
      type="button"
      className={`${styles.button} ${styles.playButton}`}
      disabled={!ready}
      aria-label={playing ? "Pause" : "Play"}
      title="Play / pause (Space)"
      onClick={() => store.dispatch({ type: "setPlaying", playing: !playing })}
    >
      {playing ? "Pause" : "Play"}
    </button>
  );
}

export function TimeReadout() {
  const time = useEditorSelector((s) => s.currentTimeMs);
  const duration = useEditorSelector((s) => s.show.audio.durationMs);
  return (
    <span className={styles.time} aria-label="Playhead time">
      {formatTime(time)} / {formatTime(duration)}
    </span>
  );
}

export function ZoomControl() {
  const store = useEditorStore();
  const zoom = useEditorSelector((s) => s.zoomPxPerSec);
  // Logarithmic slider: equal steps feel like equal zoom changes.
  const min = Math.log2(MIN_ZOOM_PX_PER_SEC);
  const max = Math.log2(MAX_ZOOM_PX_PER_SEC);
  return (
    <label className={styles.control}>
      Zoom
      <input
        type="range"
        min={min}
        max={max}
        step={0.05}
        value={Math.log2(zoom)}
        onChange={(e) =>
          store.dispatch({
            type: "setZoom",
            pxPerSec: Math.round(2 ** Number(e.target.value)),
          })
        }
      />
    </label>
  );
}

export function SnapControls() {
  const store = useEditorStore();
  const snap = useEditorSelector((s) => s.snap);
  return (
    <>
      <label className={styles.control}>
        Snap
        <select
          value={snap.mode}
          onChange={(e) =>
            store.dispatch({
              type: "setSnap",
              snap: { mode: e.target.value as SnapMode },
            })
          }
        >
          {(Object.keys(SNAP_LABELS) as SnapMode[]).map((mode) => (
            <option key={mode} value={mode}>
              {SNAP_LABELS[mode]}
            </option>
          ))}
        </select>
      </label>
      {snap.mode === "beat" && (
        <>
          <label className={styles.control}>
            BPM
            <input
              type="number"
              className={styles.numberInput}
              min={MIN_BPM}
              max={MAX_BPM}
              step="any"
              placeholder="120"
              value={snap.bpm ?? ""}
              onChange={(e) =>
                store.dispatch({
                  type: "setSnap",
                  snap: {
                    bpm: e.target.value === "" ? null : Number(e.target.value),
                  },
                })
              }
            />
          </label>
          <label className={styles.control}>
            Grid
            <select
              value={snap.subdivision}
              onChange={(e) =>
                store.dispatch({
                  type: "setSnap",
                  snap: { subdivision: Number(e.target.value) },
                })
              }
            >
              {SUBDIVISIONS.map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? "1 beat" : `1/${n} beat`}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.control}>
            First beat (ms)
            <input
              type="number"
              className={styles.numberInput}
              min={0}
              step={1}
              value={snap.beatOffsetMs}
              onChange={(e) =>
                store.dispatch({
                  type: "setSnap",
                  snap: {
                    beatOffsetMs: Math.max(0, Number(e.target.value) || 0),
                  },
                })
              }
            />
          </label>
        </>
      )}
    </>
  );
}

export function AudioUpload() {
  const store = useEditorStore();
  const inputRef = useRef<HTMLInputElement>(null);
  const status = useEditorSelector((s) => s.audioStatus);
  const error = useEditorSelector((s) => s.audioError);
  const hasAudio = useEditorSelector((s) => s.show.audio.fileId !== "");
  const [busy, setBusy] = useState(false);

  async function onFile(file: File) {
    setBusy(true);
    store.dispatch({ type: "setAudioStatus", status: "uploading" });
    try {
      const { fileId } = await uploadAudio(file);
      // The duration is filled in once the waveform has decoded the file.
      store.dispatch({
        type: "setShowAudio",
        audio: { fileId, durationMs: 0 },
      });
    } catch (err) {
      store.dispatch({
        type: "setAudioStatus",
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  const statusText =
    status === "uploading"
      ? "Uploading…"
      : status === "loading"
        ? "Decoding…"
        : status === "error"
          ? `Audio error: ${error ?? "unknown"}`
          : "";

  return (
    <>
      {statusText && (
        <span
          className={`${styles.status} ${status === "error" ? styles.statusError : ""}`}
          role="status"
        >
          {statusText}
        </span>
      )}
      <input
        ref={inputRef}
        type="file"
        accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4,audio/x-m4a"
        hidden
        data-testid="audio-input"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onFile(file);
        }}
      />
      <button
        type="button"
        className={styles.button}
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {hasAudio ? "Replace audio" : "Upload audio"}
      </button>
    </>
  );
}
