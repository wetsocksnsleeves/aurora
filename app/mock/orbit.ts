/**
 * Drag to orbit, wheel to zoom, double-click to reset. Writes `--yaw`,
 * `--pitch` and `--zoom` on `target`, which the stylesheet turns into the
 * world's transform.
 */

const HOME = { yaw: 0, pitch: 60, zoom: 1 };
const PITCH_MIN = 0;
const PITCH_MAX = 82;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const DEG_PER_PX = 0.3;

export function attachOrbit(
  surface: HTMLElement,
  target: HTMLElement,
): () => void {
  let { yaw, pitch, zoom } = HOME;
  let drag: { id: number; x: number; y: number } | null = null;

  const apply = () => {
    target.style.setProperty("--yaw", `${yaw}deg`);
    target.style.setProperty("--pitch", `${pitch}deg`);
    target.style.setProperty("--zoom", String(zoom));
  };

  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    surface.setPointerCapture(e.pointerId);
  };
  const move = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    yaw += (e.clientX - drag.x) * DEG_PER_PX;
    pitch = clamp(
      pitch - (e.clientY - drag.y) * DEG_PER_PX,
      PITCH_MIN,
      PITCH_MAX,
    );
    drag.x = e.clientX;
    drag.y = e.clientY;
    apply();
  };
  const up = (e: PointerEvent) => {
    if (drag?.id === e.pointerId) drag = null;
  };
  const wheel = (e: WheelEvent) => {
    e.preventDefault();
    zoom = clamp(zoom * Math.exp(-e.deltaY * 0.0015), ZOOM_MIN, ZOOM_MAX);
    apply();
  };
  const reset = () => {
    ({ yaw, pitch, zoom } = HOME);
    apply();
  };

  surface.addEventListener("pointerdown", down);
  surface.addEventListener("pointermove", move);
  surface.addEventListener("pointerup", up);
  surface.addEventListener("pointercancel", up);
  surface.addEventListener("wheel", wheel, { passive: false });
  surface.addEventListener("dblclick", reset);
  apply();

  return () => {
    surface.removeEventListener("pointerdown", down);
    surface.removeEventListener("pointermove", move);
    surface.removeEventListener("pointerup", up);
    surface.removeEventListener("pointercancel", up);
    surface.removeEventListener("wheel", wheel);
    surface.removeEventListener("dblclick", reset);
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
