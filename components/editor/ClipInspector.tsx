"use client";

import { useState } from "react";
import { clipKindLabel, type ClipPatch } from "./clips";
import { useEditorSelector, useEditorStore } from "./store-context";
import styles from "./editor.module.css";

const SWATCHES = [
  "#ffffff",
  "#ff2d2d",
  "#ff9f1a",
  "#ffe600",
  "#2dff6a",
  "#2d8bff",
  "#b02dff",
  "#ff2dc8",
];

/**
 * Side panel: the colour for new clips, and the selected clip's colour,
 * times, fades and layer.
 */
export function ClipInspector() {
  return (
    <aside className={styles.inspector} aria-label="Clip inspector">
      <NewClipColor />
      <SelectedClip />
    </aside>
  );
}

function ColorPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <div className={styles.colorPicker}>
      <label className={styles.field}>
        <span>{label}</span>
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value.toLowerCase())}
        />
      </label>
      <div className={styles.swatches}>
        {SWATCHES.map((color) => (
          <button
            key={color}
            type="button"
            className={`${styles.swatch} ${color === value ? styles.swatchActive : ""}`}
            style={{ background: color }}
            aria-label={`${label} ${color}`}
            onClick={() => onChange(color)}
          />
        ))}
      </div>
    </div>
  );
}

function NewClipColor() {
  const store = useEditorStore();
  const color = useEditorSelector((s) => s.clipColor);
  return (
    <section className={styles.inspectorSection}>
      <h2 className={styles.inspectorTitle}>New clips</h2>
      <ColorPicker
        label="Colour"
        value={color}
        onChange={(c) => store.dispatch({ type: "setClipColor", color: c })}
      />
    </section>
  );
}

function SelectedClip() {
  const store = useEditorStore();
  const clip = useEditorSelector((s) => {
    const sel = s.selection;
    if (sel?.kind !== "clip") return null;
    return s.show.clips.find((c) => c.id === sel.id) ?? null;
  });
  if (!clip) {
    return (
      <section className={styles.inspectorSection}>
        <h2 className={styles.inspectorTitle}>Clip</h2>
        <p className={styles.inspectorEmpty}>
          Draw with a clip tool, or click a clip on the timeline.
        </p>
      </section>
    );
  }
  const update = (patch: ClipPatch) =>
    store.dispatch({ type: "updateClip", id: clip.id, patch });
  return (
    <section className={styles.inspectorSection} data-testid="clip-inspector">
      <h2 className={styles.inspectorTitle}>{clipKindLabel(clip)} clip</h2>
      <ColorPicker
        label="Clip colour"
        value={clip.color}
        onChange={(color) => {
          update({ color });
          store.dispatch({ type: "setClipColor", color });
        }}
      />
      <NumberField
        label="Start (s)"
        value={round3(clip.startMs / 1000)}
        min={0}
        step={0.1}
        onCommit={(s) => update({ startMs: Math.round(s * 1000) })}
      />
      <NumberField
        label="End (s)"
        value={round3(clip.endMs / 1000)}
        min={0}
        step={0.1}
        onCommit={(s) => update({ endMs: Math.round(s * 1000) })}
      />
      <NumberField
        label="Fade in (ms)"
        value={clip.fadeInMs}
        min={0}
        step={50}
        onCommit={(ms) => update({ fadeInMs: Math.round(ms) })}
      />
      <NumberField
        label="Fade out (ms)"
        value={clip.fadeOutMs}
        min={0}
        step={50}
        onCommit={(ms) => update({ fadeOutMs: Math.round(ms) })}
      />
      <div className={styles.field}>
        <span>Layer {clip.layer}</span>
        <span className={styles.layerButtons}>
          <button
            type="button"
            className={styles.button}
            onClick={() =>
              store.dispatch({
                type: "moveClipLayer",
                id: clip.id,
                direction: -1,
              })
            }
          >
            Down
          </button>
          <button
            type="button"
            className={styles.button}
            onClick={() =>
              store.dispatch({
                type: "moveClipLayer",
                id: clip.id,
                direction: 1,
              })
            }
          >
            Up
          </button>
        </span>
      </div>
      <button
        type="button"
        className={styles.button}
        onClick={() => store.dispatch({ type: "deleteClip", id: clip.id })}
      >
        Delete clip
      </button>
    </section>
  );
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * A number input that commits on blur or Enter, so half-typed values do not
 * reach the store (where they would be clamped while typing).
 */
function NumberField({
  label,
  value,
  min,
  step,
  onCommit,
}: {
  label: string;
  value: number;
  min?: number;
  step?: number;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const commit = () => {
    if (text !== null && text.trim() !== "") {
      const n = Number(text);
      if (Number.isFinite(n)) onCommit(n);
    }
    setText(null);
  };
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input
        type="number"
        className={styles.numberInput}
        value={text ?? String(value)}
        min={min}
        step={step}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setText(null);
        }}
      />
    </label>
  );
}
