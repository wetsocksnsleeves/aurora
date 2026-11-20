"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHostShow } from "@/components/shows/host-show";
import type { Show } from "@/lib/types";
import { saveShow } from "./api";
import type { Size } from "./geometry";
import { handleEditorKey, isTypingTarget, timelineKeys } from "./keyboard";
import { DEFAULT_LAYERS } from "./layers";
import {
  createEditorStore,
  initialEditorState,
  isDirty,
  type EditorStore,
} from "./store";
import {
  EditorStoreProvider,
  useEditorSelector,
  useEditorStore,
} from "./store-context";
import { ClipInspector } from "./ClipInspector";
import { Timeline } from "./Timeline";
import { Toolbar } from "./Toolbar";
import { Transport } from "./Transport";
import { toolHandlers } from "./tools";
import { VenueCanvas } from "./VenueCanvas";
import styles from "./editor.module.css";

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

export function Editor({ initialShow }: { initialShow: Show }) {
  // One store per mounted editor. useState keeps it stable across renders.
  const [store] = useState(() =>
    createEditorStore(initialEditorState(initialShow)),
  );
  return (
    <EditorStoreProvider store={store}>
      <EditorLayout />
    </EditorStoreProvider>
  );
}

function EditorLayout() {
  const store = useEditorStore();
  const canvasSize = useRef<Size>({ width: 0, height: 0 });
  const tool = useEditorSelector((s) => s.tool);
  const dirty = useEditorSelector(isDirty);

  const save = useCallback(() => void saveEditorShow(store), [store]);
  const { host, hosting, error: hostError } = useHostShow();

  // Host what is on screen: save first, so the session's snapshot (taken
  // from the saved show) matches the editor.
  const saveAndHost = async () => {
    if (isDirty(store.getState())) await saveEditorShow(store);
    const state = store.getState();
    if (isDirty(state) || state.saveStatus === "error") return;
    await host(state.show.id);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
        return;
      }
      if (isTypingTarget(e.target)) return;
      if (
        handleEditorKey(e, store, canvasSize.current, [timelineKeys(store)])
      ) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store, save]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  return (
    <main className={styles.editor}>
      <header className={styles.header}>
        <Link href="/" className={styles.back}>
          ← Shows
        </Link>
        <ShowNameInput />
        <SaveStatus />
        <button
          type="button"
          className={`${styles.button} ${styles.primary}`}
          onClick={save}
        >
          Save
        </button>
        <button
          type="button"
          className={styles.button}
          onClick={() => void saveAndHost()}
          disabled={hosting !== null}
          title="Save, then start a session for this show"
        >
          {hosting ? "Hosting…" : "Save and host"}
        </button>
        {hostError ? (
          <span
            className={`${styles.status} ${styles.statusError}`}
            role="alert"
          >
            Could not host: {hostError}
          </span>
        ) : null}
      </header>
      <Toolbar />
      <p className={styles.hint}>{toolHandlers[tool].hint}</p>
      <div className={styles.workspace}>
        <VenueCanvas
          layers={DEFAULT_LAYERS}
          onResize={(size) => {
            canvasSize.current = size;
          }}
        />
        <ClipInspector />
      </div>
      <Transport />
      <Timeline />
    </main>
  );
}

function ShowNameInput() {
  const store = useEditorStore();
  const name = useEditorSelector((s) => s.show.name);
  return (
    <input
      className={styles.nameInput}
      aria-label="Show name"
      value={name}
      maxLength={200}
      onChange={(e) =>
        store.dispatch({ type: "renameShow", name: e.target.value })
      }
    />
  );
}

function SaveStatus() {
  const dirty = useEditorSelector(isDirty);
  const status = useEditorSelector((s) => s.saveStatus);
  const error = useEditorSelector((s) => s.saveError);
  let text = dirty ? "Unsaved changes" : status === "saved" ? "Saved" : "";
  if (status === "saving") text = "Saving…";
  if (status === "error") text = `Save failed: ${error ?? "unknown error"}`;
  return (
    <span
      className={`${styles.status} ${status === "error" ? styles.statusError : ""}`}
      role="status"
    >
      {text}
    </span>
  );
}
