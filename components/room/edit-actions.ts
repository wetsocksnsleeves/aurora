import { formatTime, isValidBpm, snapTime } from "@/components/editor/snap";
import { freeLayer } from "@/components/editor/clips";
import { newId, type EditorStore } from "@/components/editor/store";
import { showDurationMs } from "@/lib/compile";
import { averageColor } from "@/lib/image";
import type { Clip, ImageShape } from "@/lib/types";
import { pickImage } from "./image-upload";
import {
  DEFAULT_BEAT_MS,
  effectById,
  effectClip,
  type EffectId,
} from "./effects";

/**
 * Editing commands shared by the toolbar, the keyboard and the effects
 * library. Each returns a short message for the toast, or null when there
 * was nothing to do.
 */

export type Toast = (message: string, undoable?: boolean) => void;

/** The tempo the effects follow: the snap BPM if set, else 120. */
export function beatMs(store: EditorStore): number {
  const bpm = store.getState().snap.bpm;
  return isValidBpm(bpm) ? 60_000 / bpm : DEFAULT_BEAT_MS;
}

function selectedClip(store: EditorStore): Clip | null {
  const { selection, show } = store.getState();
  if (selection?.kind !== "clip") return null;
  return show.clips.find((c) => c.id === selection.id) ?? null;
}

/**
 * Add an effect at `atMs` (the playhead by default), on the lowest free
 * track from `layer` up. Drawing effects pick their tool instead.
 */
export function addEffect(
  store: EditorStore,
  id: EffectId,
  toast: Toast,
  atMs?: number,
  layer = 0,
): void {
  const effect = effectById(id);
  if (!effect) return;
  const state = store.getState();
  const at = snapTime(
    atMs ?? state.currentTimeMs,
    state.snap,
    state.show.audio.durationMs,
  );
  if (effect.upload) {
    void addImage(store, toast, at, layer);
    return;
  }
  if (effect.tool) {
    if (atMs !== undefined) store.dispatch({ type: "seek", timeMs: at });
    store.dispatch({ type: "setTool", tool: effect.tool });
    toast(
      effect.tool === "brush"
        ? "Paint an area on the room"
        : "Drag a box on the room, or click its corners",
    );
    return;
  }
  const clip = effectClip(id, {
    clipId: newId("clip"),
    atMs: at,
    layer: 0,
    color: state.clipColor,
    showMs: Math.max(state.show.audio.durationMs, showDurationMs(state.show)),
    beatMs: beatMs(store),
  });
  if (!clip) return;
  clip.layer = freeLayer(state.show.clips, clip.startMs, clip.endMs, layer);
  store.dispatch({ type: "addClips", clips: [clip], select: clip.id });
  toast(`${effect.label} added at ${formatTime(clip.startMs)}`, true);
}

/** Pick a picture and add it as an image clip at `atMs`. */
async function addImage(
  store: EditorStore,
  toast: Toast,
  atMs: number,
  layer: number,
): Promise<void> {
  let image: ImageShape | null;
  try {
    image = await pickImage();
  } catch {
    toast("Couldn’t read that picture");
    return;
  }
  if (!image) return;
  const state = store.getState();
  const clip = effectClip("image", {
    clipId: newId("clip"),
    atMs,
    layer: 0,
    color: state.clipColor,
    showMs: Math.max(state.show.audio.durationMs, showDurationMs(state.show)),
    beatMs: beatMs(store),
    image,
  });
  if (!clip) return;
  clip.layer = freeLayer(state.show.clips, clip.startMs, clip.endMs, layer);
  store.dispatch({ type: "addClips", clips: [clip], select: clip.id });
  toast(`Image added at ${formatTime(clip.startMs)}`, true);
}

/** Swap the selected image clip's picture, keeping its timing. */
export async function replaceImage(
  store: EditorStore,
  toast: Toast,
): Promise<void> {
  const clip = selectedClip(store);
  if (clip?.shape.kind !== "image") return;
  const fit = clip.shape.fit;
  let image: ImageShape | null;
  try {
    image = await pickImage();
  } catch {
    toast("Couldn’t read that picture");
    return;
  }
  if (!image) return;
  const shape = { ...image, fit };
  store.dispatch({
    type: "updateClip",
    id: clip.id,
    patch: { shape, color: averageColor(shape) },
  });
  toast("Picture replaced", true);
}

export function deleteSelected(store: EditorStore, toast: Toast): void {
  const clip = selectedClip(store);
  if (!clip) return;
  store.dispatch({ type: "deleteClip", id: clip.id });
  toast("Deleted", true);
}

/** A copy straight after the original, on the lowest free track. */
export function duplicateSelected(store: EditorStore, toast: Toast): void {
  const clip = selectedClip(store);
  if (!clip) return;
  const length = clip.endMs - clip.startMs;
  const copy = { ...clip, id: newId("clip") };
  copy.startMs = clip.endMs;
  copy.endMs = clip.endMs + length;
  copy.layer = freeLayer(
    store.getState().show.clips,
    copy.startMs,
    copy.endMs,
    clip.layer,
  );
  store.dispatch({ type: "addClips", clips: [copy], select: copy.id });
  store.dispatch({ type: "seek", timeMs: copy.startMs });
  toast("Duplicated", true);
}

export function splitSelected(store: EditorStore, toast: Toast): void {
  const clip = selectedClip(store);
  const t = store.getState().currentTimeMs;
  if (!clip || !(t > clip.startMs && t < clip.endMs)) {
    toast("Put the playhead over the selected clip to split it");
    return;
  }
  store.dispatch({
    type: "splitClip",
    id: clip.id,
    atMs: t,
    newId: newId("clip"),
  });
  toast(`Split at ${formatTime(t)}`, true);
}

let clipboard: Clip | null = null;

export function copySelected(store: EditorStore, toast: Toast): void {
  const clip = selectedClip(store);
  if (!clip) return;
  clipboard = structuredClone(clip);
  toast("Copied");
}

/** Paste the copied clip at the playhead. */
export function paste(store: EditorStore, toast: Toast): void {
  if (!clipboard) return;
  const state = store.getState();
  const length = clipboard.endMs - clipboard.startMs;
  const startMs = state.currentTimeMs;
  const copy: Clip = {
    ...structuredClone(clipboard),
    id: newId("clip"),
    startMs,
    endMs: startMs + length,
  };
  copy.layer = freeLayer(
    state.show.clips,
    copy.startMs,
    copy.endMs,
    copy.layer,
  );
  store.dispatch({ type: "addClips", clips: [copy], select: copy.id });
  toast(`Pasted at ${formatTime(startMs)}`, true);
}
