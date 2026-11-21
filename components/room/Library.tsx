"use client";

import { useEffect, useRef, useState } from "react";
import {
  useEditorSelector,
  useEditorStore,
} from "@/components/editor/store-context";
import { colorAt } from "@/lib/compile";
import type { Show } from "@/lib/types";
import { addEffect, beatMs, type Toast } from "./edit-actions";
import {
  DEMO_IMAGE,
  EFFECTS,
  EFFECT_MIME,
  SWATCHES,
  effectClip,
  type Effect,
} from "./effects";
import { Icon } from "./icons";
import { createFromMusic, pickMusic } from "./music";
import { setDraggingEffect } from "./timeline/Timeline";
import type { DecodedAudio } from "./timeline/playback";
import styles from "./room.module.css";

/**
 * The left panel: make a show from the music, the effects (drag onto the
 * timeline, or click to add at the playhead), and the colour for new ones.
 */
export function Library({
  audio,
  disabled,
  toast,
}: {
  audio: DecodedAudio | null;
  disabled: boolean;
  toast: Toast;
}) {
  const store = useEditorStore();
  const color = useEditorSelector((s) => s.clipColor);
  const tool = useEditorSelector((s) => s.tool);
  const hasMusic = useEditorSelector((s) => s.show.audio.fileId !== "");
  const [creating, setCreating] = useState(false);

  const create = async () => {
    if (!hasMusic) {
      pickMusic(store, toast);
      return;
    }
    if (!audio) {
      toast("The music is still loading");
      return;
    }
    const clips = store.getState().show.clips.length;
    if (
      clips > 0 &&
      !window.confirm(
        `Replace the ${clips} clips in this show with a show made from the music? You can undo it.`,
      )
    ) {
      return;
    }
    setCreating(true);
    try {
      await createFromMusic(store, audio, toast);
    } finally {
      setCreating(false);
    }
  };

  return (
    <aside
      className={styles.library}
      aria-label="Effects"
      data-disabled={disabled || undefined}
    >
      <button
        type="button"
        className={styles.auto}
        disabled={disabled || creating}
        onClick={() => void create()}
      >
        <span className={styles.autoMark} aria-hidden />
        <span>
          <b>{creating ? "Creating…" : "Create from the music"}</b>
          <small>
            {hasMusic ? "A full show from the beat" : "Add music first"}
          </small>
        </span>
      </button>

      <p className={styles.label}>Effects</p>
      <EffectGrid
        color={color}
        disabled={disabled}
        activeTool={tool}
        onAdd={(e) => addEffect(store, e.id, toast)}
      />

      <p className={styles.label}>Colour</p>
      <div
        className={styles.libSwatches}
        role="group"
        aria-label="Colour for new effects"
      >
        {SWATCHES.map((c) => (
          <button
            key={c}
            type="button"
            style={{ background: c }}
            aria-label={`Colour ${c}`}
            aria-pressed={c === color}
            disabled={disabled}
            onClick={() => store.dispatch({ type: "setClipColor", color: c })}
          />
        ))}
        <label className={styles.customColor} title="Any colour">
          <input
            type="color"
            value={color}
            disabled={disabled}
            onChange={(e) =>
              store.dispatch({
                type: "setClipColor",
                color: e.target.value.toLowerCase(),
              })
            }
          />
        </label>
      </div>
    </aside>
  );
}

/** The moment in a card's loop where the most dots are lit, for its still. */
function brightest(show: Show, loopMs: number): number {
  let best = 0;
  let bestLevel = -1;
  for (let t = 0; t < loopMs; t += 40) {
    let level = 0;
    for (const p of PREVIEW_DOTS) {
      const c = colorAt(show, p, t);
      level +=
        parseInt(c.slice(1, 3), 16) +
        parseInt(c.slice(3, 5), 16) +
        parseInt(c.slice(5, 7), 16);
    }
    if (level > bestLevel) {
      bestLevel = level;
      best = t;
    }
  }
  return best;
}

/** Seats for the card previews, the same for every card. */
const PREVIEW_DOTS = (() => {
  let s = 11;
  const r = () => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  return Array.from({ length: 56 }, () => ({
    x: 0.06 + r() * 0.88,
    y: 0.08 + r() * 0.84,
  }));
})();

function EffectGrid({
  color,
  disabled,
  activeTool,
  onAdd,
}: {
  color: string;
  disabled: boolean;
  activeTool: string;
  onAdd: (effect: Effect) => void;
}) {
  const canvases = useRef(new Map<string, HTMLCanvasElement>());
  const store = useEditorStore();
  /** Start playing a card's effect (hover), or stop and show its still. */
  const hover = useRef<(id: string | null) => void>(() => {});

  // Each card shows its effect's brightest moment, and plays the effect
  // only while hovered.
  useEffect(() => {
    const shows = new Map<
      string,
      { show: Show; loopMs: number; stillMs: number }
    >();
    for (const effect of EFFECTS) {
      const clip = effectClip(effect.id, {
        clipId: effect.id,
        atMs: 200,
        layer: 0,
        color,
        showMs: 60_000,
        beatMs: beatMs(store),
        image: DEMO_IMAGE,
      });
      const drawn =
        effect.id === "draw" || effect.id === "brush"
          ? {
              id: effect.id,
              layer: 0,
              startMs: 200,
              endMs: 1600,
              color,
              fadeInMs: 200,
              fadeOutMs: 200,
              shape: {
                kind: "polygon" as const,
                points:
                  effect.id === "draw"
                    ? [
                        { x: 0.3, y: 0.25 },
                        { x: 0.72, y: 0.25 },
                        { x: 0.72, y: 0.75 },
                        { x: 0.3, y: 0.75 },
                      ]
                    : [
                        { x: 0.2, y: 0.6 },
                        { x: 0.4, y: 0.2 },
                        { x: 0.75, y: 0.3 },
                        { x: 0.8, y: 0.75 },
                        { x: 0.45, y: 0.85 },
                      ],
              },
            }
          : clip;
      if (!drawn) continue;
      const loopMs = Math.min(drawn.endMs, 4200) + 500;
      const show: Show = {
        id: effect.id,
        name: effect.label,
        venue: { shapes: [] },
        audio: { fileId: "", durationMs: loopMs },
        clips: [drawn],
        createdAt: "",
        updatedAt: "",
      };
      shows.set(effect.id, { show, loopMs, stillMs: brightest(show, loopMs) });
    }

    const paint = (id: string, t: number) => {
      const canvas = canvases.current.get(id);
      const entry = shows.get(id);
      const ctx = canvas?.getContext("2d");
      if (!canvas || !entry || !ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      for (const p of PREVIEW_DOTS) {
        const c = colorAt(entry.show, p, t);
        ctx.fillStyle = c === "#000000" ? "#262626" : c;
        ctx.beginPath();
        ctx.roundRect(p.x * w - 2.5, p.y * h - 2.5, 5, 5, 1.5);
        ctx.fill();
      }
    };
    const still = (id: string) => paint(id, shows.get(id)?.stillMs ?? 0);
    for (const id of shows.keys()) still(id);

    let raf = 0;
    let playing: string | null = null;
    hover.current = (id) => {
      cancelAnimationFrame(raf);
      if (playing) still(playing);
      playing = id;
      if (!id) return;
      const entry = shows.get(id);
      if (!entry) return;
      const start = performance.now();
      const frame = (now: number) => {
        raf = requestAnimationFrame(frame);
        paint(id, (now - start) % entry.loopMs);
      };
      raf = requestAnimationFrame(frame);
    };
    return () => {
      cancelAnimationFrame(raf);
      hover.current = () => {};
    };
  }, [color, store]);

  return (
    <div className={styles.effects}>
      {EFFECTS.map((effect) => (
        <button
          key={effect.id}
          type="button"
          className={styles.effect}
          draggable={!disabled}
          disabled={disabled}
          aria-pressed={effect.tool ? activeTool === effect.tool : undefined}
          title={`${effect.hint}. Drag onto the timeline, or click to add at the playhead.`}
          onDragStart={(e) => {
            e.dataTransfer.setData(EFFECT_MIME, effect.id);
            e.dataTransfer.effectAllowed = "copy";
            setDraggingEffect(effect.id);
          }}
          onDragEnd={() => setDraggingEffect(null)}
          onPointerEnter={() => hover.current(effect.id)}
          onPointerLeave={() => hover.current(null)}
          onClick={() => onAdd(effect)}
        >
          <canvas
            ref={(el) => {
              if (el) canvases.current.set(effect.id, el);
              else canvases.current.delete(effect.id);
            }}
            aria-hidden
          />
          <span className={styles.effectName}>
            <Icon name={effect.id} size={13} />
            {effect.label}
          </span>
        </button>
      ))}
    </div>
  );
}
