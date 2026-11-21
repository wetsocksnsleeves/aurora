import type { ReactNode } from "react";
import type { Clip } from "@/lib/types";
import type { EffectId } from "./effects";

/** Line icons, 24 x 24, drawn with currentColor. */
const PATHS = {
  undo: (
    <>
      <path d="M9 14L4 9l5-5" />
      <path d="M4 9h10a6 6 0 010 12h-3" />
    </>
  ),
  redo: (
    <>
      <path d="M15 14l5-5-5-5" />
      <path d="M20 9H10a6 6 0 000 12h3" />
    </>
  ),
  cut: (
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4L8.1 15.9M14.5 14.5L20 20M8.1 8.1L12 12" />
    </>
  ),
  duplicate: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" />
    </>
  ),
  delete: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  magnet: <path d="M6 3v8a6 6 0 0012 0V3M6 7h4M14 7h4" />,
  fit: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  keys: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </>
  ),
  flash: <path d="M13 2L4 14h7l-1 8 9-12h-7z" />,
  strobe: <path d="M3 12h2M7 12h2M11 12h2M15 12h2M19 12h2M5 7v10M13 7v10" />,
  pulse: <path d="M3 12h4l2-6 4 12 2-6h6" />,
  wave: <path d="M4 12h14M14 8l4 4-4 4" />,
  split: <path d="M12 4v16M4 12h4M16 12h4M7 9l-3 3 3 3M17 9l3 3-3 3" />,
  chase: (
    <>
      <rect x="3" y="6" width="4" height="12" rx="1" />
      <rect x="10" y="6" width="4" height="12" rx="1" opacity=".4" />
      <rect x="17" y="6" width="4" height="12" rx="1" opacity=".4" />
    </>
  ),
  sparkle: <path d="M12 3l2 6 6 1-5 4 2 7-5-4-5 4 2-7-5-4 6-1z" />,
  wash: <rect x="4" y="4" width="16" height="16" rx="3" />,
  draw: <path d="M4 20l4-1L19 8l-3-3L5 16zM14 7l3 3" />,
  brush: <path d="M4 17c3-6 6 2 9-4s5-4 7-6" />,
  shape: <path d="M5 5h14v14H5z" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  );
}

export function effectIcon(id: EffectId): IconName {
  return id;
}

/** The icon for a clip on the timeline. */
export function ClipIcon({ clip }: { clip: Clip }) {
  let name: IconName = "wash";
  const shape = clip.shape;
  if (clip.label === "Flash") name = "flash";
  else if (clip.blink) name = clip.blink.soft ? "pulse" : "strobe";
  else if (shape.kind === "pattern") name = shape.pattern;
  else if (shape.kind === "polygon") name = "shape";
  return <Icon name={name} size={13} />;
}
