"use client";

import { useRef, type CSSProperties } from "react";
import type { PanelName } from "./use-panels";
import styles from "./room.module.css";

const LABELS: Record<PanelName, string> = {
  left: "effects",
  right: "clip settings",
  bottom: "timeline",
};

/**
 * The gap between the room and a panel: drag to resize the panel (smaller
 * than its minimum hides it), double-click to hide or show it. A hidden
 * panel's splitter becomes a small tab to bring it back.
 */
export function Splitter({
  panel,
  size,
  style,
  onResize,
  onToggle,
}: {
  panel: PanelName;
  size: number;
  style: CSSProperties;
  /** The new size, and the size when the drag began. */
  onResize: (px: number, from: number) => void;
  onToggle: () => void;
}) {
  const drag = useRef<{ start: number; size: number; moved: boolean } | null>(
    null,
  );
  const vertical = panel !== "bottom";
  const hidden = size === 0;
  const coord = (e: React.PointerEvent) => (vertical ? e.clientX : e.clientY);
  const name = LABELS[panel];

  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={`Resize the ${name}`}
      title={
        hidden
          ? `Show the ${name}`
          : `Drag to resize the ${name}. Double-click to hide it.`
      }
      className={styles.splitter}
      data-panel={panel}
      data-hidden={hidden || undefined}
      style={style}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { start: coord(e), size, moved: false };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const delta = coord(e) - d.start;
        if (!d.moved && Math.abs(delta) < 3) return;
        d.moved = true;
        // Dragging towards the room makes the panel bigger.
        const grow = panel === "left" ? delta : -delta;
        onResize(d.size + grow, d.size);
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
        // A click on a hidden panel's tab brings it back.
        if (d && !d.moved && hidden) onToggle();
      }}
      onDoubleClick={() => {
        if (!hidden) onToggle();
      }}
    >
      <i aria-hidden />
    </div>
  );
}
