"use client";

import type { ReactNode } from "react";
import { SWATCHES } from "@/components/editor/ClipInspector";
import type { ToolId } from "@/components/editor/store";
import {
  useEditorSelector,
  useEditorStore,
} from "@/components/editor/store-context";
import { toolHandlers } from "@/components/editor/tools";
import styles from "./room.module.css";

const TOOLS: { id: ToolId; label: string; icon: ReactNode }[] = [
  {
    id: "fill",
    label: "Fill",
    icon: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="3" />
        <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
      </>
    ),
  },
  {
    id: "shape",
    label: "Shape",
    icon: <rect x="5" y="5" width="14" height="14" rx="3" />,
  },
  {
    id: "moving",
    label: "Wave",
    icon: (
      <>
        <rect x="3" y="8" width="7" height="8" rx="2" />
        <path d="M13 12h8M18 9l3 3-3 3" />
      </>
    ),
  },
  {
    id: "brush",
    label: "Brush",
    icon: <path d="M4 17c3-6 6 2 9-4s5-4 7-6" />,
  },
];

/** Clip tools and the colour for new clips, down the left edge. */
export function ToolRail({ disabled }: { disabled: boolean }) {
  const store = useEditorStore();
  const tool = useEditorSelector((s) => s.tool);
  const color = useEditorSelector((s) => s.clipColor);
  return (
    <nav
      className={styles.rail}
      aria-label="Tools"
      data-disabled={disabled || undefined}
    >
      {TOOLS.map(({ id, label, icon }) => (
        <button
          key={id}
          type="button"
          className={styles.tool}
          aria-pressed={id === tool}
          disabled={disabled}
          title={`${toolHandlers[id].hint} (${toolHandlers[id].shortcut.toUpperCase()})`}
          onClick={() => store.dispatch({ type: "setTool", tool: id })}
        >
          <svg viewBox="0 0 24 24" aria-hidden>
            {icon}
          </svg>
          {label}
        </button>
      ))}
      <div className={styles.railSwatches} role="group" aria-label="Colour">
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
      </div>
    </nav>
  );
}
