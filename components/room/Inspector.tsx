"use client";

import { useRef, useState, type ReactNode } from "react";
import { clipKindLabel, type ClipPatch } from "@/components/editor/clips";
import { formatTime } from "@/components/editor/snap";
import { newId } from "@/components/editor/store";
import {
  useEditorSelector,
  useEditorStore,
} from "@/components/editor/store-context";
import type { StateCounts } from "@/lib/host-map";
import type { Clip, Direction, PatternShape } from "@/lib/types";
import {
  beatMs,
  deleteSelected,
  duplicateSelected,
  splitSelected,
  type Toast,
} from "./edit-actions";
import { SWATCHES } from "./effects";
import { ClipIcon } from "./icons";
import { pickMusic } from "./music";
import styles from "./room.module.css";

/**
 * The right panel: who is ready, then the selected clip's settings, or the
 * show's when nothing is selected.
 */
export function Inspector({
  counts,
  playing,
  readOnly,
  toast,
}: {
  counts: StateCounts;
  playing: boolean;
  readOnly: boolean;
  toast: Toast;
}) {
  const clip = useEditorSelector((s) => {
    const sel = s.selection;
    if (sel?.kind !== "clip") return null;
    return s.show.clips.find((c) => c.id === sel.id) ?? null;
  });
  const finding =
    counts.total - counts.disconnected - counts.standby - counts.playing;
  return (
    <aside className={styles.side}>
      <section className={styles.crowdCard} aria-label="Crowd">
        <div className={styles.crowdStat} data-testid="ready-count">
          {playing ? counts.playing : counts.standby}
          <small>{playing ? "playing" : "ready"}</small>
        </div>
        <span className={styles.note}>
          {counts.total === 0
            ? "Nobody yet"
            : finding > 0
              ? `${finding} finding seats`
              : "Everyone is ready"}
        </span>
      </section>
      {playing ? (
        <p className={styles.note}>Stop the show to edit.</p>
      ) : readOnly ? (
        <p className={styles.note}>
          Test shows can’t be edited. Pick New show to make your own.
        </p>
      ) : clip ? (
        <ClipPanel clip={clip} toast={toast} />
      ) : (
        <ShowPanel toast={toast} />
      )}
    </aside>
  );
}

/** Edits from one slider drag undo as one step. */
function useGesture(): { start: () => void; id: () => string } {
  const ref = useRef("");
  return {
    start: () => {
      ref.current = newId("edit");
    },
    id: () => ref.current || (ref.current = newId("edit")),
  };
}

function Field({
  label,
  value,
  children,
}: {
  label: string;
  value?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={styles.field}>
      <div className={styles.fieldRow}>
        <span>{label}</span>
        {value !== undefined ? (
          <span className={styles.dim}>{value}</span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function Slider({
  min,
  max,
  step,
  value,
  onChange,
  label,
}: {
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number, gesture: string) => void;
  label: string;
}) {
  const gesture = useGesture();
  return (
    <input
      type="range"
      className={styles.slider}
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      onPointerDown={gesture.start}
      onKeyDown={gesture.start}
      onChange={(e) => onChange(Number(e.target.value), gesture.id())}
    />
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: [T, string, string?][];
  value: T;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className={styles.segmented} role="group" aria-label={label}>
      {options.map(([v, text, title]) => (
        <button
          key={v}
          type="button"
          aria-pressed={v === value}
          title={title}
          onClick={() => onChange(v)}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

const seconds = (ms: number) =>
  ms >= 10_000 ? `${(ms / 1000).toFixed(0)} s` : `${(ms / 1000).toFixed(1)} s`;

/** Log scale for lengths: equal steps feel like equal changes. */
const LOG_MIN = Math.log(100);
const LOG_MAX = Math.log(60_000);

function ClipPanel({ clip, toast }: { clip: Clip; toast: Toast }) {
  const store = useEditorStore();
  const update = (patch: ClipPatch, gesture?: string) =>
    store.dispatch({ type: "updateClip", id: clip.id, patch, gesture });
  const length = clip.endMs - clip.startMs;
  const shape = clip.shape;
  const pattern = shape.kind === "pattern" ? shape : null;
  const setPattern = (patch: Partial<PatternShape>, gesture?: string) =>
    pattern && update({ shape: { ...pattern, ...patch } }, gesture);

  return (
    <div className={styles.clipPanel}>
      <div className={styles.panelTitle}>
        <span>
          <ClipIcon clip={clip} />
          {clipKindLabel(clip)}
        </span>
        <span className={styles.dim}>
          {formatTime(clip.startMs).replace(/\.\d+$/, "")} to{" "}
          {formatTime(clip.endMs).replace(/\.\d+$/, "")}
        </span>
      </div>

      <Field label="Colour">
        <div className={styles.swatchRow}>
          {SWATCHES.map((c) => (
            <button
              key={c}
              type="button"
              style={{ background: c }}
              aria-label={`Colour ${c}`}
              aria-pressed={c === clip.color}
              onClick={() => {
                update({ color: c });
                store.dispatch({ type: "setClipColor", color: c });
              }}
            />
          ))}
          <label className={styles.customColor} title="Any colour">
            <input
              type="color"
              value={clip.color}
              onChange={(e) =>
                update(
                  { color: e.target.value.toLowerCase() },
                  `color-${clip.id}`,
                )
              }
            />
          </label>
        </div>
      </Field>

      {pattern ? (
        <PatternFields pattern={pattern} setPattern={setPattern} />
      ) : null}

      <BlinkFields clip={clip} update={update} />

      <Field label="Length" value={seconds(length)}>
        <Slider
          label="Length"
          min={LOG_MIN}
          max={LOG_MAX}
          step={0.01}
          value={Math.log(Math.max(100, length))}
          onChange={(v, g) =>
            update({ endMs: clip.startMs + Math.round(Math.exp(v)) }, g)
          }
        />
      </Field>

      <div className={styles.pair}>
        <Field label="Fade in" value={seconds(clip.fadeInMs)}>
          <Slider
            label="Fade in"
            min={0}
            max={Math.min(5000, length)}
            step={10}
            value={clip.fadeInMs}
            onChange={(v, g) => update({ fadeInMs: v }, g)}
          />
        </Field>
        <Field label="Fade out" value={seconds(clip.fadeOutMs)}>
          <Slider
            label="Fade out"
            min={0}
            max={Math.min(5000, length)}
            step={10}
            value={clip.fadeOutMs}
            onChange={(v, g) => update({ fadeOutMs: v }, g)}
          />
        </Field>
      </div>

      <div className={styles.actionsRow}>
        <button
          type="button"
          className={styles.ghost}
          onClick={() => duplicateSelected(store, toast)}
        >
          Duplicate
        </button>
        <button
          type="button"
          className={styles.ghost}
          onClick={() => splitSelected(store, toast)}
        >
          Split
        </button>
        <button
          type="button"
          className={styles.ghost}
          onClick={() => deleteSelected(store, toast)}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

const ARROWS: [Direction, string, string][] = [
  ["left", "←", "Right to left"],
  ["right", "→", "Left to right"],
  ["up", "↑", "Back to the screen"],
  ["down", "↓", "Screen to the back"],
];

function PatternFields({
  pattern,
  setPattern,
}: {
  pattern: PatternShape;
  setPattern: (patch: Partial<PatternShape>, gesture?: string) => void;
}) {
  const { direction } = pattern;
  switch (pattern.pattern) {
    case "wave":
    case "chase":
      return (
        <>
          <Field label="Direction">
            <Segmented
              label="Direction"
              options={ARROWS}
              value={direction}
              onChange={(d) => setPattern({ direction: d })}
            />
          </Field>
          {pattern.pattern === "wave" ? (
            <Field label="Width" value={`${Math.round(pattern.size * 100)}%`}>
              <Slider
                label="Width"
                min={0.05}
                max={1}
                step={0.01}
                value={pattern.size}
                onChange={(v, g) => setPattern({ size: v }, g)}
              />
            </Field>
          ) : (
            <>
              <Field label="Columns" value={Math.round(1 / pattern.size)}>
                <Slider
                  label="Columns"
                  min={2}
                  max={10}
                  step={1}
                  value={Math.round(1 / pattern.size)}
                  onChange={(v, g) => setPattern({ size: 1 / v }, g)}
                />
              </Field>
              <Field label="Step" value={seconds(pattern.stepMs)}>
                <Slider
                  label="Step"
                  min={60}
                  max={1500}
                  step={10}
                  value={pattern.stepMs}
                  onChange={(v, g) => setPattern({ stepMs: v }, g)}
                />
              </Field>
            </>
          )}
        </>
      );
    case "split": {
      const across = direction === "left" || direction === "right";
      const out = direction === "right" || direction === "down";
      const set = (a: boolean, o: boolean) =>
        setPattern({
          direction: a ? (o ? "right" : "left") : o ? "down" : "up",
        });
      return (
        <>
          <Field label="Direction">
            <div className={styles.pair}>
              <Segmented
                label="Out or in"
                options={[
                  ["out", "Out", "From the middle out"],
                  ["in", "In", "From the edges in"],
                ]}
                value={out ? "out" : "in"}
                onChange={(v) => set(across, v === "out")}
              />
              <Segmented
                label="Across or front to back"
                options={[
                  ["across", "↔", "Across the room"],
                  ["depth", "↕", "Front to back"],
                ]}
                value={across ? "across" : "depth"}
                onChange={(v) => set(v === "across", out)}
              />
            </div>
          </Field>
          <Field label="Width" value={`${Math.round(pattern.size * 100)}%`}>
            <Slider
              label="Width"
              min={0.05}
              max={1}
              step={0.01}
              value={pattern.size}
              onChange={(v, g) => setPattern({ size: v }, g)}
            />
          </Field>
        </>
      );
    }
    case "sparkle":
      return (
        <>
          <Field label="Amount" value={`${Math.round(pattern.size * 100)}%`}>
            <Slider
              label="Amount"
              min={0.02}
              max={0.8}
              step={0.01}
              value={pattern.size}
              onChange={(v, g) => setPattern({ size: v }, g)}
            />
          </Field>
          <Field label="Twinkle" value={seconds(pattern.stepMs)}>
            <Slider
              label="Twinkle"
              min={60}
              max={1500}
              step={10}
              value={pattern.stepMs}
              onChange={(v, g) => setPattern({ stepMs: v }, g)}
            />
          </Field>
        </>
      );
  }
}

/** Blink on any clip: hard (strobe) or soft (pulse), and how fast. */
function BlinkFields({
  clip,
  update,
}: {
  clip: Clip;
  update: (patch: ClipPatch, gesture?: string) => void;
}) {
  const store = useEditorStore();
  const blink = clip.blink;
  const mode = !blink ? "off" : blink.soft ? "pulse" : "strobe";
  return (
    <>
      <Field label="Blink">
        <Segmented
          label="Blink"
          options={[
            ["off", "Steady"],
            ["strobe", "Strobe", "Hard on and off"],
            ["pulse", "Pulse", "A hit that fades each time"],
          ]}
          value={mode}
          onChange={(m) => {
            if (m === "off") {
              update({ blink: undefined });
              return;
            }
            update({
              blink: {
                periodMs:
                  blink?.periodMs ?? (m === "strobe" ? 120 : beatMs(store)),
                duty: 0.5,
                soft: m === "pulse",
              },
            });
          }}
        />
      </Field>
      {blink ? (
        <Field
          label="Speed"
          value={`${(1000 / blink.periodMs).toFixed(1)} per second`}
        >
          <Slider
            label="Blink speed"
            min={40}
            max={2000}
            step={10}
            value={blink.periodMs}
            onChange={(v, g) => update({ blink: { ...blink, periodMs: v } }, g)}
          />
        </Field>
      ) : null}
    </>
  );
}

function ShowPanel({ toast }: { toast: Toast }) {
  const store = useEditorStore();
  const fileId = useEditorSelector((s) => s.show.audio.fileId);
  const durationMs = useEditorSelector((s) => s.show.audio.durationMs);
  const status = useEditorSelector((s) => s.audioStatus);
  const error = useEditorSelector((s) => s.audioError);
  const gesture = useGesture();
  const [lengthText, setLengthText] = useState<string | null>(null);
  return (
    <div className={styles.clipPanel}>
      <p className={styles.label}>Show</p>
      <Field
        label="Music"
        value={
          !fileId
            ? "None yet"
            : status === "uploading"
              ? "Uploading…"
              : status === "loading"
                ? "Loading…"
                : status === "error"
                  ? "Couldn’t load"
                  : formatTime(durationMs).replace(/\.\d+$/, "")
        }
      >
        <button
          type="button"
          className={fileId ? styles.ghost : styles.primary}
          onClick={() => pickMusic(store, toast)}
        >
          {fileId ? "Replace music" : "Add music"}
        </button>
        {status === "error" && error ? (
          <p className={styles.error}>{error}</p>
        ) : null}
      </Field>
      {fileId ? null : (
        <Field
          label="Length"
          value={formatTime(durationMs).replace(/\.\d+$/, "")}
        >
          <input
            type="range"
            className={styles.slider}
            aria-label="Show length"
            min={5}
            max={600}
            step={5}
            value={lengthText ?? Math.round(durationMs / 1000)}
            onPointerDown={gesture.start}
            onChange={(e) => {
              setLengthText(e.target.value);
              store.dispatch({
                type: "setShowLength",
                durationMs: Number(e.target.value) * 1000,
              });
            }}
            onPointerUp={() => setLengthText(null)}
          />
        </Field>
      )}
    </div>
  );
}
