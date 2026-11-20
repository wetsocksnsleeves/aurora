import type { Point } from "@/lib/types";
import { toPx, type Size } from "./geometry";

/** Canvas drawing helpers shared by the layers in layers.ts and clip-layers.ts. */

export const COLORS = {
  background: "#111118",
  grid: "rgba(255,255,255,0.05)",
  venueFill: "rgba(110,231,183,0.12)",
  venueStroke: "rgba(110,231,183,0.7)",
  selected: "#fbbf24",
  draft: "#60a5fa",
};

/** Trace a closed polygon path in pixel space. */
export function tracePolygon(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  size: Size,
): void {
  ctx.beginPath();
  points.forEach((p, i) => {
    const { x, y } = toPx(p, size);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
}
