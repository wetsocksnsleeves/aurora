/**
 * Records the room view and the camera at the same time, as two files that
 * start together. The room view is the room's canvases (grid, clips, phones)
 * and the screen bar, drawn into one canvas each frame, with the show's
 * sound. The camera recording keeps the camera's own microphone.
 */

export type RecordingKind = "room" | "camera";

export type Recording = {
  kind: RecordingKind;
  blob: Blob;
  url: string;
  fileName: string;
};

/** A finished pair (or just the room, without a camera). */
export type Take = {
  id: number;
  startedAt: Date;
  durationMs: number;
  files: Recording[];
};

const TYPES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

/** The best format this browser can record: MP4 if it can, else WebM. */
export function recordingType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  return TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

/** Size of the recorded room view, in pixels (square, like the room). */
const ROOM_PX = 1080;
const FPS = 30;

export type RoomSource = {
  /** The element holding the room's canvases. */
  frame: HTMLElement;
  /** Width of the screen bar as a share of the room (to scale). */
  screenShare: () => number;
};

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Draws the room's canvases into one square canvas, every frame. */
function roomCompositor(room: RoomSource): {
  stream: MediaStream;
  stop: () => void;
} {
  const canvas = document.createElement("canvas");
  canvas.width = ROOM_PX;
  canvas.height = ROOM_PX;
  const ctx = canvas.getContext("2d")!;
  let raf = 0;
  const draw = () => {
    raf = requestAnimationFrame(draw);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, ROOM_PX, ROOM_PX);
    for (const layer of room.frame.querySelectorAll("canvas")) {
      if (layer.width > 0 && layer.height > 0) {
        ctx.drawImage(layer, 0, 0, ROOM_PX, ROOM_PX);
      }
    }
    // The screen, to scale, along the top edge.
    const w = room.screenShare() * ROOM_PX;
    ctx.fillStyle = "#fff";
    ctx.shadowColor = "rgba(255,255,255,0.6)";
    ctx.shadowBlur = 20;
    ctx.beginPath();
    ctx.roundRect((ROOM_PX - w) / 2, 0, w, 10, [0, 0, 6, 6]);
    ctx.fill();
    ctx.shadowBlur = 0;
  };
  draw();
  return {
    stream: canvas.captureStream(FPS),
    stop: () => cancelAnimationFrame(raf),
  };
}

function record(stream: MediaStream, type: string) {
  const recorder = new MediaRecorder(stream, {
    mimeType: type || undefined,
    videoBitsPerSecond: 8_000_000,
  });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  const done = new Promise<Blob>((resolve) => {
    recorder.onstop = () =>
      resolve(new Blob(chunks, { type: recorder.mimeType || type }));
  });
  recorder.start(1000);
  return { recorder, done };
}

let takes = 0;

/**
 * Start recording. `camera` may be null (room only). `music` is the show's
 * sound for the room recording. Call the returned `stop` to finish both.
 */
export function startRecording(opts: {
  room: RoomSource;
  camera: MediaStream | null;
  music: MediaStream | null;
}): { stop: () => Promise<Take> } {
  const type = recordingType();
  const ext = type.startsWith("video/mp4") ? "mp4" : "webm";
  const startedAt = new Date();
  const started = performance.now();

  const compositor = roomCompositor(opts.room);
  const roomStream = new MediaStream([
    ...compositor.stream.getVideoTracks(),
    ...(opts.music?.getAudioTracks() ?? []),
  ]);
  const runs: { kind: RecordingKind; run: ReturnType<typeof record> }[] = [
    { kind: "room", run: record(roomStream, type) },
  ];
  if (opts.camera) {
    runs.push({ kind: "camera", run: record(opts.camera, type) });
  }

  return {
    stop: async () => {
      for (const { run } of runs) {
        if (run.recorder.state !== "inactive") run.recorder.stop();
      }
      const files = await Promise.all(
        runs.map(async ({ kind, run }) => {
          const blob = await run.done;
          return {
            kind,
            blob,
            url: URL.createObjectURL(blob),
            fileName: `lightshow-${kind}-${stamp(startedAt)}.${ext}`,
          };
        }),
      );
      compositor.stop();
      compositor.stream.getTracks().forEach((t) => t.stop());
      return {
        id: ++takes,
        startedAt,
        durationMs: performance.now() - started,
        files,
      };
    },
  };
}
