"use client";

import { useEditorSelector } from "@/components/editor/store-context";
import { useMusicChooser } from "./MusicChooser";
import styles from "./room.module.css";

/**
 * First steps, over the room while the show is empty. Each ticks off as it
 * happens; the music step opens the music chooser.
 */
export function Coach({
  phonesIn,
  screenHref,
}: {
  phonesIn: number;
  screenHref: string;
}) {
  const chooseMusic = useMusicChooser();
  const hasMusic = useEditorSelector((s) => s.show.audio.fileId !== "");
  const title = useEditorSelector((s) => s.show.audio.title);
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
          : "Open the big screen so phones can join",
      href: phonesIn > 0 ? undefined : screenHref,
    },
    {
      done: hasMusic,
      text: hasMusic
        ? title
          ? `Music added: ${title}`
          : "Music added"
        : "Add music (optional)",
      action: hasMusic ? undefined : chooseMusic,
    },
    {
      done: false,
      text: "Drag an effect onto the timeline",
    },
    { done: false, text: "Start the show" },
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
