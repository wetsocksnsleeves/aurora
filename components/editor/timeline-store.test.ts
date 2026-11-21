import { describe, expect, it } from "vitest";
import { timelineKeys } from "./keyboard";
import {
  editorReducer,
  initialEditorState,
  isDirty,
  MAX_ZOOM_PX_PER_SEC,
} from "./store";
import { makeShow, makeStore } from "./test-fixtures";

const fileId = "0b6f4c1e-2a7d-4b8e-9f00-123456789abc.mp3";
const withAudio = () => makeShow({ audio: { fileId, durationMs: 10_000 } });

describe("timeline state", () => {
  it("starts at zero, paused, loading the show's audio", () => {
    const state = initialEditorState(withAudio());
    expect(state.currentTimeMs).toBe(0);
    expect(state.playing).toBe(false);
    expect(state.audioStatus).toBe("loading");
    expect(initialEditorState(makeShow()).audioStatus).toBe("none");
  });

  it("ticks without bumping seekSeq, seeks with it", () => {
    let state = initialEditorState(withAudio());
    state = editorReducer(state, { type: "tick", timeMs: 1500 });
    expect(state.currentTimeMs).toBe(1500);
    expect(state.seekSeq).toBe(0);
    state = editorReducer(state, { type: "seek", timeMs: 4000 });
    expect(state.currentTimeMs).toBe(4000);
    expect(state.seekSeq).toBe(1);
    expect(isDirty(state)).toBe(false);
  });

  it("clamps the playhead to the audio duration", () => {
    let state = initialEditorState(withAudio());
    state = editorReducer(state, { type: "seek", timeMs: 99_000 });
    expect(state.currentTimeMs).toBe(10_000);
    state = editorReducer(state, { type: "seek", timeMs: -5 });
    expect(state.currentTimeMs).toBe(0);
  });

  it("only plays once audio is ready", () => {
    let state = initialEditorState(withAudio());
    state = editorReducer(state, { type: "setPlaying", playing: true });
    expect(state.playing).toBe(false);
    state = editorReducer(state, { type: "setAudioStatus", status: "ready" });
    state = editorReducer(state, { type: "setPlaying", playing: true });
    expect(state.playing).toBe(true);
    state = editorReducer(state, {
      type: "setAudioStatus",
      status: "error",
      error: "x",
    });
    expect(state.playing).toBe(false);
    expect(state.audioError).toBe("x");
  });

  it("plays a show without music straight away", () => {
    let state = initialEditorState(makeShow());
    expect(state.audioStatus).toBe("none");
    state = editorReducer(state, { type: "setPlaying", playing: true });
    expect(state.playing).toBe(true);
  });

  it("clamps zoom", () => {
    const state = editorReducer(initialEditorState(makeShow()), {
      type: "setZoom",
      pxPerSec: 1e9,
    });
    expect(state.zoomPxPerSec).toBe(MAX_ZOOM_PX_PER_SEC);
  });

  it("merges snap settings", () => {
    let state = initialEditorState(makeShow());
    state = editorReducer(state, { type: "setSnap", snap: { mode: "beat" } });
    state = editorReducer(state, { type: "setSnap", snap: { bpm: 128 } });
    expect(state.snap).toMatchObject({
      mode: "beat",
      bpm: 128,
      subdivision: 4,
    });
  });

  it("resets the playhead for a new audio file and marks the show dirty", () => {
    let state = initialEditorState(withAudio());
    state = editorReducer(state, { type: "tick", timeMs: 5000 });
    const other = "1b6f4c1e-2a7d-4b8e-9f00-123456789abc.wav";
    state = editorReducer(state, {
      type: "setShowAudio",
      audio: { fileId: other, durationMs: 0 },
    });
    expect(state.show.audio.fileId).toBe(other);
    expect(state.currentTimeMs).toBe(0);
    expect(isDirty(state)).toBe(true);
  });

  it("ignores a decoded duration that matches the stored one", () => {
    const state = initialEditorState(withAudio());
    const same = editorReducer(state, {
      type: "setShowAudio",
      audio: { fileId, durationMs: 10_000 },
    });
    expect(same).toBe(state);
  });
});

describe("timeline keys", () => {
  const key = (k: string) => ({
    key: k,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
  });

  it("toggles play with Space and nudges with arrows", () => {
    const store = makeStore({ audio: { fileId, durationMs: 10_000 } });
    store.dispatch({ type: "setAudioStatus", status: "ready" });
    const handle = timelineKeys(store);
    expect(handle(key(" "))).toBe(true);
    expect(store.getState().playing).toBe(true);
    handle(key(" "));
    expect(store.getState().playing).toBe(false);

    handle(key("ArrowRight"));
    handle(key("ArrowRight"));
    expect(store.getState().currentTimeMs).toBe(200);
    handle(key("ArrowLeft"));
    expect(store.getState().currentTimeMs).toBe(100);
    expect(store.getState().seekSeq).toBe(3);
    expect(handle(key("x"))).toBe(false);
  });
});
