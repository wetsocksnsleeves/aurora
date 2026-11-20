"use client";

import { useMemo, useRef, type PointerEvent, type RefObject } from "react";
import type { Clip } from "@/lib/types";
import {
  clipKindLabel,
  contrastText,
  dragClipTiming,
  laneRows,
  type ClipDragMode,
} from "./clips";
import { useEditorSelector, useEditorStore } from "./store-context";
import styles from "./editor.module.css";

const ROW_PX = 22;
/** Ignore pointer jitter below this before treating a press as a drag. */
const DRAG_THRESHOLD_PX = 3;

type Drag = {
  id: string;
  mode: ClipDragMode;
  startX: number;
  original: Pick<Clip, "startMs" | "endMs">;
  msPerPx: number;
  moved: boolean;
};

/**
 * Clips as bars under the waveform. `contentRef` is the element the bars are
 * positioned in; Timeline.tsx sizes it to the waveform's scroll width and
 * shifts it with the waveform's scroll, so bars line up with the audio at any
 * zoom. Click selects, drag moves, the edge handles change start and end,
 * all snapped to the grid. Overlapping clips stack by layer, top layer
 * highest.
 */
export function ClipLane({
  contentRef,
}: {
  contentRef: RefObject<HTMLDivElement | null>;
}) {
  const store = useEditorStore();
  const clips = useEditorSelector((s) => s.show.clips);
  const durationMs = useEditorSelector((s) => s.show.audio.durationMs);
  const selectedId = useEditorSelector((s) =>
    s.selection?.kind === "clip" ? s.selection.id : null,
  );
  const { rows, count } = useMemo(() => laneRows(clips), [clips]);
  const drag = useRef<Drag | null>(null);
  const rowCount = Math.max(1, count);

  const onPointerDown = (e: PointerEvent<HTMLElement>, clip: Clip) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    store.dispatch({
      type: "select",
      selection: { kind: "clip", id: clip.id },
    });
    const width = contentRef.current?.getBoundingClientRect().width ?? 0;
    if (width <= 0 || durationMs <= 0) return;
    const handle = (e.target as HTMLElement).dataset.handle;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      id: clip.id,
      mode: handle === "start" || handle === "end" ? handle : "move",
      startX: e.clientX,
      original: { startMs: clip.startMs, endMs: clip.endMs },
      msPerPx: durationMs / width,
      moved: false,
    };
  };

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    if (!d.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    d.moved = true;
    const state = store.getState();
    const timing = dragClipTiming(
      d.original,
      d.mode,
      dx * d.msPerPx,
      state.snap,
      state.show.audio.durationMs,
    );
    store.dispatch({ type: "updateClip", id: d.id, patch: timing });
  };

  const onPointerUp = (e: PointerEvent<HTMLElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    drag.current = null;
  };

  if (durationMs <= 0) return null;

  return (
    <div
      className={styles.clipLane}
      style={{ height: rowCount * ROW_PX + 4 }}
      data-testid="clip-lane"
      onPointerDown={() => store.dispatch({ type: "select", selection: null })}
    >
      <div ref={contentRef} className={styles.clipLaneContent}>
        {clips.map((clip) => {
          const row = rows.get(clip.id) ?? 0;
          const selected = clip.id === selectedId;
          return (
            <div
              key={clip.id}
              className={`${styles.clipBar} ${selected ? styles.clipBarSelected : ""}`}
              style={{
                left: `${(clip.startMs / durationMs) * 100}%`,
                width: `${((clip.endMs - clip.startMs) / durationMs) * 100}%`,
                top: (rowCount - 1 - row) * ROW_PX + 2,
                height: ROW_PX - 3,
                background: clip.color,
                color: contrastText(clip.color),
              }}
              title={`${clipKindLabel(clip)} · layer ${clip.layer}`}
              data-testid="clip-bar"
              data-clip-id={clip.id}
              onPointerDown={(e) => onPointerDown(e, clip)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <span
                className={`${styles.clipHandle} ${styles.clipHandleStart}`}
                data-handle="start"
              />
              <span className={styles.clipLabel}>{clipKindLabel(clip)}</span>
              <span
                className={`${styles.clipHandle} ${styles.clipHandleEnd}`}
                data-handle="end"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
