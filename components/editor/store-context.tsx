"use client";

import {
  createContext,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { EditorState, EditorStore } from "./store";

const EditorStoreContext = createContext<EditorStore | null>(null);

export function EditorStoreProvider({
  store,
  children,
}: {
  store: EditorStore;
  children: ReactNode;
}) {
  return (
    <EditorStoreContext.Provider value={store}>
      {children}
    </EditorStoreContext.Provider>
  );
}

/** The editor store, for dispatching and for imperative subscribers (canvas, audio). */
export function useEditorStore(): EditorStore {
  const store = useContext(EditorStoreContext);
  if (!store)
    throw new Error("useEditorStore must be used inside <EditorStoreProvider>");
  return store;
}

/**
 * Re-render when `selector(state)` changes (compared with Object.is). Select
 * small values; selecting `currentTimeMs` re-renders on every audio tick.
 */
export function useEditorSelector<T>(selector: (state: EditorState) => T): T {
  const store = useEditorStore();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}
