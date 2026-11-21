"use client";

import { Inter, Space_Grotesk } from "next/font/google";
import type { CSSProperties, ReactNode } from "react";
import styles from "./participant.module.css";

/**
 * Shared look for the participant pages, in the big screen's language: pure
 * black, light type with spaced capitals, rounded-square LED pixels, and the
 * rainbow lightshow wordmark.
 */

const body = Inter({ subsets: ["latin"], weight: ["300", "400", "500"] });
const wordmark = Space_Grotesk({ subsets: ["latin"], weight: "700" });

/** Page frame: wordmark on top, content, actions at the bottom. */
export function Shell({
  screen,
  tone,
  children,
  actions,
}: {
  screen: string;
  /** Background accent. */
  tone?: "ready";
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <main
      className={`${styles.shell} ${tone === "ready" ? styles.ready : ""} ${body.className}`}
      data-screen={screen}
    >
      <header className={styles.top}>
        <span className={`${styles.wordmark} ${wordmark.className}`}>
          lightshow
        </span>
      </header>
      <div className={styles.content}>{children}</div>
      {actions ? <footer className={styles.actions}>{actions}</footer> : null}
    </main>
  );
}

/** A spaced-capitals label, like the big screen's "SCAN TO JOIN". */
export function Label({ children }: { children: ReactNode }) {
  return <p className={styles.label}>{children}</p>;
}

/** A row of LED pixels lighting in turn: the loading indicator. */
export function LedLoader() {
  return (
    <div className={styles.loader} aria-hidden>
      {Array.from({ length: 7 }, (_, i) => (
        <i key={i} style={{ animationDelay: `${i * 0.12}s` }} />
      ))}
    </div>
  );
}

/**
 * The room in 3D, like a car's surround view: an LED floor tilted away, the
 * big screen standing at the far edge, and the participant glowing where the
 * camera found them. The view zooms to fit the screen and the participant,
 * whatever the venue's size. Distances in metres.
 */
export function RoomView({
  back,
  across,
  screenWidthM,
}: {
  /** Out from the screen. */
  back: number;
  /** Right of the screen centre. */
  across: number;
  screenWidthM: number;
}) {
  // A square of floor deep enough to hold the participant with room behind.
  const span = Math.max(
    back * 1.6,
    Math.abs(across) * 2.6,
    screenWidthM * 2.2,
    2,
  );
  const you: CSSProperties = {
    left: `${clamp(50 + (across / span) * 100, 4, 96)}%`,
    top: `${clamp((back / span) * 100, 6, 96)}%`,
  };
  return (
    <div className={styles.room} aria-hidden>
      <div className={styles.floor}>
        <div
          className={styles.screenSlab}
          style={{ width: `${clamp((screenWidthM / span) * 100, 14, 90)}%` }}
        />
        <div className={styles.you} style={you}>
          <i className={styles.youPulse} />
          <i className={styles.youPixel} />
          <i className={styles.youBeam} />
        </div>
      </div>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** A big number with a small unit and a spaced-capitals caption. */
export function Stat({
  value,
  unit,
  caption,
}: {
  value: string;
  unit: string;
  caption: string;
}) {
  return (
    <div className={styles.stat}>
      <p className={styles.statValue}>
        {value}
        <span className={styles.statUnit}>{unit}</span>
      </p>
      <p className={styles.label}>{caption}</p>
    </div>
  );
}
