import { DEFAULT_FOV } from "@/lib/positioning/lens";
import type { OrientationTrack } from "@/lib/positioning/lens";

/**
 * Browser plumbing for finding a seat with the camera (SPEC 2.4): the rear
 * camera, the gyro, and remembering this phone's measured field of view.
 * The maths is in `lib/positioning`.
 */

/** Longest side the detector runs at. Bigger is slower, not much better. */
const MAX_PROCESS_SIDE = 1280;

/**
 * Ask for motion sensor access. iOS needs this called inside a tap handler,
 * before anything else awaits, so call it first thing in the click.
 */
export function requestMotionPermission(): Promise<boolean> {
  if (typeof DeviceMotionEvent === "undefined") return Promise.resolve(false);
  const ask = (
    DeviceMotionEvent as unknown as {
      requestPermission?: () => Promise<"granted" | "denied">;
    }
  ).requestPermission;
  if (typeof ask !== "function") return Promise.resolve(true);
  return ask()
    .then((answer) => answer === "granted")
    .catch(() => false);
}

/** Feed `devicemotion` rotation rates into `track` until the returned stop. */
export function followMotion(track: OrientationTrack): () => void {
  const onMotion = (e: DeviceMotionEvent) => {
    const r = e.rotationRate;
    if (!r || r.alpha == null || r.beta == null || r.gamma == null) return;
    track.push(performance.now(), [r.beta, r.gamma, r.alpha]);
  };
  window.addEventListener("devicemotion", onMotion);
  return () => window.removeEventListener("devicemotion", onMotion);
}

export function cameraSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

const VIDEO: MediaTrackConstraints = {
  width: { ideal: 1920 },
  height: { ideal: 1080 },
};

/** Back lenses that aren't the main camera, when the browser names them. */
const NOT_MAIN = /ultra|wide|tele|macro|depth|tof|zoom|mono/i;

/**
 * The main back camera's device id, when the browser's choice may not be
 * it. Chrome on Android names cameras "camera2 N, facing back" or
 * "camera N, facing back" (Samsung S23), and "facing environment" often
 * opens an ultra-wide or telephoto lens; the lowest numbered back camera is
 * the main one on nearly every phone. Other browsers (iPhone Safari)
 * already pick the main camera: null.
 */
export function mainBackCamera(
  devices: readonly Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">[],
): string | null {
  let best: { id: string; n: number } | null = null;
  for (const d of devices) {
    if (d.kind !== "videoinput") continue;
    const m = /(\d+),\s*facing back/i.exec(d.label);
    if (!m || NOT_MAIN.test(d.label)) continue;
    const n = Number(m[1]);
    if (!best || n < best.n) best = { id: d.deviceId, n };
  }
  return best?.id ?? null;
}

export type RearCamera = {
  stream: MediaStream;
  label: string;
  /** Every camera's name, for the debug view. */
  cameras: string[];
};

/**
 * Open the main back camera. Asks for "the back camera" first (camera
 * names are only listed once permission is granted), then switches to the
 * main one if the browser picked another lens.
 */
export async function openRearCamera(): Promise<RearCamera> {
  let stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { ...VIDEO, facingMode: { ideal: "environment" } },
  });
  let cameras: string[] = [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    cameras = devices
      .filter((d) => d.kind === "videoinput")
      .map((d) => d.label || "?");
    const main = mainBackCamera(devices);
    const current = stream.getVideoTracks()[0]?.getSettings().deviceId;
    if (main && current !== main) {
      stream.getTracks().forEach((t) => t.stop());
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...VIDEO, deviceId: { exact: main } },
      });
    }
  } catch {
    // Keep whatever camera we have.
  }
  const track = stream.getVideoTracks()[0];
  // Keep refocusing as the phone moves, where the browser allows it.
  track
    ?.applyConstraints({
      advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
    })
    .catch(() => {});
  return { stream, label: track?.label ?? "", cameras };
}

/** Copies video frames into a greyscale buffer at processing size. */
export class FrameGrabber {
  private readonly canvas = document.createElement("canvas");
  private readonly ctx = this.canvas.getContext("2d", {
    willReadFrequently: true,
  });
  private gray = new Uint8Array(0);

  grab(
    video: HTMLVideoElement,
  ): { gray: Uint8Array; w: number; h: number } | null {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || !this.ctx) return null;
    const k = Math.min(1, MAX_PROCESS_SIDE / Math.max(vw, vh));
    const w = Math.round(vw * k);
    const h = Math.round(vh * k);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.gray = new Uint8Array(w * h);
    }
    this.ctx.drawImage(video, 0, 0, w, h);
    const rgba = this.ctx.getImageData(0, 0, w, h).data;
    const gray = this.gray;
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
      gray[i] = (rgba[j]! * 77 + rgba[j + 1]! * 150 + rgba[j + 2]! * 29) >> 8;
    }
    return { gray, w, h };
  }
}

// -- Field of view memory ----------------------------------------------------

/**
 * v3: kept per camera, since Android phones can open different lenses, and
 * wide lenses are no longer thrown away.
 */
const LENS_KEY = "lightshow-lens-v3";

/** Long-side fields of view of phone cameras, main to ultra-wide. */
export function plausibleFov(fov: number): boolean {
  return fov >= 45 && fov <= 125;
}

/** How this phone knows its camera's field of view. */
export type LensSource = "view" | "sweep" | "remembered" | "default";
export type Lens = { fov: number; source: LensSource };

/**
 * Measurements are kept per camera and video size, since the browser may
 * crop the sensor differently at different resolutions.
 */
function lensKey(camera: string, w: number, h: number): string {
  return `${camera}|${Math.max(w, h)}x${Math.min(w, h)}`;
}

export function rememberedLens(camera: string, w: number, h: number): Lens {
  try {
    const saved = JSON.parse(localStorage.getItem(LENS_KEY) ?? "{}") as Record<
      string,
      number
    >;
    const fov = saved[lensKey(camera, w, h)];
    if (typeof fov === "number" && plausibleFov(fov)) {
      return { fov, source: "remembered" };
    }
  } catch {
    // Private mode or bad JSON: fall through to the default.
  }
  return { fov: DEFAULT_FOV, source: "default" };
}

export function rememberLens(
  camera: string,
  w: number,
  h: number,
  fov: number,
): void {
  try {
    const saved = JSON.parse(localStorage.getItem(LENS_KEY) ?? "{}") as Record<
      string,
      number
    >;
    saved[lensKey(camera, w, h)] = fov;
    localStorage.setItem(LENS_KEY, JSON.stringify(saved));
  } catch {
    // Not remembered; the next scan measures again.
  }
}
