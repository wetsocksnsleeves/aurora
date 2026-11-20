import type { Point, Venue } from "@/lib/types";
import { toPx } from "./geometry";
import type { CanvasLayer } from "./layers";
import { PREVIEW_GRID, previewColors, previewDots } from "./preview";

/** Unlit phones are black; draw them dim grey so the seat grid stays visible. */
const UNLIT = "#000000";
const UNLIT_DRAWN = "#2a2a35";

// Dots depend only on the venue, which keeps its identity until edited.
const dotCache = new WeakMap<Venue, Point[]>();

function dotsFor(venue: Venue): Point[] {
  let dots = dotCache.get(venue);
  if (!dots) {
    dots = previewDots(venue);
    dotCache.set(venue, dots);
  }
  return dots;
}

const colors: string[] = [];

/**
 * Simulated seats (SPEC 2.1 step 4): a grid of dots inside the venue, each
 * coloured as a phone at that seat shows the show at the playhead.
 * Consecutive dots of the same colour are filled as one path.
 */
export const previewLayer: CanvasLayer = {
  id: "preview",
  draw({ ctx, size, state }) {
    if (state.previewMode !== "dots") return;
    const dots = dotsFor(state.show.venue);
    previewColors(state.show, dots, state.currentTimeMs, colors);
    const radius = (Math.min(size.width, size.height) / PREVIEW_GRID) * 0.36;
    let current = "";
    ctx.beginPath();
    for (let i = 0; i < dots.length; i++) {
      const color = colors[i] === UNLIT ? UNLIT_DRAWN : colors[i];
      if (color !== current) {
        if (current) ctx.fill();
        ctx.fillStyle = current = color;
        ctx.beginPath();
      }
      const { x, y } = toPx(dots[i], size);
      ctx.moveTo(x + radius, y);
      ctx.arc(x, y, radius, 0, Math.PI * 2);
    }
    if (current) ctx.fill();
  },
};
