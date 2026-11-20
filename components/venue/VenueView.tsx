import { memo, type MouseEvent } from "react";
import type { Point, Venue } from "@/lib/types";
import { clientToVenuePoint } from "@/lib/venue-geometry";
import styles from "./VenueView.module.css";

/** One participant dot on the map, in normalised venue coordinates. */
export type VenueDot = {
  id: string;
  x: number;
  y: number;
  /** Any CSS colour. */
  color: string;
  /** Draw a warning marker next to the dot (degraded clock, SPEC 5.3). */
  warning?: boolean;
  /** Tooltip text. */
  title?: string;
};

export type VenueViewProps = {
  venue: Venue;
  dots?: readonly VenueDot[];
  /** The participant's own seat, drawn as a highlighted marker. */
  seat?: Point | null;
  /**
   * Called with the tapped point in 0..1 venue coordinates. Raw: apply
   * `pickSeat` from `@/lib/venue-geometry` to snap or reject it.
   */
  onTap?: (point: Point) => void;
  /** Width / height of the venue space. Default 1 (square). */
  aspectRatio?: number;
  /** Dot radius as a fraction of the venue height. Default 0.012. */
  dotRadius?: number;
  className?: string;
  /** Accessible name for the map. */
  label?: string;
};

/** Internal SVG units for the venue height. */
const H = 1000;

/**
 * Draws a venue (SPEC 3.2) as SVG, with optional participant dots and a seat
 * marker. Shared by the participant page, the host map and the editor
 * preview. Plain SVG, no dependencies, so the participant bundle stays small.
 */
function VenueViewImpl({
  venue,
  dots,
  seat,
  onTap,
  aspectRatio = 1,
  dotRadius = 0.012,
  className,
  label = "Venue map",
}: VenueViewProps) {
  const W = H * aspectRatio;
  const r = dotRadius * H;

  const handleClick = onTap
    ? (event: MouseEvent<SVGSVGElement>) => {
        const point = clientToVenuePoint(
          event.clientX,
          event.clientY,
          event.currentTarget.getBoundingClientRect(),
        );
        if (point) onTap(point);
      }
    : undefined;

  return (
    <svg
      className={[styles.root, onTap ? styles.interactive : "", className]
        .filter(Boolean)
        .join(" ")}
      viewBox={`0 0 ${W} ${H}`}
      role={onTap ? "button" : "img"}
      aria-label={label}
      onClick={handleClick}
    >
      {venue.shapes.map((shape) => (
        <polygon
          key={shape.id}
          className={styles.shape}
          strokeWidth={4}
          points={shape.points.map((p) => `${p.x * W},${p.y * H}`).join(" ")}
        />
      ))}
      {dots?.map((dot) => (
        <g key={dot.id}>
          <circle
            className={styles.dot}
            data-dot-id={dot.id}
            cx={dot.x * W}
            cy={dot.y * H}
            r={r}
            fill={dot.color}
            strokeWidth={r * 0.2}
          >
            {dot.title ? <title>{dot.title}</title> : null}
          </circle>
          {dot.warning ? (
            <path
              className={styles.warning}
              strokeWidth={r * 0.15}
              d={warningPath(dot.x * W + r, dot.y * H - r, r)}
            />
          ) : null}
        </g>
      ))}
      {seat ? (
        <g>
          <circle
            className={styles.seatRing}
            cx={seat.x * W}
            cy={seat.y * H}
            r={r * 3}
            strokeWidth={r * 0.5}
          />
          <circle
            className={styles.seat}
            cx={seat.x * W}
            cy={seat.y * H}
            r={r * 1.6}
            strokeWidth={r * 0.4}
          />
        </g>
      ) : null}
    </svg>
  );
}

/** A small triangle centred on (cx, cy). */
function warningPath(cx: number, cy: number, r: number): string {
  const s = r * 0.9;
  return `M${cx},${cy - s} L${cx + s},${cy + s * 0.8} L${cx - s},${cy + s * 0.8} Z`;
}

export const VenueView = memo(VenueViewImpl);
export default VenueView;
