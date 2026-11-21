"use client";

import { useCallback, useEffect, useState } from "react";

/** Panel sizes in pixels; 0 means hidden. */
export type PanelSizes = { left: number; right: number; bottom: number };
export type PanelName = keyof PanelSizes;

const KEY = "lightshow-panels-v1";
export const DEFAULT_SIZES: PanelSizes = { left: 292, right: 312, bottom: 300 };
/** Smaller than this while dragging, and the panel hides. */
export const MIN_SIZES: PanelSizes = { left: 200, right: 240, bottom: 150 };
export const MAX_SIZES: PanelSizes = { left: 520, right: 560, bottom: 720 };

type Stored = { sizes: PanelSizes; restore: PanelSizes };

function read(): Stored {
  if (typeof window === "undefined") {
    return { sizes: DEFAULT_SIZES, restore: DEFAULT_SIZES };
  }
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Stored;
    if (saved?.sizes && saved.restore) return saved;
  } catch {
    // Defaults.
  }
  return { sizes: DEFAULT_SIZES, restore: DEFAULT_SIZES };
}

/**
 * The room screen's resizable panels: effects (left), clip settings
 * (right) and the timeline (bottom). Sizes are remembered on this laptop; a
 * hidden panel remembers the size to come back at.
 */
export function usePanels(): {
  sizes: PanelSizes;
  /** `from` is the size when the drag began: a hidden panel comes back at it. */
  resize: (panel: PanelName, px: number, from: number) => void;
  toggle: (panel: PanelName) => void;
} {
  // The panels only render in the browser (after the room opens), so the
  // saved sizes can be read straight away.
  const [state, setState] = useState<Stored>(read);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // Not remembered.
    }
  }, [state]);

  const resize = useCallback((panel: PanelName, px: number, from: number) => {
    setState((s) => {
      const size =
        px < MIN_SIZES[panel] / 2
          ? 0
          : Math.min(MAX_SIZES[panel], Math.max(MIN_SIZES[panel], px));
      return {
        sizes: { ...s.sizes, [panel]: size },
        // Hidden by this drag: come back at the size it started from.
        restore: {
          ...s.restore,
          [panel]: size || from || s.restore[panel],
        },
      };
    });
  }, []);

  const toggle = useCallback((panel: PanelName) => {
    setState((s) => ({
      ...s,
      sizes: {
        ...s.sizes,
        [panel]: s.sizes[panel] ? 0 : s.restore[panel] || DEFAULT_SIZES[panel],
      },
    }));
  }, []);

  return { sizes: state.sizes, resize, toggle };
}
