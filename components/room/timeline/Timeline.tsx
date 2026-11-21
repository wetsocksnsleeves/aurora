"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  clipKindLabel,
  contrastText,
  dragClipTiming,
  snapToTargets,
  type ClipDragMode,
} from "@/components/editor/clips";
import { formatTime, snapTime, timelineTicks } from "@/components/editor/snap";
import {
  MAX_ZOOM_PX_PER_SEC,
  MIN_ZOOM_PX_PER_SEC,
  newId,
} from "@/components/editor/store";
import {
  useEditorSelector,
  useEditorStore,
} from "@/components/editor/store-context";
import { showDurationMs } from "@/lib/compile";
import type { Clip } from "@/lib/types";
import { addEffect, type Toast } from "../edit-actions";
import { EFFECT_MIME, effectById, type EffectId } from "../effects";
import { ClipIcon } from "../icons";
import { PEAK_MS, type DecodedAudio } from "./playback";
import { TimelineToolbar } from "./TimelineToolbar";
import styles from "./timeline.module.css";

/** Width of the track names on the left. */
const HEAD = 96;
const ROW = 44;
/** Magnetic snap to clip edges and the playhead, in pixels. */
const MAGNET_PX = 8;
/** Pointer travel before a press on a clip counts as a drag. */
const DRAG_PX = 3;

type Drag = {
  id: string;
  mode: ClipDragMode;
  x: number;
  y: number;
  original: Clip;
  gesture: string;
  moved: boolean;
};

/** The effect being dragged from the library (drag data can't be read on dragover). */
let draggingEffect: EffectId | null = null;
export function setDraggingEffect(id: EffectId | null): void {
  draggingEffect = id;
}

/**
 * The room timeline (SPEC 2.1): a ruler, one track per layer (the top one
 * empty, for a new track), and the music. Clips drag to move (across tracks
 * too), their edges trim, and they snap to the grid, the playhead and each
 * other. Effects from the library drop onto a track.
 */
export function Timeline({
  audio,
  locked,
  readOnly,
  toast,
}: {
  audio: DecodedAudio | null;
  /** The show is playing live: look, don't touch. */
  locked: boolean;
  readOnly: boolean;
  toast: Toast;
}) {
  const store = useEditorStore();
  const clips = useEditorSelector((s) => s.show.clips);
  const audioMs = useEditorSelector((s) => s.show.audio.durationMs);
  const fileId = useEditorSelector((s) => s.show.audio.fileId);
  const pps = useEditorSelector((s) => s.zoomPxPerSec);
  const selectedId = useEditorSelector((s) =>
    s.selection?.kind === "clip" ? s.selection.id : null,
  );
  const lengthMs = useEditorSelector((s) => showDurationMs(s.show));
  const editable = !locked && !readOnly;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ left: 0, width: 0 });
  const drag = useRef<Drag | null>(null);
  const [ghost, setGhost] = useState<{
    layer: number;
    atMs: number;
    lengthMs: number;
  } | null>(null);

  const topLayer = clips.reduce((m, c) => Math.max(m, c.layer), -1);
  /** Track layers top to bottom: an empty one above the highest. */
  const layers = useMemo(
    () => Array.from({ length: topLayer + 2 }, (_, i) => topLayer + 1 - i),
    [topLayer],
  );
  const byLayer = useMemo(() => {
    const map = new Map<number, Clip[]>();
    for (const c of clips) map.set(c.layer, [...(map.get(c.layer) ?? []), c]);
    return map;
  }, [clips]);

  const contentPx = (Math.max(lengthMs, 1000) / 1000) * pps + 160;
  const msAt = useCallback(
    (clientX: number) => {
      const el = scrollRef.current;
      if (!el) return 0;
      const x =
        clientX - el.getBoundingClientRect().left + el.scrollLeft - HEAD;
      return Math.max(0, (x / pps) * 1000);
    },
    [pps],
  );
  const layerAt = (clientY: number): number => {
    const rows = scrollRef.current?.querySelector("[data-tracks]");
    if (!rows) return 0;
    const i = Math.floor((clientY - rows.getBoundingClientRect().top) / ROW);
    return layers[Math.max(0, Math.min(layers.length - 1, i))]!;
  };

  // Track the visible range for the canvases.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () =>
      setView({ left: el.scrollLeft, width: el.clientWidth - HEAD });
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  /** Zoom so the whole show fits the width. */
  const fit = useCallback(() => {
    const width = (scrollRef.current?.clientWidth ?? 0) - HEAD - 40;
    if (width <= 0) return;
    const sec = Math.max(1, store.getState().show.audio.durationMs / 1000);
    store.dispatch({
      type: "setZoom",
      pxPerSec: Math.max(
        MIN_ZOOM_PX_PER_SEC,
        Math.min(MAX_ZOOM_PX_PER_SEC, width / sec),
      ),
    });
  }, [store]);

  // Fit the whole show on screen when a show (or its music) arrives.
  const fitted = useRef("");
  useEffect(() => {
    const key = `${fileId}|${audioMs > 0}`;
    if (!view.width || fitted.current === key) return;
    fitted.current = key;
    fit();
  }, [view.width, fileId, audioMs, fit]);

  // Ctrl/Cmd + wheel zooms around the pointer; plain wheel scrolls.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const state = store.getState();
      const atMs = msAt(e.clientX);
      const next = Math.max(
        MIN_ZOOM_PX_PER_SEC,
        Math.min(
          MAX_ZOOM_PX_PER_SEC,
          state.zoomPxPerSec * Math.exp(-e.deltaY * 0.01),
        ),
      );
      store.dispatch({ type: "setZoom", pxPerSec: next });
      const x = e.clientX - el.getBoundingClientRect().left - HEAD;
      requestAnimationFrame(() => {
        el.scrollLeft = (atMs / 1000) * next - x;
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [store, msAt]);

  // Keep the playhead in view while playing.
  useEffect(() => {
    return store.subscribe(() => {
      const el = scrollRef.current;
      const s = store.getState();
      if (!el || !(s.playing || locked)) return;
      const x = (s.currentTimeMs / 1000) * s.zoomPxPerSec;
      const w = el.clientWidth - HEAD;
      if (x < el.scrollLeft || x > el.scrollLeft + w - 40) {
        el.scrollLeft = Math.max(0, x - w * 0.2);
      }
    });
  }, [store, locked]);

  const seekTo = (clientX: number) => {
    const s = store.getState();
    store.dispatch({
      type: "seek",
      timeMs: snapTime(msAt(clientX), s.snap, s.show.audio.durationMs),
    });
  };

  // Scrub: press on the ruler or an empty part of a track and drag.
  const onScrubDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || locked) return;
    if ((e.target as HTMLElement).closest("[data-clip]")) return;
    store.dispatch({ type: "select", selection: null });
    seekTo(e.clientX);
    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => seekTo(ev.clientX);
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  const onClipDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || locked) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-clip]");
    const id = el?.dataset.clip;
    const clip = clips.find((c) => c.id === id);
    if (!clip) return;
    e.stopPropagation();
    store.dispatch({
      type: "select",
      selection: { kind: "clip", id: clip.id },
    });
    if (!editable) return;
    const edge = (e.target as HTMLElement).dataset.edge;
    drag.current = {
      id: clip.id,
      mode: edge === "start" ? "start" : edge === "end" ? "end" : "move",
      x: e.clientX,
      y: e.clientY,
      original: clip,
      gesture: newId("drag"),
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onClipMove = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_PX) {
      return;
    }
    d.moved = true;
    const s = store.getState();
    const deltaMs = ((e.clientX - d.x) / pps) * 1000;
    let { startMs, endMs } = dragClipTiming(
      d.original,
      d.mode,
      deltaMs,
      s.snap,
      s.show.audio.durationMs,
    );
    // Magnetic edges: other clips and the playhead.
    const targets = [s.currentTimeMs];
    for (const c of s.show.clips) {
      if (c.id !== d.id) targets.push(c.startMs, c.endMs);
    }
    const tolerance = (MAGNET_PX / pps) * 1000;
    if (d.mode === "move") {
      const length = endMs - startMs;
      const a = snapToTargets(startMs, targets, tolerance);
      const b = snapToTargets(endMs, targets, tolerance);
      if (
        a !== null &&
        (b === null || Math.abs(a - startMs) <= Math.abs(b - endMs))
      ) {
        startMs = a;
      } else if (b !== null) {
        startMs = b - length;
      }
      startMs = Math.max(0, startMs);
      endMs = startMs + length;
    } else if (d.mode === "start") {
      const a = snapToTargets(startMs, targets, tolerance);
      if (a !== null && a < endMs) startMs = a;
    } else {
      const b = snapToTargets(endMs, targets, tolerance);
      if (b !== null && b > startMs) endMs = b;
    }
    const layer = d.mode === "move" ? layerAt(e.clientY) : d.original.layer;
    store.dispatch({
      type: "updateClip",
      id: d.id,
      patch: { startMs, endMs, layer },
      gesture: d.gesture,
    });
  };

  const onClipUp = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // A click (no drag) on a clip also moves the playhead into it.
    if (d && !d.moved) {
      const t = msAt(e.clientX);
      if (t >= d.original.startMs && t < d.original.endMs) {
        store.dispatch({ type: "seek", timeMs: t });
      }
    }
  };

  // Effects dragged in from the library.
  const onDragOver = (e: DragEvent<HTMLElement>) => {
    if (!editable || !draggingEffect) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const s = store.getState();
    const atMs = snapTime(msAt(e.clientX), s.snap, s.show.audio.durationMs);
    const layer = layerAt(e.clientY);
    const effect = effectById(draggingEffect);
    const lengthMs = effect?.tool ? 400 : guessLength(draggingEffect);
    setGhost((g) =>
      g && g.layer === layer && g.atMs === atMs ? g : { layer, atMs, lengthMs },
    );
  };
  const onDrop = (e: DragEvent<HTMLElement>) => {
    const id = (e.dataTransfer.getData(EFFECT_MIME) ||
      draggingEffect) as EffectId | null;
    setGhost(null);
    draggingEffect = null;
    if (!editable || !id) return;
    e.preventDefault();
    addEffect(store, id, toast, msAt(e.clientX), layerAt(e.clientY));
  };

  return (
    <section
      className={styles.timeline}
      aria-label="Timeline"
      data-locked={locked || undefined}
    >
      <TimelineToolbar
        locked={locked}
        readOnly={readOnly}
        toast={toast}
        onFit={fit}
      />
      <div
        ref={scrollRef}
        className={styles.scroll}
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node))
            setGhost(null);
        }}
        onDrop={onDrop}
      >
        <div className={styles.content} style={{ width: HEAD + contentPx }}>
          <div className={styles.rulerRow}>
            <div className={styles.head} />
            <div
              className={styles.ruler}
              style={{ width: contentPx }}
              onPointerDown={onScrubDown}
            >
              <Ruler view={view} pps={pps} lengthMs={lengthMs} />
            </div>
          </div>
          <div data-tracks>
            {layers.map((layer) => {
              const rowClips = byLayer.get(layer) ?? [];
              const isNew = layer === topLayer + 1;
              return (
                <div key={layer} className={styles.row}>
                  <div className={styles.head}>
                    {isNew && clips.length ? "New track" : `Track ${layer + 1}`}
                  </div>
                  <div
                    className={styles.lane}
                    style={{ width: contentPx }}
                    onPointerDown={onScrubDown}
                    data-empty={isNew || undefined}
                  >
                    {isNew && editable ? (
                      <span
                        className={styles.laneHint}
                        style={{ left: view.left + 16 }}
                      >
                        {clips.length
                          ? "Drop an effect here for a new track"
                          : "Drag an effect here, or click one to add it at the playhead"}
                      </span>
                    ) : null}
                    {rowClips.map((c) => (
                      <ClipBlock
                        key={c.id}
                        clip={c}
                        pps={pps}
                        selected={c.id === selectedId}
                        editable={editable}
                        onPointerDown={onClipDown}
                        onPointerMove={onClipMove}
                        onPointerUp={onClipUp}
                      />
                    ))}
                    {ghost && ghost.layer === layer ? (
                      <div
                        className={styles.ghost}
                        style={{
                          left: (ghost.atMs / 1000) * pps,
                          width: Math.max(12, (ghost.lengthMs / 1000) * pps),
                        }}
                      />
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
          <div className={styles.audioRow}>
            <div className={styles.head}>♪ Music</div>
            <div
              className={styles.audioLane}
              style={{ width: contentPx }}
              onPointerDown={onScrubDown}
            >
              {fileId ? (
                <Waveform audio={audio} view={view} pps={pps} />
              ) : (
                <span
                  className={styles.laneHint}
                  style={{ left: view.left + 16 }}
                >
                  No music
                </span>
              )}
            </div>
          </div>
          <Playhead pps={pps} />
        </div>
      </div>
    </section>
  );
}

/** A ghost's length while dragging: what the effect will add. */
function guessLength(id: EffectId): number {
  switch (id) {
    case "flash":
      return 400;
    case "pulse":
    case "chase":
      return 4000;
    case "strobe":
      return 2000;
    case "wave":
    case "split":
      return 1500;
    default:
      return 4000;
  }
}

const ClipBlock = memo(function ClipBlock({
  clip,
  pps,
  selected,
  editable,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: {
  clip: Clip;
  pps: number;
  selected: boolean;
  editable: boolean;
  onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLElement>) => void;
}) {
  const length = clip.endMs - clip.startMs;
  const width = Math.max(4, (length / 1000) * pps);
  const label = clipKindLabel(clip);
  const fadeIn = Math.min(1, clip.fadeInMs / length) * 100;
  const fadeOut = Math.min(1, clip.fadeOutMs / length) * 100;
  return (
    <div
      data-clip={clip.id}
      data-testid="clip-bar"
      className={styles.clip}
      data-selected={selected || undefined}
      title={`${label} · ${formatTime(clip.startMs)} to ${formatTime(clip.endMs)}`}
      style={{
        left: (clip.startMs / 1000) * pps,
        width,
        background: clip.color,
        color: contrastText(clip.color),
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {fadeIn > 0 ? (
        <i className={styles.fadeIn} style={{ width: `${fadeIn}%` }} />
      ) : null}
      {fadeOut > 0 ? (
        <i className={styles.fadeOut} style={{ width: `${fadeOut}%` }} />
      ) : null}
      {width > 40 ? (
        <span className={styles.clipLabel}>
          <ClipIcon clip={clip} />
          {width > 64 ? label : null}
        </span>
      ) : null}
      {editable && width > 14 ? (
        <>
          <b className={styles.edge} data-edge="start" />
          <b className={styles.edge} data-edge="end" />
        </>
      ) : null}
    </div>
  );
});

function Playhead({ pps }: { pps: number }) {
  const time = useEditorSelector((s) => s.currentTimeMs);
  return (
    <div
      className={styles.playhead}
      style={{ transform: `translateX(${HEAD + (time / 1000) * pps}px)` }}
    />
  );
}

/** Canvas the size of the visible part of a lane, redrawn on scroll and zoom. */
function useLaneCanvas(
  view: { left: number; width: number },
  height: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || view.width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(view.width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${view.width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, view.width, height);
    draw(ctx, view.width, height);
  });
  return ref;
}

function Ruler({
  view,
  pps,
  lengthMs,
}: {
  view: { left: number; width: number };
  pps: number;
  lengthMs: number;
}) {
  const snap = useEditorSelector((s) => s.snap);
  const ref = useLaneCanvas(view, 26, (ctx, w) => {
    const ticks = timelineTicks(snap, pps);
    const step = ticks.tickMs;
    const first = Math.floor(((view.left / pps) * 1000) / step) * step;
    ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.textBaseline = "top";
    let i = Math.round(first / step);
    for (let t = first; ; t += step, i++) {
      const x = (t / 1000) * pps - view.left;
      if (x > w) break;
      const major = i % ticks.labelEvery === 0;
      ctx.fillStyle =
        t > lengthMs ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.3)";
      ctx.fillRect(Math.round(x), major ? 16 : 20, 1, major ? 10 : 6);
      if (major) {
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.fillText(formatTime(t).replace(/\.0+$/, ""), Math.round(x) + 4, 4);
      }
    }
  });
  return (
    <canvas
      ref={ref}
      className={styles.laneCanvas}
      style={{ left: view.left }}
    />
  );
}

function Waveform({
  audio,
  view,
  pps,
}: {
  audio: DecodedAudio | null;
  view: { left: number; width: number };
  pps: number;
}) {
  const time = useEditorSelector((s) => Math.floor(s.currentTimeMs / 100));
  const ref = useLaneCanvas(view, 52, (ctx, w, h) => {
    if (!audio) {
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.font = "12px Inter, system-ui, sans-serif";
      ctx.fillText("Loading music…", 16, h / 2 + 4);
      return;
    }
    const played = (time * 100 * pps) / 1000 - view.left;
    for (let x = 0; x < w; x += 3) {
      const fromMs = ((view.left + x) / pps) * 1000;
      const toMs = ((view.left + x + 3) / pps) * 1000;
      let peak = 0;
      for (
        let b = Math.floor(fromMs / PEAK_MS);
        b < Math.min(audio.peaks.length, Math.ceil(toMs / PEAK_MS));
        b++
      ) {
        peak = Math.max(peak, audio.peaks[b]!);
      }
      if (peak <= 0) continue;
      const bar = Math.max(1, peak * (h - 8));
      ctx.fillStyle =
        x < played ? "rgba(255,255,255,0.62)" : "rgba(255,255,255,0.26)";
      ctx.fillRect(x, (h - bar) / 2, 2, bar);
    }
  });
  return (
    <canvas
      ref={ref}
      className={styles.laneCanvas}
      style={{ left: view.left }}
    />
  );
}
