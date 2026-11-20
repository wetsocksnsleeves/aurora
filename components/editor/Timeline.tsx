"use client";

import { useEffect, useRef } from "react";
import type WaveSurfer from "wavesurfer.js";
import type TimelinePlugin from "wavesurfer.js/dist/plugins/timeline.js";
import { audioUrl } from "./api";
import { ClipLane } from "./ClipLane";
import { formatTime, snapTime, timelineTicks } from "./snap";
import type { EditorState } from "./store";
import { useEditorSelector, useEditorStore } from "./store-context";
import styles from "./editor.module.css";

type TimelinePluginInstance = ReturnType<typeof TimelinePlugin.create>;

/**
 * The waveform under the venue canvas, drawn by wavesurfer.js. Wavesurfer is
 * the audio engine: it plays the file, owns the playback position and
 * reports it to the store with `tick`. In the other direction it follows the
 * store's `seek`, `setPlaying` and `setZoom` actions, so any component can
 * drive playback by dispatching.
 *
 * Clicks and drags on the waveform move the playhead, snapped to the grid.
 * The clip lane below it follows the waveform's width and scroll.
 */
export function Timeline() {
  const store = useEditorStore();
  const fileId = useEditorSelector((s) => s.show.audio.fileId);
  const containerRef = useRef<HTMLDivElement>(null);
  const laneContentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!fileId || !container) return;
    let cancelled = false;
    let ws: WaveSurfer | null = null;
    let unsubscribe = () => {};
    store.dispatch({ type: "setAudioStatus", status: "loading" });

    // wavesurfer touches `window` on import, so load it in the browser only.
    void Promise.all([
      import("wavesurfer.js"),
      import("wavesurfer.js/dist/plugins/timeline.js"),
    ]).then(([{ default: WaveSurferClass }, { default: Timeline }]) => {
      if (cancelled) return;
      const initial = store.getState();
      const instance = WaveSurferClass.create({
        container,
        url: audioUrl(fileId),
        height: 96,
        waveColor: "#4b5563",
        progressColor: "#6ee7b7",
        cursorColor: "#fbbf24",
        cursorWidth: 2,
        minPxPerSec: initial.zoomPxPerSec,
        dragToSeek: true,
        autoScroll: true,
        autoCenter: true,
        normalize: true,
      });
      ws = instance;
      let ready = false;
      let ruler: TimelinePluginInstance | null = null;
      let rulerKey = "";

      const updateRuler = (state: EditorState) => {
        const ticks = timelineTicks(state.snap, state.zoomPxPerSec);
        const key = JSON.stringify(ticks);
        if (key === rulerKey) return;
        rulerKey = key;
        ruler?.destroy();
        const originSec = ticks.originMs / 1000;
        ruler = instance.registerPlugin(
          Timeline.create({
            // Inside the waveform's scroll area, so it scrolls with it.
            height: 20,
            timeInterval: ticks.tickMs / 1000,
            timeOffset: originSec,
            // Label by tick count, not by time, so beat grids label cleanly.
            primaryLabelSpacing: ticks.labelEvery,
            primaryLabelInterval: Number.MAX_SAFE_INTEGER,
            secondaryLabelInterval: Number.MAX_SAFE_INTEGER,
            formatTimeCallback: (sec) =>
              formatTime((sec + originSec) * 1000).replace(/\.?0+$/, ""),
            style: { color: "#9a9aa8" },
          }),
        );
      };

      // Keep the clip lane aligned with the waveform. Wavesurfer renders in a
      // shadow root, so the lane mirrors its width and scroll instead of
      // living inside it.
      const syncLane = () => {
        const content = laneContentRef.current;
        if (!content) return;
        content.style.width = `${instance.getWrapper().clientWidth}px`;
        content.style.transform = `translateX(${-instance.getScroll()}px)`;
      };
      instance.on("scroll", syncLane);
      instance.on("zoom", syncLane);
      instance.on("resize", syncLane);
      instance.on("redrawcomplete", syncLane);
      // Horizontal wheel or trackpad swipes over the lane pan the waveform.
      const lane = laneContentRef.current?.parentElement;
      const onWheel = (e: WheelEvent) => {
        if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
        e.preventDefault();
        instance.setScroll(instance.getScroll() + e.deltaX);
      };
      lane?.addEventListener("wheel", onWheel, { passive: false });
      instance.on("destroy", () => lane?.removeEventListener("wheel", onWheel));

      instance.on("decode", (durationSec) => {
        const durationMs = Math.round(durationSec * 1000);
        store.dispatch({ type: "setShowAudio", audio: { fileId, durationMs } });
      });
      instance.on("ready", () => {
        ready = true;
        const state = store.getState();
        instance.zoom(state.zoomPxPerSec);
        instance.setTime(state.currentTimeMs / 1000);
        updateRuler(state);
        syncLane();
        store.dispatch({ type: "setAudioStatus", status: "ready" });
      });
      instance.on("error", (err) => {
        store.dispatch({
          type: "setAudioStatus",
          status: "error",
          error: err.message,
        });
      });
      // While paused the store owns the playhead: media elements report
      // seeks late, so a burst of `seek`s (a held arrow key) would otherwise
      // be undone by stale ticks. Paused ticks are only taken right after
      // the user clicked or dragged the waveform.
      let lastInteractionAt = -Infinity;
      instance.on("timeupdate", (sec) => {
        const fromUser = performance.now() - lastInteractionAt < 1000;
        if (instance.isPlaying() || fromUser) {
          store.dispatch({ type: "tick", timeMs: sec * 1000 });
        }
      });
      instance.on("play", () =>
        store.dispatch({ type: "setPlaying", playing: true }),
      );
      instance.on("pause", () =>
        store.dispatch({ type: "setPlaying", playing: false }),
      );
      instance.on("finish", () =>
        store.dispatch({ type: "setPlaying", playing: false }),
      );
      // A click or drag on the waveform moves the playhead to the nearest
      // grid point. Wavesurfer seeks on click right away but on drag after a
      // debounce, so snap on the user's interaction and again on the seek
      // that follows it.
      let snapNextSeek = false;
      const snapToGrid = (sec: number) => {
        const state = store.getState();
        const snapped = snapTime(
          sec * 1000,
          state.snap,
          state.show.audio.durationMs,
        );
        if (Math.abs(snapped - sec * 1000) > 0.5)
          instance.setTime(snapped / 1000);
      };
      instance.on("interaction", (sec) => {
        lastInteractionAt = performance.now();
        snapNextSeek = true;
        snapToGrid(sec);
      });
      instance.on("seeking", (sec) => {
        if (!snapNextSeek) return;
        snapNextSeek = false;
        snapToGrid(sec);
      });

      // Follow the store.
      let seekSeq = initial.seekSeq;
      let zoom = initial.zoomPxPerSec;
      unsubscribe = store.subscribe(() => {
        if (!ready) return;
        const state = store.getState();
        if (state.seekSeq !== seekSeq) {
          seekSeq = state.seekSeq;
          instance.setTime(state.currentTimeMs / 1000);
        }
        if (state.playing !== instance.isPlaying()) {
          if (state.playing) void instance.play();
          else instance.pause();
        }
        if (state.zoomPxPerSec !== zoom) {
          zoom = state.zoomPxPerSec;
          instance.zoom(zoom);
        }
        updateRuler(state);
      });
    });

    return () => {
      cancelled = true;
      unsubscribe();
      ws?.destroy();
      store.dispatch({ type: "setPlaying", playing: false });
    };
  }, [fileId, store]);

  return (
    <div className={styles.timeline}>
      <div
        ref={containerRef}
        className={styles.waveform}
        data-testid="waveform"
      />
      {fileId && <ClipLane contentRef={laneContentRef} />}
      {!fileId && (
        <p className={styles.timelineEmpty}>
          Upload an audio file to see its waveform.
        </p>
      )}
    </div>
  );
}
