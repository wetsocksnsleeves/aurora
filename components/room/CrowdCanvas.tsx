"use client";

import { useEffect, useRef } from "react";
import { useEditorStore } from "@/components/editor/store-context";
import type { HostClient } from "@/app/sessions/host-client";
import { colorAt } from "@/lib/compile";
import { STATE_COLORS, liveDotColor } from "@/lib/host-map";
import type { ParticipantSummary } from "@/lib/protocol";
import type { Show } from "@/lib/types";
import styles from "./room.module.css";

const UNLIT = "#000000";
/** Unlit phones are black; draw them dim grey so the crowd stays visible. */
const UNLIT_DRAWN = "#2a2a2a";

/**
 * One square per seated phone, over the room canvas. While the show plays,
 * each takes the colour its phone shows now. Otherwise ready phones preview
 * the show at the playhead, so the crowd is the editor's preview; phones not
 * ready yet are drawn faint in their state colour.
 *
 * Repainted every animation frame from refs, so participant updates and the
 * playhead never re-render React.
 */
export function CrowdCanvas({
  client,
  participants,
  liveShow,
  T0,
}: {
  client: HostClient;
  participants: readonly ParticipantSummary[];
  /** The room's show while it plays (T0 set and the clock ready), else null. */
  liveShow: Show | null;
  T0: number | null;
}) {
  const store = useEditorStore();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const input = useRef({ participants, liveShow, T0 });
  useEffect(() => {
    input.current = { participants, liveShow, T0 };
  }, [participants, liveShow, T0]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);

      const { participants, liveShow, T0 } = input.current;
      const live =
        liveShow && T0 !== null
          ? liveDotColor(liveShow, client.clock.serverNow() - T0)
          : null;
      const { show, currentTimeMs } = store.getState();
      const side = Math.max(5, Math.min(10, rect.width / 70));
      const glow = participants.length <= 200;
      for (const p of participants) {
        if (p.x === null || p.y === null) continue;
        let color: string;
        let alpha = 1;
        if (live) {
          color = live(p);
          if (color === UNLIT) color = UNLIT_DRAWN;
          if (p.state !== "playing") alpha = 0.35;
        } else if (p.state === "standby" || p.state === "playing") {
          const lit = colorAt(show, { x: p.x, y: p.y }, currentTimeMs);
          color = lit === UNLIT ? STATE_COLORS.standby : lit;
          if (lit === UNLIT) alpha = 0.55;
        } else {
          color = STATE_COLORS[p.state];
          alpha = 0.35;
        }
        const x = p.x * rect.width;
        const y = p.y * rect.height;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        if (glow) {
          ctx.shadowColor = color;
          ctx.shadowBlur = 8;
        }
        ctx.beginPath();
        ctx.roundRect(x - side / 2, y - side / 2, side, side, side / 4);
        ctx.fill();
        if (p.degraded) {
          ctx.shadowBlur = 0;
          ctx.strokeStyle = "#ef4444";
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x - side, y - side, side * 2, side * 2);
        }
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [client, store]);

  return <canvas ref={canvasRef} className={styles.crowd} aria-hidden />;
}
