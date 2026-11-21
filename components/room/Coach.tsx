"use client";

import {
  useEditorSelector,
  useEditorStore,
} from "@/components/editor/store-context";
import type { Toast } from "./edit-actions";
import { pickMusic } from "./music";
import styles from "./room.module.css";

/**
 * First steps, over the room while the show is empty. Each ticks off as it
 * happens; the music step opens the file picker.
 */
export function Coach({
  phonesIn,
  screenHref,
  toast,
}: {
  phonesIn: number;
  screenHref: string;
  toast: Toast;
}) {
  const store = useEditorStore();
  const hasMusic = useEditorSelector((s) => s.show.audio.fileId !== "");
  const steps: {
    done: boolean;
    text: string;
    action?: () => void;
    href?: string;
  }[] = [
    {
      done: phonesIn > 0,
      text:
        phonesIn > 0
          ? `${phonesIn} ${phonesIn === 1 ? "phone has" : "phones have"} joined`
          : "Open the big screen. Phones scan it to join",
      href: phonesIn > 0 ? undefined : screenHref,
    },
    {
      done: hasMusic,
      text: hasMusic ? "Music added" : "Add your music (optional)",
      action: hasMusic ? undefined : () => pickMusic(store, toast),
    },
    {
      done: false,
      text: "Drag an effect onto the timeline, or create a show from the music",
    },
    { done: false, text: "Press Start show" },
  ];
  let n = 0;
  return (
    <div className={styles.coach}>
      <ol className={styles.steps}>
        {steps.map((step) => {
          const mark = step.done ? "✓" : String(++n);
          const body = (
            <>
              <b aria-hidden>{mark}</b>
              {step.text}
            </>
          );
          return (
            <li key={step.text} data-done={step.done || undefined}>
              {step.href ? (
                <a href={step.href} target="_blank" rel="noreferrer">
                  {body}
                </a>
              ) : step.action ? (
                <button type="button" onClick={step.action}>
                  {body}
                </button>
              ) : (
                <span>{body}</span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
