import type { Point } from "@/lib/types";
import { toPx, type Size } from "./geometry";

/** Canvas drawing helpers shared by the layers in layers.ts and clip-layers.ts. */

export const COLORS = {
  background: "#070707",
  grid: "rgba(255,255,255,0.05)",
  venueFill: "rgba(74,222,128,0.1)",
  venueStroke: "rgba(74,222,128,0.6)",
  selected: "#ffffff",
  draft: "#6dd5ff",
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
