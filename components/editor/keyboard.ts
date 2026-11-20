import type { EditorStore } from "./store";
import { toolHandlers, type ToolContext } from "./tools";
import type { Size } from "./geometry";
import { stepTime } from "./snap";

/** True when the key event belongs to a text field, not the editor. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

export type KeyInput = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
};

/**
 * Editor-wide key handling, outside text fields. The active tool sees the key
 * first. Returns true when the key was handled (the caller then calls
 * preventDefault). `extra` handlers (chunk 12 adds Space for play/pause) run
 * before the built-in shortcuts.
 */
export function handleEditorKey(
  input: KeyInput,
  store: EditorStore,
  size: Size,
  extra: ((input: KeyInput) => boolean)[] = [],
): boolean {
  const ctx: ToolContext = { store, size };
  const state = store.getState();
  if (toolHandlers[state.tool].onKeyDown?.(input.key, ctx)) return true;
  for (const handler of extra) if (handler(input)) return true;
  if (input.ctrlKey || input.metaKey || input.altKey) return false;

  if (input.key === "Delete" || input.key === "Backspace") {
    if (!state.selection) return false;
    store.dispatch({ type: "deleteSelection" });
    return true;
  }
  if (input.key === "Escape") {
    store.dispatch({ type: "setDraft", draft: null });
    store.dispatch({ type: "select", selection: null });
    return true;
  }
  const key = input.key.toLowerCase();
  for (const [id, handler] of Object.entries(toolHandlers)) {
    if (handler.shortcut === key) {
      store.dispatch({
        type: "setTool",
        tool: id as keyof typeof toolHandlers,
      });
      return true;
    }
  }
  return false;
}

/**
 * Timeline keys: Space plays or pauses, Left and Right move the playhead to
 * the previous or next grid point.
 */
export function timelineKeys(store: EditorStore): (input: KeyInput) => boolean {
  return (input) => {
    if (input.ctrlKey || input.metaKey || input.altKey) return false;
    const state = store.getState();
    if (input.key === " ") {
      store.dispatch({ type: "setPlaying", playing: !state.playing });
      return true;
    }
    if (input.key === "ArrowLeft" || input.key === "ArrowRight") {
      const direction = input.key === "ArrowRight" ? 1 : -1;
      store.dispatch({
        type: "seek",
        timeMs: stepTime(
          state.currentTimeMs,
          direction,
          state.snap,
          state.show.audio.durationMs,
        ),
      });
      return true;
    }
    return false;
  };
}
