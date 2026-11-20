"use client";

import { useEffect, useRef } from "react";
import { fromPx, VENUE_ASPECT, type Size } from "./geometry";
import { DEFAULT_LAYERS, type CanvasLayer } from "./layers";
import { useEditorSelector, useEditorStore } from "./store-context";
import { toolHandlers, type ToolContext, type ToolPointer } from "./tools";
import styles from "./editor.module.css";

/** Two presses within this time and distance count as a double click. */
const DOUBLE_CLICK_MS = 400;
const DOUBLE_CLICK_PX = 6;

/**
 * The venue drawing surface. Keeps a fixed aspect ratio (VENUE_ASPECT) and
 * scales with its container, so normalised shapes look the same at any size.
 *
 * It redraws every layer, bottom to top, on any store change (batched to one
 * draw per animation frame), and forwards pointer events to the active tool.
 */
export function VenueCanvas({
  layers = DEFAULT_LAYERS,
  onResize,
}: {
  layers?: CanvasLayer[];
  /** Called with the canvas size in CSS pixels, for code outside the canvas (key handling). */
  onResize?: (size: Size) => void;
}) {
  const store = useEditorStore();
  const cursor = useEditorSelector((s) => toolHandlers[s.tool].cursor);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef<Size>({ width: 0, height: 0 });
  const onResizeRef = useRef(onResize);
  const layersRef = useRef(layers);
  const scheduleDrawRef = useRef<() => void>(() => {});

  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    layersRef.current = layers;
    scheduleDrawRef.current();
  }, [layers]);

  // Drawing: size the backing store to the element and redraw on change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let frame = 0;

    const draw = () => {
      frame = 0;
      const size = sizeRef.current;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.width, size.height);
      const state = store.getState();
      for (const layer of layersRef.current) {
        ctx.save();
        layer.draw({ ctx, size, state });
        ctx.restore();
      }
    };
    const scheduleDraw = () => {
      if (frame === 0) frame = requestAnimationFrame(draw);
    };
    scheduleDrawRef.current = scheduleDraw;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      sizeRef.current = { width: rect.width, height: rect.height };
      onResizeRef.current?.(sizeRef.current);
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      draw();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();
    const unsubscribe = store.subscribe(scheduleDraw);

    return () => {
      observer.disconnect();
      unsubscribe();
      if (frame !== 0) cancelAnimationFrame(frame);
      scheduleDrawRef.current = () => {};
    };
  }, [store]);

  // Pointer input goes to the active tool.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let last = { time: -Infinity, x: 0, y: 0, count: 0 };

    const ctx = (): ToolContext => ({ store, size: sizeRef.current });
    const pointer = (e: PointerEvent, clickCount = 1): ToolPointer => {
      const rect = canvas.getBoundingClientRect();
      return {
        point: fromPx(
          { x: e.clientX - rect.left, y: e.clientY - rect.top },
          sizeRef.current,
        ),
        clickCount,
        shiftKey: e.shiftKey,
      };
    };
    const tool = () => toolHandlers[store.getState().tool];

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      canvas.focus();
      canvas.setPointerCapture(e.pointerId);
      const near =
        e.timeStamp - last.time < DOUBLE_CLICK_MS &&
        Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_CLICK_PX;
      const count = near ? last.count + 1 : 1;
      last = { time: e.timeStamp, x: e.clientX, y: e.clientY, count };
      tool().onPointerDown?.(pointer(e, count), ctx());
    };
    const onMove = (e: PointerEvent) =>
      tool().onPointerMove?.(pointer(e), ctx());
    const onUp = (e: PointerEvent) => {
      if (canvas.hasPointerCapture(e.pointerId))
        canvas.releasePointerCapture(e.pointerId);
      tool().onPointerUp?.(pointer(e), ctx());
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
    };
  }, [store]);

  return (
    <div
      className={styles.canvasFrame}
      style={{
        aspectRatio: String(VENUE_ASPECT),
        // Fill the width, but never taller than 55% of the viewport, so the
        // transport and waveform fit below it on a laptop screen.
        width: `min(100%, calc(55dvh * ${VENUE_ASPECT}))`,
      }}
    >
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        tabIndex={0}
        aria-label="Venue canvas"
        data-testid="venue-canvas"
        style={{ cursor }}
      />
    </div>
  );
}
