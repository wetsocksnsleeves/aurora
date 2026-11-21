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

type DeviceInfo = Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">;

/** What a camera can do, as far as choosing the main one goes. */
export type CameraTraits = { torch: boolean; autofocus: boolean };

/**
 * Android back cameras, as Chrome names them: "camera2 N, facing back" or
 * "camera N, facing back" (Samsung S23). Other browsers (iPhone Safari)
 * name them differently and already open the main camera: none here.
 */
export function androidBackCameras(
  devices: readonly DeviceInfo[],
): { deviceId: string; label: string; n: number }[] {
  const out: { deviceId: string; label: string; n: number }[] = [];
  for (const d of devices) {
    if (d.kind !== "videoinput") continue;
    const m = /(\d+),\s*facing back/i.exec(d.label);
    if (m) out.push({ deviceId: d.deviceId, label: d.label, n: Number(m[1]) });
  }
  return out;
}

/**
 * Back cameras, most likely main first. The main camera nearly always has
 * the flash and autofocus; ultra-wides are usually fixed focus without a
 * flash. Then names that say "ultra" or "tele" go last, then the lowest
 * number (the main camera on nearly every phone). Cameras in `avoid` (seen
 * to be ultra-wide) go to the very end.
 */
export function rankBackCameras(
  cameras: readonly { deviceId: string; label: string; n: number }[],
  traits: ReadonlyMap<string, CameraTraits>,
  avoid: readonly string[] = [],
): string[] {
  const score = (c: { deviceId: string; label: string }) => {
    const t = traits.get(c.deviceId);
    let s = 0;
    if (t?.torch) s += 4;
    if (t?.autofocus) s += 2;
    if (NOT_MAIN.test(c.label)) s -= 3;
    if (avoid.includes(c.deviceId)) s -= 100;
    return s;
  };
  return [...cameras]
    .sort((a, b) => score(b) - score(a) || a.n - b.n)
    .map((c) => c.deviceId);
}

/** The former `mainBackCamera`: the best back camera by name alone. */
export function mainBackCamera(devices: readonly DeviceInfo[]): string | null {
  return rankBackCameras(androidBackCameras(devices), new Map())[0] ?? null;
}

function traitsOf(track: MediaStreamTrack | undefined): CameraTraits {
  const caps = (track?.getCapabilities?.() ?? {}) as MediaTrackCapabilities & {
    torch?: boolean;
    focusMode?: string[];
  };
  return {
    torch: caps.torch === true,
    autofocus: caps.focusMode?.includes("continuous") ?? false,
  };
}

// -- Camera memory ---------------------------------------------------------

/** v2: v1 could remember a camera before it had shown a picture. */
const CAMERA_KEY = "lightshow-camera-v2";

type CameraMemory = {
  /** The camera that showed pictures last time. */
  chosen: string | null;
  /** Cameras a scan measured as ultra-wide. */
  avoid: string[];
};

function readCameraMemory(): CameraMemory {
  try {
    const saved = JSON.parse(
      localStorage.getItem(CAMERA_KEY) ?? "{}",
    ) as Partial<CameraMemory>;
    return {
      chosen: typeof saved.chosen === "string" ? saved.chosen : null,
      avoid: Array.isArray(saved.avoid)
        ? saved.avoid.filter((a) => typeof a === "string")
        : [],
    };
  } catch {
    return { chosen: null, avoid: [] };
  }
}

function writeCameraMemory(memory: CameraMemory): void {
  try {
    localStorage.setItem(CAMERA_KEY, JSON.stringify(memory));
  } catch {
    // Not remembered: the next scan chooses again.
  }
}

/** A scan found this camera to be an ultra-wide: don't pick it again. */
export function avoidCamera(deviceId: string): void {
  const memory = readCameraMemory();
  writeCameraMemory({
    chosen: memory.chosen === deviceId ? null : memory.chosen,
    avoid: [...new Set([...memory.avoid, deviceId])],
  });
}

// -- Opening ---------------------------------------------------------------

export type RearCamera = {
  stream: MediaStream;
  deviceId: string;
  label: string;
  /** Other back cameras to try, best first (Android only). */
  others: string[];
  /** Every camera's name, and how this one was chosen, for the debug view. */
  cameras: string[];
  how: string;
};

function open(video: MediaTrackConstraints): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ audio: false, video });
}

/** Open a camera by id, at full size, with continuous focus if it has it. */
export async function openCamera(deviceId: string): Promise<MediaStream> {
  const stream = await open({ ...VIDEO, deviceId: { exact: deviceId } });
  const track = stream.getVideoTracks()[0];
  // Ask again if it came back small (a format kept from an earlier opening).
  const { width = 0, height = 0 } = track?.getSettings() ?? {};
  if (Math.max(width, height) < 1280) {
    await track?.applyConstraints(VIDEO).catch(() => {});
  }
  focusContinuously(stream);
  return stream;
}

function focusContinuously(stream: MediaStream): void {
  stream
    .getVideoTracks()[0]
    ?.applyConstraints({
      advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet],
    })
    .catch(() => {});
}

function stopAll(stream: MediaStream): void {
  stream.getTracks().forEach((t) => t.stop());
}

/**
 * Open the main back camera. Browsers can only be asked for "a back
 * camera", and Chrome on Android often opens an ultra-wide or telephoto
 * lens. On Android: keep the browser's camera if it has the flash and
 * autofocus (the main camera), else switch to the lowest numbered back
 * camera, or to the one that showed pictures last time (`confirmCamera`).
 * Other browsers keep their choice.
 */
export async function openRearCamera(
  /** Progress lines for the debug view. */
  status: (line: string) => void = () => {},
): Promise<RearCamera> {
  // Camera names are only listed once permission is granted.
  status("opening the back camera");
  const stream = await withTimeout(
    open({ ...VIDEO, facingMode: { ideal: "environment" } }),
    OPEN_TIMEOUT_MS * 2,
  );
  const first = stream.getVideoTracks()[0];
  const firstId = first?.getSettings().deviceId ?? "";
  const result: RearCamera = {
    stream,
    deviceId: firstId,
    label: first?.label ?? "",
    others: [],
    cameras: [],
    how: "browser's choice",
  };
  let backs: ReturnType<typeof androidBackCameras> = [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    result.cameras = devices
      .filter((d) => d.kind === "videoinput")
      .map((d) => d.label || "?");
    backs = androidBackCameras(devices);
  } catch {
    // No list: keep the browser's choice.
  }
  focusContinuously(stream);
  if (backs.length < 2) return result;

  // Only what we know without opening other cameras: opening an extra lens
  // can hang, and a hung camera blocks the rest.
  const memory = readCameraMemory();
  const firstTraits = traitsOf(first);
  // By name and number only: features are known for the open camera alone,
  // and comparing it with cameras we haven't looked at isn't fair.
  const ranked = rankBackCameras(backs, new Map(), memory.avoid);
  const known = new Set(backs.map((b) => b.deviceId));
  let target: string;
  let how: string;
  if (memory.chosen && known.has(memory.chosen)) {
    target = memory.chosen;
    how = "remembered";
  } else if (
    firstTraits.torch &&
    firstTraits.autofocus &&
    !memory.avoid.includes(firstId)
  ) {
    target = firstId;
    how = "browser's choice, has flash and autofocus";
  } else {
    target = ranked[0]!;
    how = "lowest numbered back camera";
  }
  const others = ranked.filter((id) => id !== target);
  if (target === firstId) return { ...result, others, how };

  const n = backs.find((b) => b.deviceId === target)?.n;
  status(`switching to camera ${n}`);
  stopAll(stream);
  await pause(RELEASE_MS);
  try {
    const next = await withTimeout(openCamera(target), OPEN_TIMEOUT_MS);
    return {
      ...result,
      stream: next,
      deviceId: target,
      label: next.getVideoTracks()[0]?.label ?? "",
      others,
      how,
    };
  } catch {
    // That camera won't open: don't try it again, use the browser's choice.
    avoidCamera(target);
    status("going back to the browser's camera");
    return reopenBrowserChoice(
      { ...result, others: others.filter((id) => id !== firstId) },
      `camera ${n} didn't open`,
    );
  }
}

/** The camera showed pictures: open it straight away next time. */
export function confirmCamera(deviceId: string): void {
  if (!deviceId) return;
  const memory = readCameraMemory();
  if (memory.chosen === deviceId) return;
  writeCameraMemory({
    chosen: deviceId,
    avoid: memory.avoid.filter((id) => id !== deviceId),
  });
}

/** How long a camera may take to open before we give up on it. */
const OPEN_TIMEOUT_MS = 3000;
/** A breath between closing one camera and opening the next. */
const RELEASE_MS = 300;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `opening`, or a rejection after `ms`. A camera that opens after it timed
 * out is closed straight away, so it doesn't stay busy.
 */
function withTimeout(
  opening: Promise<MediaStream>,
  ms: number,
): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      reject(new Error("camera took too long to open"));
    }, ms);
    opening.then(
      (stream) => {
        clearTimeout(timer);
        if (late) stopAll(stream);
        else resolve(stream);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function reopenBrowserChoice(
  result: RearCamera,
  why: string,
): Promise<RearCamera> {
  const stream = await withTimeout(
    open({ ...VIDEO, facingMode: { ideal: "environment" } }),
    OPEN_TIMEOUT_MS * 2,
  );
  focusContinuously(stream);
  const track = stream.getVideoTracks()[0];
  return {
    ...result,
    stream,
    deviceId: track?.getSettings().deviceId ?? "",
    label: track?.label ?? "",
    how: `browser's choice (${why})`,
  };
}

/** This camera showed no picture: forget it, and don't pick it again. */
export function forgetCamera(deviceId: string): void {
  if (deviceId) avoidCamera(deviceId);
  else {
    const memory = readCameraMemory();
    writeCameraMemory({ chosen: null, avoid: memory.avoid });
  }
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
