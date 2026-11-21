"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Toast } from "./edit-actions";

export type ToastState = { id: number; message: string; undoable: boolean };

/** One short message at a time, gone after a few seconds. */
export function useToast(): [ToastState | null, Toast] {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback<Toast>((message, undoable = false) => {
    window.clearTimeout(timer.current);
    setToast((t) => ({ id: (t?.id ?? 0) + 1, message, undoable }));
    timer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [toast, show];
}
