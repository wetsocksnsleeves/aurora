import { saveShow } from "./api";
import type { EditorStore } from "./store";

/** Save the store's show, keeping edits made while the request is in flight. */
export async function saveEditorShow(store: EditorStore): Promise<void> {
  const state = store.getState();
  if (state.saveStatus === "saving") return;
  const revision = state.revision;
  store.dispatch({ type: "saveStarted" });
  try {
    const show = await saveShow(state.show);
    store.dispatch({ type: "saveSucceeded", revision, show });
  } catch (err) {
    store.dispatch({
      type: "saveFailed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
