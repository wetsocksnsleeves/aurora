"use client";

import { Inter, Space_Grotesk } from "next/font/google";
import QRCode from "qrcode";
import { useEffect, useRef } from "react";
import { EXTENT, QR_LABEL, W, drawPattern } from "@/lib/positioning/pattern";
import styles from "./screen.module.css";

const wordmarkFont = Space_Grotesk({ subsets: ["latin"], weight: "700" });
const labelFont = Inter({ subsets: ["latin"], weight: "400" });

/**
 * Draws the positioning target to fill the screen below the wordmark. The
 * target must stay pure white on pure black: that is what phones measure.
 * F toggles fullscreen.
 */
export function ScreenApp({
  code,
  joinUrl,
}: {
  code: string;
  joinUrl: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const url = joinUrl ?? `${window.location.origin}/j/${code}`;
    const qr = qrMatrix(url);
    let cancelled = false;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
      const scale = Math.min(w / EXTENT.w, h / EXTENT.h);
      const ox = (w - EXTENT.w * scale) / 2 - EXTENT.x0 * scale;
      const oy = (h - EXTENT.h * scale) / 2 - EXTENT.y0 * scale;
      drawPattern(ctx, scale, ox, oy, qr);

      ctx.fillStyle = "#fff";
      ctx.font = `400 ${QR_LABEL.size * scale}px ${labelFont.style.fontFamily}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.letterSpacing = `${0.12 * scale}px`;
      ctx.fillText(
        "SCAN TO JOIN",
        ox + QR_LABEL.u * scale,
        oy + QR_LABEL.v * scale,
      );
      // Where the target sits, for end-to-end checks of the drawn page.
      canvas.dataset.target = JSON.stringify({
        ox,
        oy,
        scale,
        width: W * scale,
      });
    };

    // Wait for the label font, or the first frame draws it in a fallback.
    void document.fonts.ready.then(() => {
      if (!cancelled) draw();
    });
    window.addEventListener("resize", draw);
    return () => {
      cancelled = true;
      window.removeEventListener("resize", draw);
    };
  }, [code, joinUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "f" && e.key !== "F") return;
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <main className={styles.page}>
      <div className={`${styles.mark} ${wordmarkFont.className}`}>
        lightshow
      </div>
      <canvas
        ref={canvasRef}
        className={styles.target}
        aria-label={`Positioning target and QR code for session ${code}`}
      />
    </main>
  );
}

/** The QR code's modules as a boolean matrix, for `drawPattern`. */
function qrMatrix(text: string): boolean[][] {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: "M" });
  return Array.from({ length: modules.size }, (_, r) =>
    Array.from({ length: modules.size }, (_, c) => !!modules.get(r, c)),
  );
}
