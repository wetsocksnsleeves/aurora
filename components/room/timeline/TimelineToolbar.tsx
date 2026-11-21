"use client";

import { useState } from "react";
import {
  formatTime,
  isValidBpm,
  MAX_BPM,
  MIN_BPM,
} from "@/components/editor/snap";
import {
  MAX_ZOOM_PX_PER_SEC,
  MIN_ZOOM_PX_PER_SEC,
} from "@/components/editor/store";
import {
  useEditorSelector,
  useEditorStore,
} from "@/components/editor/store-context";
import { showDurationMs } from "@/lib/compile";
import {
  deleteSelected,
  duplicateSelected,
  splitSelected,
  type Toast,
} from "../edit-actions";
import { Icon, type IconName } from "../icons";
import styles from "./timeline.module.css";

/** Undo, editing, play, time, snapping and zoom, above the tracks. */
export function TimelineToolbar({
  locked,
  readOnly,
  toast,
  onFit,
}: {
  locked: boolean;
  readOnly: boolean;
  toast: Toast;
  onFit: () => void;
}) {
  const store = useEditorStore();
  const canUndo = useEditorSelector((s) => s.past.length > 0);
  const canRedo = useEditorSelector((s) => s.future.length > 0);
  const hasSelection = useEditorSelector((s) => s.selection?.kind === "clip");
  const playing = useEditorSelector((s) => s.playing);
  const editable = !locked && !readOnly;

  const button = (
    icon: IconName,
    label: string,
    keys: string,
    onClick: () => void,
    enabled: boolean,
  ) => (
    <button
      type="button"
      className={styles.icon}
      aria-label={label}
      title={`${label} (${keys})`}
      disabled={!enabled}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );

  return (
    <div className={styles.toolbar}>
      {button(
        "undo",
        "Undo",
        "⌘Z",
        () => store.dispatch({ type: "undo" }),
        editable && canUndo,
      )}
      {button(
        "redo",
        "Redo",
        "⇧⌘Z",
        () => store.dispatch({ type: "redo" }),
        editable && canRedo,
      )}
      <span className={styles.sep} />
      {button(
        "cut",
        "Split at playhead",
        "S",
        () => splitSelected(store, toast),
        editable && hasSelection,
      )}
      {button(
        "duplicate",
        "Duplicate",
        "⌘D",
        () => duplicateSelected(store, toast),
        editable && hasSelection,
      )}
      {button(
        "delete",
        "Delete",
        "⌫",
        () => deleteSelected(store, toast),
        editable && hasSelection,
      )}
      <span className={styles.sep} />
      {locked ? null : (
        <button
          type="button"
          className={styles.play}
          aria-label={playing ? "Pause" : "Play"}
          title="Play / pause (Space)"
          onClick={() =>
            store.dispatch({ type: "setPlaying", playing: !playing })
          }
        >
          {playing ? (
            <span className={styles.pauseGlyph} />
          ) : (
            <span className={styles.playGlyph} />
          )}
        </button>
      )}
      <TimeReadout />
      <span className={styles.spacer} />
      {readOnly ? null : <SnapControl />}
      <span className={styles.sep} />
      <Zoom onFit={onFit} />
      <Shortcuts />
    </div>
  );
}

function TimeReadout() {
  const time = useEditorSelector((s) => s.currentTimeMs);
  const length = useEditorSelector((s) => showDurationMs(s.show));
  return (
    <span className={styles.time} aria-label="Playhead time">
      {formatTime(time).replace(/(\.\d)\d+$/, "$1")}
      <span> / {formatTime(length).replace(/\.\d+$/, "")}</span>
    </span>
  );
}

/** Snap on or off, to beats (with a BPM) or tenths of a second. */
function SnapControl() {
  const store = useEditorStore();
  const snap = useEditorSelector((s) => s.snap);
  const [lastMode, setLastMode] = useState<"beat" | "100ms">(
    snap.mode === "beat" ? "beat" : "100ms",
  );
  const on = snap.mode !== "off";
  const mode =
    snap.mode === "off" ? lastMode : snap.mode === "beat" ? "beat" : "100ms";
  const set = (patch: Parameters<typeof store.dispatch>[0]) =>
    store.dispatch(patch);
  return (
    <span className={styles.snap}>
      <button
        type="button"
        className={styles.icon}
        aria-pressed={on}
        aria-label="Snap"
        title="Snap clips to the grid, the playhead and each other"
        onClick={() =>
          set({ type: "setSnap", snap: { mode: on ? "off" : lastMode } })
        }
      >
        <Icon name="magnet" />
      </button>
      <select
        aria-label="Snap to"
        value={mode}
        disabled={!on}
        onChange={(e) => {
          const next = e.target.value as "beat" | "100ms";
          setLastMode(next);
          set({ type: "setSnap", snap: { mode: next } });
        }}
      >
        <option value="beat">Beats</option>
        <option value="100ms">0.1 s</option>
      </select>
      {mode === "beat" ? (
        <label className={styles.bpm} title="Tempo of the music">
          <input
            type="number"
            min={MIN_BPM}
            max={MAX_BPM}
            step="any"
            placeholder="120"
            value={snap.bpm ?? ""}
            onChange={(e) =>
              set({
                type: "setSnap",
                snap: {
                  bpm: e.target.value === "" ? null : Number(e.target.value),
                },
              })
            }
          />
          BPM
        </label>
      ) : null}
      {mode === "beat" && on && !isValidBpm(snap.bpm) ? (
        <span className={styles.warn}>Set the BPM</span>
      ) : null}
    </span>
  );
}

function Zoom({ onFit }: { onFit: () => void }) {
  const store = useEditorStore();
  const zoom = useEditorSelector((s) => s.zoomPxPerSec);
  const min = Math.log2(MIN_ZOOM_PX_PER_SEC);
  const max = Math.log2(MAX_ZOOM_PX_PER_SEC);
  const set = (v: number) =>
    store.dispatch({
      type: "setZoom",
      pxPerSec: Math.max(MIN_ZOOM_PX_PER_SEC, Math.min(MAX_ZOOM_PX_PER_SEC, v)),
    });
  return (
    <span className={styles.zoom}>
      <button
        type="button"
        className={styles.icon}
        aria-label="Zoom out"
        onClick={() => set(zoom / 1.5)}
      >
        −
      </button>
      <input
        type="range"
        aria-label="Zoom"
        min={min}
        max={max}
        step={0.05}
        value={Math.log2(zoom)}
        onChange={(e) => set(2 ** Number(e.target.value))}
      />
      <button
        type="button"
        className={styles.icon}
        aria-label="Zoom in"
        onClick={() => set(zoom * 1.5)}
      >
        +
      </button>
      <button
        type="button"
        className={styles.icon}
        aria-label="Fit the show"
        title="Fit the whole show"
        onClick={onFit}
      >
        <Icon name="fit" />
      </button>
    </span>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Space", "Play / pause"],
  ["S", "Split at the playhead"],
  ["⌘D", "Duplicate"],
  ["⌘C / ⌘V", "Copy / paste at the playhead"],
  ["⌫", "Delete"],
  ["⌘Z / ⇧⌘Z", "Undo / redo"],
  ["← →", "Step the playhead"],
  ["⌘ scroll", "Zoom the timeline"],
  ["Esc", "Deselect, stop drawing"],
];

function Shortcuts() {
  const [open, setOpen] = useState(false);
  return (
    <span className={styles.shortcuts}>
      <button
        type="button"
        className={styles.icon}
        aria-label="Keyboard shortcuts"
        aria-expanded={open}
        title="Keyboard shortcuts"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="keys" />
      </button>
      {open ? (
        <>
          <div className={styles.backdrop} onClick={() => setOpen(false)} />
          <div
            className={styles.keysPanel}
            role="dialog"
            aria-label="Keyboard shortcuts"
          >
            {SHORTCUTS.map(([keys, what]) => (
              <div key={keys}>
                <kbd>{keys}</kbd>
                <span>{what}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </span>
  );
}
