"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { Toast } from "../edit-actions";
import type { HostAudio } from "../host-audio";
import styles from "../room.module.css";
import { startRecording, type Take } from "./recorder";
import type { useCamera } from "./use-camera";

function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * The camera beside the room: a live view to film the crowd with, and
 * Record, which films the camera and the room view together and offers
 * both files to download when it stops.
 */
export function CameraPanel({
  camera,
  frameRef,
  screenShare,
  audio,
  onPresent,
  presenting,
  toast,
}: {
  camera: ReturnType<typeof useCamera>;
  frameRef: RefObject<HTMLElement | null>;
  screenShare: () => number;
  audio: HostAudio;
  onPresent: () => void;
  presenting: boolean;
  toast: Toast;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [recording, setRecording] = useState<{
    stop: () => Promise<Take>;
    since: number;
  } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [takes, setTakes] = useState<Take[]>([]);
  const [saving, setSaving] = useState(false);
  const [listOpen, setListOpen] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (video && video.srcObject !== camera.stream) {
      video.srcObject = camera.stream;
      if (camera.stream) void video.play().catch(() => {});
    }
  }, [camera.stream]);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(
      () => setElapsed(performance.now() - recording.since),
      250,
    );
    return () => clearInterval(timer);
  }, [recording]);

  // Free the recordings' memory when the panel goes.
  const takesRef = useRef(takes);
  useEffect(() => {
    takesRef.current = takes;
  }, [takes]);
  useEffect(
    () => () => {
      for (const take of takesRef.current) {
        for (const f of take.files) URL.revokeObjectURL(f.url);
      }
    },
    [],
  );

  const record = () => {
    const frame = frameRef.current;
    if (!frame) return;
    let music: MediaStream | null = null;
    try {
      music = audio.recordingStream();
    } catch {
      music = null;
    }
    const run = startRecording({
      room: { frame, screenShare },
      camera: camera.stream,
      music,
    });
    setElapsed(0);
    setRecording({ stop: run.stop, since: performance.now() });
    toast("Recording the camera and the room");
  };

  const stop = async () => {
    if (!recording) return;
    setSaving(true);
    try {
      const take = await recording.stop();
      setTakes((t) => [take, ...t]);
      setListOpen(true);
      toast(`Saved ${clock(take.durationMs)} of video, ready to download`);
    } finally {
      setRecording(null);
      setSaving(false);
    }
  };

  // Stop cleanly if the camera is closed mid-recording.
  const stopRef = useRef(stop);
  useEffect(() => {
    stopRef.current = stop;
  });
  useEffect(() => {
    if (!camera.stream && recording) void stopRef.current();
  }, [camera.stream, recording]);

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
            disabled={!camera.stream}
            title="Record the camera and the room together"
            onClick={record}
          >
            <i aria-hidden />
            Record
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
          <span className={styles.takes}>
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
                  className={styles.backdrop}
                  onClick={() => setListOpen(false)}
                />
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
            disabled={!!recording}
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
