"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { HostClient } from "@/app/sessions/host-client";
import { activeClips } from "@/components/editor/clips";
import type { EditorStore } from "@/components/editor/store";
import { coverage } from "@/lib/compile";
import type { ParticipantSummary } from "@/lib/protocol";

/** How close (px) a press must be to a phone's dot to pick it up. */
const PICK_PX = 10;

export type DraggedPhone = { id: string; x: number; y: number } | null;

/**
 * Pointer input on the room that isn't drawing: drag a phone to put it
 * somewhere else (sent to the server on release; the phone lights up blue
 * while it's held), or click to select the
 * clip lighting that spot at the playhead. Listens in the capture phase so
 * it runs before the canvas's drawing tools, and only while the select
 * tool is active.
 */
export function useRoomPointer(
  frameRef: RefObject<HTMLElement | null>,
  opts: {
    store: EditorStore;
    client: HostClient;
    participants: readonly ParticipantSummary[];
    /** Phones can be moved (not while the show plays). */
    canPlace: boolean;
    /** Clips can be selected. */
    canSelect: boolean;
  },
): RefObject<DraggedPhone> {
  const dragged = useRef<DraggedPhone>(null);
  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const local = (e: PointerEvent) => {
      const rect = frame.getBoundingClientRect();
      return {
        px: e.clientX - rect.left,
        py: e.clientY - rect.top,
        x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
        y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
        rect,
      };
    };
    const phoneAt = (e: PointerEvent) => {
      const { px, py, rect } = local(e);
      let best: ParticipantSummary | null = null;
      let bestD = PICK_PX;
      for (const p of latest.current.participants) {
        if (p.x === null || p.y === null) continue;
        const d = Math.hypot(p.x * rect.width - px, p.y * rect.height - py);
        if (d <= bestD) {
          best = p;
          bestD = d;
        }
      }
      return best;
    };
    const selecting = () => latest.current.store.getState().tool === "select";

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || !selecting()) return;
      const { store, canPlace, canSelect } = latest.current;
      const phone = canPlace ? phoneAt(e) : null;
      if (phone) {
        e.stopPropagation();
        e.preventDefault();
        const { x, y } = local(e);
        dragged.current = { id: phone.id, x, y };
        frame.setPointerCapture(e.pointerId);
        // Light the phone up so it can be spotted in the room.
        latest.current.client.highlight(phone.id);
        return;
      }
      if (!canSelect) return;
      const { x, y } = local(e);
      const state = store.getState();
      const t = state.currentTimeMs;
      const hit = activeClips(state.show.clips, t)
        .reverse()
        .find((c) => coverage(c, { x, y }, t) > 0);
      e.stopPropagation();
      store.dispatch({
        type: "select",
        selection: hit ? { kind: "clip", id: hit.id } : null,
      });
    };
    const onMove = (e: PointerEvent) => {
      if (dragged.current) {
        const { x, y } = local(e);
        dragged.current = { ...dragged.current, x, y };
        return;
      }
      if (!selecting()) return;
      frame.style.cursor = latest.current.canPlace && phoneAt(e) ? "grab" : "";
    };
    const onUp = (e: PointerEvent) => {
      const d = dragged.current;
      if (!d) return;
      dragged.current = null;
      if (frame.hasPointerCapture(e.pointerId)) {
        frame.releasePointerCapture(e.pointerId);
      }
      latest.current.client.highlight(null);
      latest.current.client.placeParticipant(d.id, d.x, d.y);
    };
    frame.addEventListener("pointerdown", onDown, true);
    frame.addEventListener("pointermove", onMove);
    frame.addEventListener("pointerup", onUp);
    frame.addEventListener("pointercancel", onUp);
    return () => {
      frame.removeEventListener("pointerdown", onDown, true);
      frame.removeEventListener("pointermove", onMove);
      frame.removeEventListener("pointerup", onUp);
      frame.removeEventListener("pointercancel", onUp);
    };
  }, [frameRef]);

  return dragged;
}
