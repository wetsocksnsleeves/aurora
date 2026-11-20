"use client";

import { useEditorSelector, useEditorStore } from "./store-context";
import { CLIP_TOOLS, VENUE_TOOLS, toolHandlers } from "./tools";
import type { ToolId } from "./store";
import styles from "./editor.module.css";

export function Toolbar() {
  const store = useEditorStore();
  const tool = useEditorSelector((s) => s.tool);
  const hasSelection = useEditorSelector((s) => s.selection !== null);

  const group = (label: string, ids: ToolId[]) => (
    <>
      <span className={styles.toolGroupLabel}>{label}</span>
      {ids.map((id) => {
        const handler = toolHandlers[id];
        const active = id === tool;
        return (
          <button
            key={id}
            type="button"
            className={`${styles.button} ${active ? styles.buttonActive : ""}`}
            aria-pressed={active}
            onClick={() => store.dispatch({ type: "setTool", tool: id })}
          >
            {handler.label}
            <span className={styles.shortcut}>
              {handler.shortcut.toUpperCase()}
            </span>
          </button>
        );
      })}
    </>
  );

  return (
    <div className={styles.toolbar} role="toolbar" aria-label="Tools">
      {group("Venue", VENUE_TOOLS)}
      <span className={styles.separator} />
      {group("Clips", CLIP_TOOLS)}
      <span className={styles.separator} />
      <button
        type="button"
        className={styles.button}
        disabled={!hasSelection}
        onClick={() => store.dispatch({ type: "deleteSelection" })}
      >
        Delete
      </button>
    </div>
  );
}
