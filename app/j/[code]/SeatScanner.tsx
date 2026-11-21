"use client";

import { useEffect, useRef, useState } from "react";
import {
  Detector,
  solvePose,
  type Detection,
  type Match,
  type Pose,
} from "@/lib/positioning/detector";
import {
  focalFromFov,
  fovFromFocal,
  project,
} from "@/lib/positioning/geometry";
import {
  DEFAULT_FOV,
  OrientationTrack,
  SweepCalibrator,
  focalFromHomography,
  robust,
} from "@/lib/positioning/lens";
import { ANCHOR, CORNERS, H, W } from "@/lib/positioning/pattern";
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
const SWEEP_TIMEOUT_MS = 30_000;
/** How long the screen must sit still in a guide box to count. */
const GUIDE_HOLD_MS = 700;
/** Boxes to hold the screen in before the sweep stops with what it has. */
const GUIDE_STEPS = 3;
/** How close (fraction of the view's width) counts as in the box. */
const GUIDE_TOLERANCE = 0.06;
/** Rough camera-to-callback delay when the browser doesn't report it. */
const FRAME_LATENCY_MS = 40;
/**
 * The sweep assumes the phone only turns. A hand sweep also moves the camera
 * a few centimetres, which up close makes the screen slide further than the
 * turn explains and the lens look too long (distances come out too big).
 * Only sweep from far enough back for that to be negligible.
 */
const SWEEP_MIN_DISTANCE_M = 6;

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
  /** The seat, and how the camera's field of view was known. */
  onFound: (seat: Point, lensNote: string) => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [progress, setProgress] = useState(0);
  // One short instruction for what the phone needs right now.
  const [hint, setHint] = useState("Point at the big screen");
  const [sweeping, setSweeping] = useState(false);
  const [guideStep, setGuideStep] = useState(0);
  // Which way to turn the phone: -1 left, 1 right, 0 none (held, or lost).
  const [turn, setTurn] = useState<-1 | 0 | 1>(0);
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
    // Guided camera measurement: the screen goes into a box on one side of
    // the view, then the other, then back (three pauses, two clean turns).
    let guideZone = 0;
    let guideOffset = 0;
    let holdMs = 0;
    let lastFrameAt = 0;
    // `?sweep=1` forces the guided measurement at any distance, for testing.
    const forceSweep = new URLSearchParams(window.location.search).has("sweep");

    const stop = () => {
      stopped = true;
      stopMotion();
      stream?.getTracks().forEach((t) => t.stop());
    };

    const finish = () => {
      if (stopped) return;
      stop();
      // A measurement outside what phone cameras do is a bad reading.
      if (measured && !plausibleFov(measured.fov)) measured = null;
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
      found(
        roomToVenuePoint(room, cfg),
        `Camera ${final.fov.toFixed(0)}°, ${LENS_NOTE[final.source]}`,
      );
    };
    finishRef.current = finish;

    const startSweep = () => {
      phase = "sweep";
      sweepStarted = performance.now();
      guideZone = 0;
      guideOffset = 0;
      holdMs = 0;
      setSweeping(true);
      setGuideStep(0);
      setProgress(0);
      navigator.vibrate?.(30);
    };

    // Where the box for the current step sits, whether the screen is in it,
    // and how long it has been held there.
    const nextGuide = (
      found: Detection,
      view: ViewMap,
      dt: number,
    ): Guide | null => {
      const t = targetOnView(found, view);
      if (!t) return null;
      if (!guideOffset) {
        // Far enough to turn the camera a few degrees, near enough that the
        // whole screen stays in view.
        guideOffset = Math.min(0.24, 0.5 - t.halfWidth / view.cw - 0.03);
        if (guideOffset < 0.1) {
          // The screen fills the view: no room to move it. Skip this step.
          finish();
          return null;
        }
      }
      const side = guideZone % 2 === 0 ? -1 : 1;
      const boxX = view.cw * (0.5 + side * guideOffset);
      const inBox = Math.abs(t.x - boxX) < GUIDE_TOLERANCE * view.cw;
      const now = performance.now();
      const still = gyro.lastT === null || gyro.maxSpeed(now - 200, now) < 6;
      holdMs = inBox && still ? holdMs + dt : 0;
      if (holdMs >= GUIDE_HOLD_MS) {
        guideZone++;
        holdMs = 0;
        setGuideStep(guideZone);
        navigator.vibrate?.(25);
      }
      return {
        target: t,
        box: { ...t, x: boxX },
        inBox,
        hold: holdMs / GUIDE_HOLD_MS,
      };
    };

    // The steady frames are in. If the view pinned down the lens, or we
    // already know it, we're done. From far back, measure it with a sweep;
    // up close the sweep is unreliable and the typical lens is close enough.
    const afterHold = (w: number, h: number) => {
      if (forceSweep && gyro.lastT !== null) return startSweep();
      const p = robust(perspective);
      if (p && p.n >= 10 && p.spread < 0.03) {
        const fov = fovFromFocal(p.median, w, h);
        if (plausibleFov(fov)) {
          measured = { fov, source: "view" };
          return finish();
        }
      }
      if (lens.source === "remembered" || gyro.lastT === null) return finish();
      const rough = combine(samples, lens.fov);
      const distanceM = rough
        ? Math.hypot(rough.x, rough.z) * latest.current.positioning.targetWidthM
        : 0;
      if (distanceM < SWEEP_MIN_DISTANCE_M) return finish();
      startSweep();
    };

    const onFrame = (t: number) => {
      const frame = grabber.grab(video);
      if (!frame) return;
      const { gray, w, h } = frame;
      const found = detector.detect(gray, w, h);
      const now = performance.now();
      const dt = lastFrameAt ? Math.min(100, now - lastFrameAt) : 0;
      lastFrameAt = now;
      const view = viewMap(overlayRef.current, video, w, h);
      const guide =
        phase === "sweep" && found && view ? nextGuide(found, view, dt) : null;
      // Turning the phone moves the screen the other way across the view, so
      // to bring it into the box, turn away from the box.
      setTurn(
        guide && !guide.inBox && Math.abs(guide.box.x - guide.target.x) > 24
          ? guide.box.x > guide.target.x
            ? -1
            : 1
          : 0,
      );
      if (stopped) return;
      drawOverlay(view, detector, found, guide);
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
          setHint("Hold still");
        } else {
          setHint(
            detector.anchors.length
              ? "Get all four corners in view"
              : "Point at the big screen",
          );
        }
        if (samples.length >= SAMPLES) afterHold(w, h);
        return;
      }

      setProgress(
        Math.min(1, Math.max(sweep.progress, guideZone / GUIDE_STEPS)),
      );
      if (!found) setHint("Keep the whole screen in view");
      else if (guide?.inBox) setHint("Hold it there");
      else setHint("Move the screen inside the box");
      const res = sweep.result();
      if (res) {
        measured = { fov: fovFromFocal(res.f, w, h), source: "sweep" };
        finish();
      } else if (
        guideZone >= GUIDE_STEPS ||
        performance.now() - sweepStarted > SWEEP_TIMEOUT_MS
      ) {
        const guess = sweep.bestGuess();
        if (guess)
          measured = { fov: fovFromFocal(guess, w, h), source: "sweep" };
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
      {sweeping && turn !== 0 && !error ? (
        <div
          className={styles.turnArrow}
          role="img"
          aria-label={turn < 0 ? "Turn left" : "Turn right"}
        >
          <svg
            viewBox="0 0 48 48"
            style={{ transform: turn < 0 ? "scaleX(-1)" : undefined }}
          >
            <path d="M8 24h30M26 11l13 13-13 13" />
          </svg>
        </div>
      ) : null}
      <div className={styles.viewfinder} aria-hidden>
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className={styles.scanHud}>
        {error ? (
          <>
            <p className={styles.label}>Couldn’t find you</p>
            <p className={styles.scanMessage} role="alert">
              {error}
            </p>
          </>
        ) : (
          <>
            {sweeping ? (
              <p className={styles.scanStep}>
                Step {Math.min(GUIDE_STEPS, guideStep + 1)} of {GUIDE_STEPS}
              </p>
            ) : null}
            <p className={styles.scanMessage} aria-live="polite">
              {hint}
            </p>
            <div className={styles.progress} aria-hidden>
              <i style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
          </>
        )}
        <button
          type="button"
          className={styles.secondary}
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

/** Long-side fields of view phone main cameras actually have. */
function plausibleFov(fov: number): boolean {
  return fov >= 50 && fov <= 85;
}

const LENS_NOTE: Record<Lens["source"], string> = {
  view: "measured from your view",
  sweep: "measured from your sweep",
  remembered: "measured earlier",
  default: "typical phone",
};

/** How processing pixels map onto the overlay (same as object-fit: cover). */
type ViewMap = {
  ctx: CanvasRenderingContext2D;
  cw: number;
  ch: number;
  s: number;
  ox: number;
  oy: number;
};

/** Something on the overlay: centre and half-size, in CSS pixels. */
type OnView = { x: number; y: number; halfWidth: number; halfHeight: number };

/** The box the screen should go into, and how far along the hold is. */
type Guide = {
  target: OnView;
  box: OnView;
  inBox: boolean;
  /** 0..1 of the hold. */
  hold: number;
};

function viewMap(
  canvas: HTMLCanvasElement | null,
  video: HTMLVideoElement,
  w: number,
  h: number,
): ViewMap | null {
  if (!canvas || !video.videoWidth) return null;
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
    canvas.width = cw * dpr;
    canvas.height = ch * dpr;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const s = Math.max(cw / vw, ch / vh) * (vw / w);
  return { ctx, cw, ch, s, ox: (cw - w * s) / 2, oy: (ch - h * s) / 2 };
}

/** Where the four anchors are on the overlay, as a centre and half-size. */
function targetOnView(found: Detection, view: ViewMap): OnView | null {
  if (found.corners.length !== 4) return null;
  const xs = found.corners.map((c) => view.ox + c.x * view.s);
  const ys = found.corners.map((c) => view.oy + c.y * view.s);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    halfWidth: (maxX - minX) / 2,
    halfHeight: (maxY - minY) / 2,
  };
}

/** What the detector sees, drawn over the video. */
function drawOverlay(
  view: ViewMap | null,
  detector: Detector,
  found: Detection | null,
  guide: Guide | null,
) {
  if (!view) return;
  const { ctx, cw, ch, s, ox, oy } = view;
  ctx.clearRect(0, 0, cw, ch);
  if (guide) drawGuide(ctx, guide);

  const P = (x: number, y: number): [number, number] => [
    ox + x * s,
    oy + y * s,
  ];

  if (!found) {
    // Anchors seen but not yet matched: a box tight around each one.
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    for (const { box } of detector.anchors) {
      const [x0, y0] = P(box.minX, box.minY);
      const [x1, y1] = P(box.maxX, box.maxY);
      const pad = 3;
      ctx.beginPath();
      ctx.roundRect(
        x0 - pad,
        y0 - pad,
        x1 - x0 + pad * 2,
        y1 - y0 + pad * 2,
        (x1 - x0) * 0.18,
      );
      ctx.stroke();
    }
    return;
  }

  // LEDs the phone has read get a small lit pixel.
  ctx.fillStyle = "rgba(74, 222, 128, 0.9)";
  for (const m of found.matches) {
    ctx.beginPath();
    ctx.roundRect(ox + m.x * s - 2, oy + m.y * s - 2, 4, 4, 1);
    ctx.fill();
  }

  // Locked on: each anchor's own rounded square, projected through the
  // target's perspective so the outline wraps it exactly, and the target's
  // edges drawn between the anchors, stopping short of their outlines.
  const hm = found.homography;
  const toScreen = (u: number, v: number) => {
    const q = project(hm, u, v);
    return q ? P(q[0], q[1]) : null;
  };
  const margin = 0.1;
  const half = ANCHOR.outer + margin;
  ctx.strokeStyle = "#4ade80";
  ctx.lineWidth = 2;
  for (const [u, v] of CORNERS) {
    ctx.beginPath();
    roundedSquare(u, v, half, ANCHOR.outerRound + margin).forEach(
      ([pu, pv], i) => {
        const q = toScreen(pu, pv);
        if (!q) return;
        if (i) ctx.lineTo(q[0], q[1]);
        else ctx.moveTo(q[0], q[1]);
      },
    );
    ctx.closePath();
    ctx.stroke();
  }
  const gap = half + 0.25;
  const edges: [number, number, number, number][] = [
    [gap, 0, W - gap, 0],
    [W, gap, W, H - gap],
    [W - gap, H, gap, H],
    [0, H - gap, 0, gap],
  ];
  ctx.beginPath();
  for (const [u0, v0, u1, v1] of edges) {
    const a = toScreen(u0, v0);
    const b = toScreen(u1, v1);
    if (!a || !b) continue;
    ctx.moveTo(a[0], a[1]);
    ctx.lineTo(b[0], b[1]);
  }
  ctx.stroke();
}

/**
 * The box the screen should move into, filling green while the screen is
 * held there.
 */
function drawGuide(ctx: CanvasRenderingContext2D, guide: Guide) {
  const { box, inBox, hold } = guide;
  const pad = 10;
  const x = box.x - box.halfWidth - pad;
  const y = box.y - box.halfHeight - pad;
  const bw = (box.halfWidth + pad) * 2;
  const bh = (box.halfHeight + pad) * 2;
  const r = Math.min(bw, bh) * 0.08;
  if (inBox) {
    ctx.fillStyle = `rgba(74, 222, 128, ${0.12 + 0.3 * hold})`;
    ctx.beginPath();
    ctx.roundRect(x, y, bw, bh, r);
    ctx.fill();
  }
  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = inBox ? "#4ade80" : "rgba(255,255,255,0.95)";
  ctx.setLineDash(inBox ? [] : [10, 8]);
  ctx.beginPath();
  ctx.roundRect(x, y, bw, bh, r);
  ctx.stroke();
  ctx.restore();
}

/** Points around a rounded square centred on (u, v), in pattern units. */
function roundedSquare(
  u: number,
  v: number,
  half: number,
  r: number,
): [number, number][] {
  const out: [number, number][] = [];
  const c = half - r;
  // Corner arcs clockwise from top-right; straight edges join them.
  const corners: [number, number, number][] = [
    [c, -c, -Math.PI / 2],
    [c, c, 0],
    [-c, c, Math.PI / 2],
    [-c, -c, Math.PI],
  ];
  for (const [cx, cy, start] of corners) {
    for (let k = 0; k <= 6; k++) {
      const t = start + (k / 6) * (Math.PI / 2);
      out.push([u + cx + r * Math.cos(t), v + cy + r * Math.sin(t)]);
    }
  }
  return out;
}
