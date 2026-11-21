import { uploadAudio } from "@/components/editor/api";
import type { EditorStore } from "@/components/editor/store";
import { analyseAudio } from "@/lib/audio-analysis";
import { generateLightShow } from "@/lib/light-show-generator";
import type { Toast } from "./edit-actions";
import type { DecodedAudio } from "./timeline/playback";

const ACCEPT = ".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4,audio/x-m4a";

/**
 * Ask for a music file and upload it. Must run from a click: browsers only
 * open the file picker for a user gesture.
 */
export function pickMusic(store: EditorStore, toast: Toast): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ACCEPT;
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    store.dispatch({ type: "setAudioStatus", status: "uploading" });
    toast(`Uploading ${file.name}…`);
    try {
      const { fileId } = await uploadAudio(file);
      // The length is filled in once the track has decoded.
      store.dispatch({
        type: "setShowAudio",
        audio: { fileId, durationMs: 0 },
      });
      toast("Music added");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.dispatch({
        type: "setAudioStatus",
        status: "error",
        error: message,
      });
      toast(`Couldn’t upload: ${message}`);
    }
  };
  input.click();
}

/**
 * Make a whole show from the music (`lib/light-show-generator.ts`): find
 * the beats and loudness, then lay out flashes, waves and strobes to match.
 * Replaces the clips (undoable) and sets the snap grid to the beat.
 */
export async function createFromMusic(
  store: EditorStore,
  audio: DecodedAudio,
  toast: Toast,
): Promise<void> {
  // Let the "Creating…" state paint before the analysis blocks the page.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const { samples, sampleRate } = halve(audio.samples, audio.sampleRate);
  const analysis = analyseAudio(samples, sampleRate);
  const clips = generateLightShow(analysis, { shapes: [] });
  store.dispatch({ type: "replaceClips", clips });
  const bpm = Math.round(analysis.bpm * 10) / 10;
  store.dispatch({
    type: "setSnap",
    snap: {
      mode: "beat",
      bpm,
      subdivision: 4,
      beatOffsetMs: analysis.beats[0]?.tMs ?? 0,
    },
  });
  toast(`Made ${clips.length} clips at ${bpm} BPM`, true);
}

/** Half the sample rate (pairs averaged): plenty for beats, twice as fast. */
function halve(
  samples: Float32Array,
  sampleRate: number,
): { samples: Float32Array; sampleRate: number } {
  if (sampleRate < 32_000) return { samples, sampleRate };
  const out = new Float32Array(samples.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = (samples[2 * i]! + samples[2 * i + 1]!) / 2;
  }
  return { samples: out, sampleRate: sampleRate / 2 };
}
