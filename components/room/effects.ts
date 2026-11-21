import type { ToolId } from "@/components/editor/store";
import { averageColor } from "@/lib/image";
import type {
  Clip,
  ClipShape,
  ImageShape,
  PatternKind,
  PatternShape,
} from "@/lib/types";

/**
 * The effects library (left panel). Each effect is a clip with good
 * defaults; drawing effects switch to a drawing tool instead.
 */

export type EffectId =
  | "flash"
  | "strobe"
  | "pulse"
  | "wave"
  | "split"
  | "chase"
  | "sparkle"
  | "wash"
  | "image"
  | "draw"
  | "brush";

export type Effect = {
  id: EffectId;
  label: string;
  /** One line under the card's name, and the tooltip. */
  hint: string;
  /** Effects that draw on the room instead of adding a clip straight away. */
  tool?: ToolId;
  /** Asks for a picture first. */
  upload?: boolean;
};

export const EFFECTS: readonly Effect[] = [
  { id: "flash", label: "Flash", hint: "Everyone, one quick hit" },
  { id: "strobe", label: "Strobe", hint: "Fast on and off" },
  { id: "pulse", label: "Pulse", hint: "Beats on the beat" },
  { id: "wave", label: "Wave", hint: "A band sweeps across" },
  { id: "split", label: "Split", hint: "Two bands from the middle" },
  { id: "chase", label: "Chase", hint: "Columns light in turn" },
  { id: "sparkle", label: "Sparkle", hint: "Random phones twinkle" },
  { id: "wash", label: "Colour wash", hint: "Everyone, held" },
  {
    id: "image",
    label: "Image",
    hint: "Your picture across the crowd",
    upload: true,
  },
  {
    id: "draw",
    label: "Draw a shape",
    hint: "Drag a box on the room",
    tool: "shape",
  },
  {
    id: "brush",
    label: "Draw freehand",
    hint: "Paint an area on the room",
    tool: "brush",
  },
];

export const EFFECT_MIME = "application/x-lightshow-effect";

export function effectById(id: string): Effect | undefined {
  return EFFECTS.find((e) => e.id === id);
}

function pattern(
  kind: PatternKind,
  over: Partial<PatternShape> = {},
): PatternShape {
  return {
    kind: "pattern",
    pattern: kind,
    direction: "right",
    size: 0.25,
    stepMs: 250,
    from: 0,
    to: 1,
    ...over,
  };
}

type Recipe = Pick<Clip, "fadeInMs" | "fadeOutMs" | "blink" | "label"> & {
  lengthMs: number;
  shape: ClipShape;
};

/**
 * Defaults for an effect. `beatMs` (from the BPM) sets rhythmic ones; an
 * image effect needs its picture.
 */
function recipe(
  id: EffectId,
  beatMs: number,
  image?: ImageShape,
): Recipe | null {
  const plain = { fadeInMs: 0, fadeOutMs: 0 };
  switch (id) {
    case "flash":
      return {
        ...plain,
        fadeOutMs: 300,
        lengthMs: 400,
        shape: { kind: "fill" },
        label: "Flash",
      };
    case "strobe":
      return {
        ...plain,
        lengthMs: 2000,
        shape: { kind: "fill" },
        blink: { periodMs: 120, duty: 0.5, soft: false },
        label: "Strobe",
      };
    case "pulse":
      return {
        ...plain,
        lengthMs: beatMs * 8,
        shape: { kind: "fill" },
        blink: { periodMs: beatMs, duty: 0.5, soft: true },
        label: "Pulse",
      };
    case "wave":
      return { ...plain, lengthMs: 1500, shape: pattern("wave") };
    case "split":
      return {
        ...plain,
        lengthMs: 1500,
        shape: pattern("split", { size: 0.2 }),
      };
    case "chase":
      return {
        ...plain,
        lengthMs: beatMs * 8,
        shape: pattern("chase", { stepMs: beatMs / 2 }),
      };
    case "sparkle":
      return {
        ...plain,
        lengthMs: 4000,
        shape: pattern("sparkle", { size: 0.15, stepMs: 200 }),
      };
    case "wash":
      return {
        fadeInMs: 500,
        fadeOutMs: 500,
        lengthMs: 4000,
        shape: { kind: "fill" },
        label: "Colour wash",
      };
    case "image":
      return image
        ? {
            fadeInMs: 300,
            fadeOutMs: 300,
            lengthMs: 4000,
            shape: image,
          }
        : null;
    case "draw":
    case "brush":
      return null;
  }
}

/**
 * A small picture for the Image card's preview: a sunset with a sun.
 */
export const DEMO_IMAGE: ImageShape = (() => {
  const w = 16;
  const h = 12;
  let pixels = "";
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sun = Math.hypot(x - 8, y - 7) < 3.2;
      const t = y / (h - 1);
      const r = sun ? 255 : Math.round(255 - 120 * t);
      const g = sun ? 230 : Math.round(95 + 40 * (1 - t) - 70 * t);
      const b = sun ? 120 : Math.round(140 + 100 * t);
      pixels += [r, g, b, 255]
        .map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0"))
        .join("");
    }
  }
  return { kind: "image", w, h, pixels, fit: "cover" };
})();

/**
 * A clip for `id` starting at `atMs`, or null for drawing effects. Kept
 * inside the show: near the end it starts earlier rather than run over.
 */
export function effectClip(
  id: EffectId,
  opts: {
    clipId: string;
    atMs: number;
    layer: number;
    color: string;
    showMs: number;
    beatMs: number;
    /** The picture, for an image effect. */
    image?: ImageShape;
  },
): Clip | null {
  const r = recipe(id, opts.beatMs, opts.image);
  if (!r) return null;
  const lengthMs = Math.min(r.lengthMs, Math.max(100, opts.showMs));
  const startMs = Math.max(
    0,
    Math.min(Math.round(opts.atMs), opts.showMs - lengthMs),
  );
  const clip: Clip = {
    id: opts.clipId,
    layer: opts.layer,
    startMs,
    endMs: startMs + lengthMs,
    // An image clip shows on the timeline in its picture's main colour.
    color: r.shape.kind === "image" ? averageColor(r.shape) : opts.color,
    fadeInMs: r.fadeInMs,
    fadeOutMs: r.fadeOutMs,
    shape: r.shape,
  };
  if (r.blink) clip.blink = r.blink;
  if (r.label) clip.label = r.label;
  return clip;
}

/** Colours offered for clips; any other can be picked too. */
export const SWATCHES = [
  "#ffffff",
  "#ff2d2d",
  "#ff9f1a",
  "#ffe600",
  "#2dff6a",
  "#2d8bff",
  "#b02dff",
  "#ff2dc8",
];

/** 120 BPM until the show has a tempo. */
export const DEFAULT_BEAT_MS = 500;
