"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { HostAudio } from "../host-audio";
import { startRecording, type RoomSource, type Take } from "./recorder";

export type Recorder = {
  /** When the current recording started (performance.now), or null. */
  since: number | null;
  saving: boolean;
  takes: Take[];
  start: () => Promise<void>;
  stop: () => Promise<Take | null>;
};

/** Save a file the browser has in memory, as if a download link was clicked. */
function download(url: string, fileName: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Recording the room and the camera, kept above the editor so it carries
 * on when the show is switched. Stop downloads both files straight away
 * and keeps them in `takes`.
 */
export function useRecorder(opts: {
  room: RoomSource;
  audio: HostAudio;
  camera: MediaStream | null;
}): Recorder {
  const [since, setSince] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [takes, setTakes] = useState<Take[]>([]);
  const run = useRef<{ stop: () => Promise<Take> } | null>(null);
  const starting = useRef(false);
  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });

  const start = useCallback(async () => {
    if (run.current || starting.current) return;
    starting.current = true;
    const { room, audio, camera } = latest.current;
    // Record is a click: let the show's sound run. Its track only goes in
    // once it does: Safari waits forever on an audio track with no sound.
    await audio.unlock();
    let music: MediaStream | null = null;
    if (audio.running) {
      try {
        music = audio.recordingStream();
      } catch {
        music = null;
      }
    }
    run.current = startRecording({ room, camera, music });
    starting.current = false;
    setSince(performance.now());
  }, []);

  const stop = useCallback(async () => {
    const current = run.current;
    if (!current) return null;
    run.current = null;
    setSaving(true);
    try {
      const take = await current.stop();
      if (take.files.length) setTakes((t) => [take, ...t]);
      for (const file of take.files) download(file.url, file.fileName);
      return take;
    } finally {
      setSince(null);
      setSaving(false);
    }
  }, []);

  // Free the recordings' memory when the room closes.
  const takesRef = useRef(takes);
  useEffect(() => {
    takesRef.current = takes;
  }, [takes]);
  useEffect(
    () => () => {
      void run.current?.stop();
      for (const take of takesRef.current) {
        for (const f of take.files) URL.revokeObjectURL(f.url);
      }
    },
    [],
  );

  return { since, saving, takes, start, stop };
}
