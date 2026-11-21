"use client";

import { useEffect, useRef, useState } from "react";
import type { Toast } from "../edit-actions";
import styles from "../room.module.css";
import type { useCamera } from "./use-camera";
import type { Recorder } from "./use-recorder";

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The camera beside the room: a live view to film the crowd with, and
 * Record, which films the camera and the room view together and downloads
 * both when it stops. The recording itself lives above the editor
 * (`useRecorder`), so switching shows doesn't stop it.
 */
export function CameraPanel({
  camera,
  recorder,
  onPresent,
  presenting,
  toast,
}: {
  camera: ReturnType<typeof useCamera>;
  recorder: Recorder;
  onPresent: () => void;
  presenting: boolean;
  toast: Toast;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [now, setNow] = useState(0);
  const [listOpen, setListOpen] = useState(false);
  const { since, saving, takes } = recorder;
  const recording = since !== null;
  const elapsed = recording ? Math.max(0, now - since) : 0;

  useEffect(() => {
    const video = videoRef.current;
    if (video && video.srcObject !== camera.stream) {
      video.srcObject = camera.stream;
      if (camera.stream) void video.play().catch(() => {});
    }
  }, [camera.stream]);

  useEffect(() => {
    if (!recording) return;
    const tick = () => setNow(performance.now());
    tick();
    const timer = setInterval(tick, 250);
    return () => clearInterval(timer);
  }, [recording]);

  // Close the list on a click outside it, or Esc. (A full-screen click
  // catcher can't be used here: the bar's blur traps it inside the bar.)
  const takesRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!listOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!takesRef.current?.contains(e.target as Node)) setListOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setListOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [listOpen]);

  const record = () => {
    recorder.start();
    toast("Recording the camera and the room");
  };

  const stop = async () => {
    const take = await recorder.stop();
    if (take) {
      setListOpen(true);
      toast(`Saved ${clock(take.durationMs)}: both files are downloading`);
    }
  };

  return (
    <div
      className={styles.cameraTile}
      data-recording={recording ? "" : undefined}
    >
      <video ref={videoRef} muted playsInline autoPlay aria-label="Camera" />
      {!camera.stream ? (
        <p className={styles.cameraMessage}>
          {camera.error ?? (camera.starting ? "Opening the camera…" : "")}
        </p>
      ) : null}
      {recording ? (
        <span className={styles.recBadge}>
          <i aria-hidden />
          {clock(elapsed)}
        </span>
      ) : null}

      <div className={styles.cameraBar}>
        {recording ? (
          <button
            type="button"
            className={styles.recButton}
            data-on=""
            disabled={saving}
            onClick={() => void stop()}
          >
            <i aria-hidden />
            {saving ? "Saving…" : "Stop"}
          </button>
        ) : (
          <button
            type="button"
            className={styles.recButton}
            disabled={!camera.stream || saving}
            title="Record the camera and the room together"
            onClick={record}
          >
            <i aria-hidden />
            {saving ? "Saving…" : "Record"}
          </button>
        )}
        {camera.devices.length > 1 && !recording ? (
          <select
            className={styles.cameraSelect}
            aria-label="Camera"
            value={camera.deviceId ?? ""}
            onChange={(e) => camera.choose(e.target.value)}
          >
            {camera.devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        ) : null}
        <span className={styles.spacer} />
        {takes.length ? (
          <span className={styles.takes} ref={takesRef}>
            <button
              type="button"
              className={styles.cameraButton}
              aria-expanded={listOpen}
              onClick={() => setListOpen((o) => !o)}
            >
              Recordings ({takes.length})
            </button>
            {listOpen ? (
              <>
                <div
                  className={styles.takeList}
                  role="dialog"
                  aria-label="Recordings"
                >
                  {takes.map((take) => (
                    <div key={take.id} className={styles.take}>
                      <span>
                        {take.startedAt.toLocaleTimeString([], {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                        <small> · {clock(take.durationMs)}</small>
                      </span>
                      {take.files.map((f) => (
                        <a
                          key={f.kind}
                          className={styles.cameraButton}
                          href={f.url}
                          download={f.fileName}
                        >
                          {f.kind === "room" ? "Room" : "Camera"} ↓
                        </a>
                      ))}
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </span>
        ) : null}
        <button
          type="button"
          className={styles.cameraButton}
          title={
            presenting
              ? "Leave full screen (Esc)"
              : "Room and camera full screen, for casting"
          }
          onClick={onPresent}
        >
          {presenting ? "Exit" : "Present"}
        </button>
        {presenting ? null : (
          <button
            type="button"
            className={styles.cameraButton}
            aria-label="Close the camera"
            disabled={recording}
            title={recording ? "Stop recording first" : "Close the camera"}
            onClick={camera.close}
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}
