import type { EditorStore } from "./store";
import { toolHandlers, type ToolContext } from "./tools";
import type { Size } from "./geometry";

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
