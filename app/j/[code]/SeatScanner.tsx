"use client";

import { useEffect, useRef, useState } from "react";
import {
  Detector,
  solvePose,
  type Detection,
  type Match,
  type Pose,
} from "@/lib/positioning/detector";
import { focalFromFov, fovFromFocal } from "@/lib/positioning/geometry";
import {
  DEFAULT_FOV,
  OrientationTrack,
  SweepCalibrator,
  focalFromHomography,
  robust,
} from "@/lib/positioning/lens";
import { roomToVenuePoint } from "@/lib/positioning/seat";
import type { Point, PositioningConfig } from "@/lib/types";
import {
  FrameGrabber,
  followMotion,
  openRearCamera,
  rememberLens,
  rememberedLens,
  type Lens,
} from "./camera-seat";
import styles from "./participant.module.css";

/** Steady frames to collect before working out the position. */
const SAMPLES = 15;
/** Give up on the sweep after this long and use the best lens we have. */
const SWEEP_TIMEOUT_MS = 15_000;
/** Rough camera-to-callback delay when the browser doesn't report it. */
const FRAME_LATENCY_MS = 40;

type Sample = { matches: Match[]; w: number; h: number };

/**
 * Find the participant's seat by pointing the camera at the big screen
 * (SPEC 2.4). Collects steady frames, works out this phone's field of view
 * (from the view itself, a short sweep, or a remembered measurement), then
 * turns the camera position into a point in the venue box.
 */
export function SeatScanner({
  positioning,
  motion,
  onFound,
  onCancel,
}: {
  positioning: PositioningConfig;
  /** Motion permission, requested in the tap that opened the scanner. */
  motion: Promise<boolean>;
  onFound: (seat: Point, summary: string) => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [message, setMessage] = useState("Point your camera at the big screen");
  const [progress, setProgress] = useState(0);
  const [sweeping, setSweeping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finishRef = useRef<() => void>(() => {});

  // The scan runs once per mount; read the latest props through a ref.
  const latest = useRef({ positioning, onFound });
  useEffect(() => {
    latest.current = { positioning, onFound };
  });

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let stopped = false;
    let stream: MediaStream | null = null;
    let stopMotion = () => {};
    const detector = new Detector();
    const grabber = new FrameGrabber();
    const gyro = new OrientationTrack();
    const sweep = new SweepCalibrator(gyro);
    const samples: Sample[] = [];
    const perspective: number[] = [];
    let lens: Lens = { fov: DEFAULT_FOV, source: "default" };
    let measured: Lens | null = null;
    let phase: "hold" | "sweep" = "hold";
    let sweepStarted = 0;
    let misses = 0;

    const stop = () => {
      stopped = true;
      stopMotion();
      stream?.getTracks().forEach((t) => t.stop());
    };

    const finish = () => {
      if (stopped) return;
      stop();
      const final = measured ?? lens;
      if (measured && video.videoWidth) {
        rememberLens(video.videoWidth, video.videoHeight, measured.fov);
      }
      const pose = combine(samples, final.fov);
      if (!pose) {
        setError("Couldn't get a fix. Go back and try again.");
        return;
      }
      const { positioning: cfg, onFound: found } = latest.current;
      const room = {
        x: pose.x * cfg.targetWidthM,
        z: pose.z * cfg.targetWidthM,
      };
      // Anywhere in the venue box counts; outside it, the nearest edge.
      found(roomToVenuePoint(room, cfg), describe(room));
    };
    finishRef.current = finish;

    const startSweep = () => {
      phase = "sweep";
      sweepStarted = performance.now();
      setSweeping(true);
      setProgress(0);
      setMessage("Slowly sweep left and right, pausing at each end");
      navigator.vibrate?.(30);
    };

    // The steady frames are in. If the view pinned down the lens, or we
    // already know it, we're done; otherwise measure it with a sweep.
    const afterHold = (w: number, h: number) => {
      const p = robust(perspective);
      if (p && p.n >= 10 && p.spread < 0.03) {
        measured = { fov: fovFromFocal(p.median, w, h), source: "view" };
        return finish();
      }
      if (lens.source === "remembered" || gyro.lastT === null) return finish();
      startSweep();
    };

    const onFrame = (t: number) => {
      const frame = grabber.grab(video);
      if (!frame) return;
      const { gray, w, h } = frame;
      const found = detector.detect(gray, w, h);
      drawOverlay(overlayRef.current, detector, found, w, h, video);
      if (found) {
        if (!found.coarse) {
          perspective.push(focalFromHomography(found.homography, w, h));
        }
        sweep.addFrame(t, found.homography, w, h);
      }

      if (phase === "hold") {
        const pose = found
          ? solvePose(found.matches, {
              f: focalFromFov(lens.fov, w, h),
              cx: w / 2,
              cy: h / 2,
            })
          : null;
        if (found && pose && pose.rms < 3) {
          samples.push({ matches: found.matches, w, h });
          setProgress(samples.length / SAMPLES);
          setMessage("Got it, hold still");
        } else if (++misses > 30) {
          setMessage(
            detector.anchors.length
              ? "Get all four corners of the screen in view"
              : "Point your camera at the big screen",
          );
        }
        if (samples.length >= SAMPLES) afterHold(w, h);
        return;
      }

      setProgress(sweep.progress);
      if (!found) setMessage("Keep the whole screen in view");
      else setMessage("Slowly sweep left and right, pausing at each end");
      const res = sweep.result();
      if (res) {
        measured = { fov: fovFromFocal(res.f, w, h), source: "sweep" };
        finish();
      } else if (performance.now() - sweepStarted > SWEEP_TIMEOUT_MS) {
        finish();
      }
    };

    const loop = (_now: number, meta?: VideoFrameCallbackMetadata) => {
      if (stopped) return;
      // Use the capture time when the browser reports it, so frames line up
      // with gyro readings; otherwise assume a typical lag.
      const t = meta?.captureTime ?? performance.now() - FRAME_LATENCY_MS;
      onFrame(t);
      if (stopped) return;
      if (video.requestVideoFrameCallback)
        video.requestVideoFrameCallback(loop);
      else requestAnimationFrame((now) => loop(now));
    };

    void (async () => {
      if (await motion) stopMotion = followMotion(gyro);
      try {
        stream = await openRearCamera();
      } catch {
        setError(
          "Couldn't open the camera. Allow camera access for this site, then try again.",
        );
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      video.srcObject = stream;
      await video.play().catch(() => {});
      lens = rememberedLens(video.videoWidth, video.videoHeight);
      loop(performance.now());
    })();

    return stop;
  }, [motion]);

  return (
    <main className={styles.scanner} data-screen="scan">
      <video
        ref={videoRef}
        className={styles.scanVideo}
        playsInline
        muted
        autoPlay
      />
      <canvas ref={overlayRef} className={styles.scanOverlay} />
      <div className={styles.scanHud}>
        {error ? (
          <p className={styles.scanMessage} role="alert">
            {error}
          </p>
        ) : (
          <>
            <p className={styles.scanMessage} aria-live="polite">
              {message}
            </p>
            <div className={styles.progress} aria-hidden>
              <i style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            {sweeping ? (
              <div className={styles.sweepHint} aria-hidden>
                ⟵ ⟶
              </div>
            ) : null}
          </>
        )}
        <button
          type="button"
          className={styles.linkButton}
          onClick={() => {
            // During the sweep this is "Skip": keep the position, guess the lens.
            if (sweeping && !error) finishRef.current();
            else onCancel();
          }}
        >
          {sweeping && !error ? "Skip" : "Back"}
        </button>
      </div>
    </main>
  );
}

function median(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The middle of the steady frames' positions, with the final lens. */
function combine(samples: readonly Sample[], fov: number): Pose | null {
  const poses = samples
    .map((s) =>
      solvePose(s.matches, {
        f: focalFromFov(fov, s.w, s.h),
        cx: s.w / 2,
        cy: s.h / 2,
      }),
    )
    .filter((p): p is Pose => p !== null);
  if (!poses.length) return null;
  // Ambiguous frames can't tell left from right; only use them if we must.
  const sure = poses.filter((p) => !p.ambiguous);
  const use = sure.length >= 5 ? sure : poses;
  return {
    x: median(use.map((p) => p.x)),
    y: median(use.map((p) => p.y)),
    z: median(use.map((p) => p.z)),
    rms: median(use.map((p) => p.rms)),
    ambiguous: sure.length < 5,
    points: Math.round(median(use.map((p) => p.points))),
  };
}

function describe(room: { x: number; z: number }): string {
  const side =
    Math.abs(room.x) < 0.3
      ? "near the middle"
      : `${Math.abs(room.x).toFixed(1)} m ${room.x < 0 ? "left" : "right"} of centre`;
  return `about ${room.z.toFixed(1)} m back, ${side}`;
}

/** What the detector sees, drawn over the video (same mapping as object-fit: cover). */
function drawOverlay(
  canvas: HTMLCanvasElement | null,
  detector: Detector,
  found: Detection | null,
  w: number,
  h: number,
  video: HTMLVideoElement,
) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const s = Math.max(cw / vw, ch / vh) * (vw / w);
  const ox = (cw - w * s) / 2;
  const oy = (ch - h * s) / 2;

  ctx.lineWidth = 3;
  ctx.strokeStyle = found ? "#4ade80" : "#ffcc33";
  for (const a of detector.anchors) {
    ctx.beginPath();
    ctx.arc(
      ox + a.x * s,
      oy + a.y * s,
      Math.max(10, (a.size * s) / 2 + 4),
      0,
      Math.PI * 2,
    );
    ctx.stroke();
  }
  if (!found) return;
  ctx.fillStyle = "#4ade80";
  for (const m of found.matches) {
    ctx.fillRect(ox + m.x * s - 2, oy + m.y * s - 2, 4, 4);
  }
}
