"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { audioUrl } from "@/components/editor/api";
import {
  AUDIO_OFFSET_STORAGE_KEY,
  clampAudioOffsetMs,
  parseAudioOffsetMs,
} from "@/lib/audio-schedule";
import { showDurationMs } from "@/lib/compile";
import type { Show } from "@/lib/types";
import type { HostClient } from "@/app/sessions/host-client";
import { HostAudio, type HostAudioSnapshot } from "./host-audio";

/** Slider changes wait this long before the audio is rescheduled. */
const OFFSET_SETTLE_MS = 200;

export type HostAudioControls = {
  audio: HostAudio;
  snapshot: HostAudioSnapshot;
  offsetMs: number;
  setOffsetMs: (value: number) => void;
};

/**
 * Loads the session show's audio and keeps it scheduled against `T0`
 * (SPEC 4.8). The show is the room's loaded show, so a re-saved or newly
 * loaded show (SPEC 2.5) reloads the audio.
 *
 * Rescheduling happens when `T0`, the offset, the click track, the decoded
 * buffer or the context state change. A clock that drops out of ready (tab
 * hidden) does not stop audio that is already scheduled.
 */
export function useHostAudio(
  client: HostClient,
  show: Show | null,
  T0: number | null,
  clockReady: boolean,
  clickTimesMs: readonly number[] | null = null,
): HostAudioControls {
  const [audio] = useState(() => new HostAudio());
  const snapshot = useSyncExternalStore(
    audio.subscribe,
    audio.getSnapshot,
    audio.getSnapshot,
  );
  const [offsetMs, setOffsetMs] = useStoredOffset();
  const settledOffsetMs = useSettled(offsetMs, OFFSET_SETTLE_MS);

  useEffect(() => () => audio.close(), [audio]);

  const hasShow = show !== null;
  const fileId = show?.audio.fileId ?? "";
  useEffect(() => {
    if (!hasShow) return;
    void audio.load(fileId ? audioUrl(fileId) : null);
  }, [audio, hasShow, fileId]);

  const lastKey = useRef<string | null>(null);
  const loadKind = snapshot.load.kind;
  const contextState = snapshot.context;
  useEffect(() => {
    if (T0 === null || !show) {
      lastKey.current = null;
      audio.stop();
      return;
    }
    // Wait for the clock, a running context, and a settled load.
    if (!clockReady || contextState !== "running" || loadKind === "loading") {
      return;
    }
    const key = [T0, settledOffsetMs, loadKind, clickTimesMs?.length ?? -1]
      .map(String)
      .join("|");
    if (key === lastKey.current) return;
    lastKey.current = key;
    const scheduled = audio.play({
      T0,
      serverNow: () => client.clock.serverNow(),
      manualOffsetMs: settledOffsetMs,
      showDurationMs: showDurationMs(show),
      clickTimesMs,
    });
    // Kept on purpose: the log is how the start time is checked without ears.
    console.info("lightshow: audio scheduled", scheduled);
  }, [
    audio,
    client,
    show,
    T0,
    clockReady,
    contextState,
    loadKind,
    settledOffsetMs,
    clickTimesMs,
  ]);

  return { audio, snapshot, offsetMs, setOffsetMs };
}

/** Listeners for offset writes made by this page (`storage` covers others). */
const offsetListeners = new Set<() => void>();
/** Used when localStorage is blocked: lasts until reload. */
let memoryOffsetMs = 0;

function readStoredOffset(): number {
  try {
    return parseAudioOffsetMs(
      window.localStorage.getItem(AUDIO_OFFSET_STORAGE_KEY),
    );
  } catch {
    return memoryOffsetMs; // Storage blocked.
  }
}

function subscribeOffset(onChange: () => void): () => void {
  offsetListeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    offsetListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function writeStoredOffset(value: number): void {
  memoryOffsetMs = clampAudioOffsetMs(value);
  try {
    window.localStorage.setItem(
      AUDIO_OFFSET_STORAGE_KEY,
      String(memoryOffsetMs),
    );
  } catch {
    // Storage blocked: `memoryOffsetMs` holds it until reload.
  }
  for (const fn of offsetListeners) fn();
}

/** The manual offset, kept in localStorage (0 during server render). */
function useStoredOffset(): [number, (value: number) => void] {
  const value = useSyncExternalStore(
    subscribeOffset,
    readStoredOffset,
    () => 0,
  );
  return [value, writeStoredOffset];
}

/** `value`, once it has stopped changing for `ms`. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
