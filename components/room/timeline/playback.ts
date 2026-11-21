"use client";

import { useEffect, useState } from "react";
import { audioUrl } from "@/components/editor/api";
import type { EditorStore } from "@/components/editor/store";

/**
 * Editor playback for the room timeline. With music, an <audio> element
 * plays the file and the playhead follows it; without, a clock runs to the
 * show's length. Either way the store owns the playhead: `setPlaying`,
 * `seek` and `tick` (SPEC 2.1).
 *
 * The decoded track is kept too: the timeline draws its waveform from the
 * peaks, and "Create from the music" analyses the samples.
 */

export type DecodedAudio = {
  fileId: string;
  durationMs: number;
  sampleRate: number;
  /** Mono samples in -1..1. */
  samples: Float32Array;
  /** Peak level per `PEAK_MS`, 0..1. */
  peaks: Float32Array;
};

export const PEAK_MS = 10;

const decoded = new Map<string, Promise<DecodedAudio>>();

/** Fetch and decode a track once per page. */
export function decodeAudio(fileId: string): Promise<DecodedAudio> {
  let pending = decoded.get(fileId);
  if (!pending) {
    pending = (async () => {
      const res = await fetch(audioUrl(fileId));
      if (!res.ok) throw new Error(`audio ${res.status}`);
      const data = await res.arrayBuffer();
      const ctx = new OfflineAudioContext(1, 1, 44_100);
      const buffer = await ctx.decodeAudioData(data);
      const samples = new Float32Array(buffer.length);
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const channel = buffer.getChannelData(c);
        for (let i = 0; i < channel.length; i++) {
          samples[i]! += channel[i]! / buffer.numberOfChannels;
        }
      }
      const per = Math.max(1, Math.round((buffer.sampleRate * PEAK_MS) / 1000));
      const peaks = new Float32Array(Math.ceil(samples.length / per));
      let loudest = 0;
      for (let b = 0; b < peaks.length; b++) {
        let peak = 0;
        const end = Math.min(samples.length, (b + 1) * per);
        for (let i = b * per; i < end; i++) {
          const v = Math.abs(samples[i]!);
          if (v > peak) peak = v;
        }
        peaks[b] = peak;
        loudest = Math.max(loudest, peak);
      }
      if (loudest > 0)
        for (let b = 0; b < peaks.length; b++) peaks[b]! /= loudest;
      return {
        fileId,
        durationMs: Math.round(buffer.duration * 1000),
        sampleRate: buffer.sampleRate,
        samples,
        peaks,
      };
    })();
    decoded.set(fileId, pending);
    pending.catch(() => decoded.delete(fileId));
  }
  return pending;
}

/** The decoded track for `fileId`, or null while it loads or without one. */
export function useDecodedAudio(
  store: EditorStore,
  fileId: string,
): DecodedAudio | null {
  const [audio, setAudio] = useState<DecodedAudio | null>(null);
  useEffect(() => {
    if (!fileId) return;
    let cancelled = false;
    store.dispatch({ type: "setAudioStatus", status: "loading" });
    decodeAudio(fileId).then(
      (a) => {
        if (cancelled) return;
        setAudio(a);
        store.dispatch({
          type: "setShowAudio",
          audio: { fileId, durationMs: a.durationMs },
        });
        store.dispatch({ type: "setAudioStatus", status: "ready" });
      },
      (err: unknown) => {
        if (cancelled) return;
        store.dispatch({
          type: "setAudioStatus",
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [store, fileId]);
  return audio && audio.fileId === fileId ? audio : null;
}

/**
 * Drives playback from the store. Stops at the end of the show. While
 * `locked` (the room is playing the show live) local playback stays off.
 */
export function usePlayback(
  store: EditorStore,
  fileId: string,
  locked: boolean,
): void {
  useEffect(() => {
    const element = fileId ? new Audio(audioUrl(fileId)) : null;
    if (element) element.preload = "auto";
    let raf = 0;
    let clockStart = 0;
    let running = false;
    let seekSeq = store.getState().seekSeq;

    const now = () => {
      if (element) return element.currentTime * 1000;
      return performance.now() - clockStart;
    };
    const lengthMs = () => {
      const s = store.getState().show;
      let end = s.audio.durationMs;
      for (const c of s.clips) end = Math.max(end, c.endMs);
      return end;
    };
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const t = now();
      if (t >= lengthMs() || (element && element.ended)) {
        store.dispatch({ type: "setPlaying", playing: false });
        store.dispatch({ type: "seek", timeMs: lengthMs() });
        return;
      }
      store.dispatch({ type: "tick", timeMs: t });
    };
    const start = () => {
      const from = store.getState().currentTimeMs;
      const at = from >= lengthMs() - 50 ? 0 : from;
      if (at !== from) store.dispatch({ type: "seek", timeMs: at });
      seekSeq = store.getState().seekSeq;
      if (element) {
        element.currentTime = at / 1000;
        void element.play().catch(() => {
          store.dispatch({ type: "setPlaying", playing: false });
        });
      } else {
        clockStart = performance.now() - at;
      }
      running = true;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
      element?.pause();
    };

    const unsubscribe = store.subscribe(() => {
      const state = store.getState();
      const playing = state.playing && !locked;
      if (playing && !running) start();
      else if (!playing && running) stop();
      else if (running && state.seekSeq !== seekSeq) {
        // Seeked while playing: jump there and keep going.
        seekSeq = state.seekSeq;
        if (element) element.currentTime = state.currentTimeMs / 1000;
        else clockStart = performance.now() - state.currentTimeMs;
      }
    });
    if (locked && store.getState().playing) {
      store.dispatch({ type: "setPlaying", playing: false });
    }
    return () => {
      unsubscribe();
      stop();
      if (element) element.src = "";
    };
  }, [store, fileId, locked]);
}
