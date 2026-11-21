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

export function openRearCamera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
  });
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

/** v2: measurements from before the close-range sweep fix are not trusted. */
const LENS_KEY = "lightshow-lens-v2";

/** How this phone knows its camera's field of view. */
export type LensSource = "view" | "sweep" | "remembered" | "default";
export type Lens = { fov: number; source: LensSource };

/**
 * Measurements are kept per video size, since the browser may crop the
 * sensor differently at different resolutions.
 */
function lensKey(w: number, h: number): string {
  return `${Math.max(w, h)}x${Math.min(w, h)}`;
}

export function rememberedLens(w: number, h: number): Lens {
  try {
    const saved = JSON.parse(localStorage.getItem(LENS_KEY) ?? "{}") as Record<
      string,
      number
    >;
    const fov = saved[lensKey(w, h)];
    if (typeof fov === "number" && fov >= 50 && fov <= 85) {
      return { fov, source: "remembered" };
    }
  } catch {
    // Private mode or bad JSON: fall through to the default.
  }
  return { fov: DEFAULT_FOV, source: "default" };
}

export function rememberLens(w: number, h: number, fov: number): void {
  try {
    const saved = JSON.parse(localStorage.getItem(LENS_KEY) ?? "{}") as Record<
      string,
      number
    >;
    saved[lensKey(w, h)] = fov;
    localStorage.setItem(LENS_KEY, JSON.stringify(saved));
  } catch {
    // Not remembered; the next scan measures again.
  }
}
