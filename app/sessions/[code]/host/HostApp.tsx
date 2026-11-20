"use client";

import Link from "next/link";
import QRCode from "qrcode";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { VenueView } from "@/components/venue/VenueView";
import {
  STATE_COLORS,
  STATE_LABELS,
  countByState,
  participantDots,
} from "@/lib/host-map";
import { PARTICIPANT_STATES } from "@/lib/types";
import { HostClient, browserHostDeps } from "../../host-client";
import styles from "./host.module.css";

/**
 * Host screen (SPEC 2.2): the venue with one dot per participant coloured by
 * state (5.3), a QR code for the join URL, the code as text, and counts per
 * state. Start/Stop arrive in chunk 5.
 */
export function HostApp({ code }: { code: string }) {
  const [client] = useState(() => new HostClient(code, browserHostDeps));
  const snapshot = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot,
  );

  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);

  const { session, participants, fatal, connection } = snapshot;
  const dots = useMemo(() => participantDots(participants), [participants]);
  const counts = useMemo(() => countByState(participants), [participants]);
  const qr = useQrSvg(session?.joinUrl ?? null);

  if (fatal) {
    return (
      <main className={styles.message}>
        <h1>
          {fatal === "unknown-session"
            ? "Session not found"
            : "Not the host of this session"}
        </h1>
        <p>
          {fatal === "unknown-session"
            ? `No session with code ${code}. The server may have restarted.`
            : `This browser tab did not create session ${code}, so it cannot host it.`}
        </p>
        <Link href="/">Back to the start page</Link>
      </main>
    );
  }

  return (
    <main className={styles.layout}>
      <section className={styles.mapPanel} aria-label="Venue map">
        {session ? (
          <VenueView
            venue={session.venue}
            dots={dots}
            label={`Venue map with ${dots.length} seated participants`}
          />
        ) : (
          <p className={styles.muted}>Connecting…</p>
        )}
      </section>

      <aside className={styles.side}>
        <div className={styles.qr}>
          {qr ? (
            // eslint-disable-next-line @next/next/no-img-element -- data URL
            <img src={qr} alt={`QR code for ${session?.joinUrl ?? ""}`} />
          ) : (
            <div className={styles.qrPlaceholder} />
          )}
        </div>
        <p className={styles.scan}>Scan to join, or open</p>
        <p className={styles.url}>{session?.joinUrl ?? "…"}</p>
        <p className={styles.code} aria-label="Join code">
          {code}
        </p>

        <ul className={styles.counts}>
          {PARTICIPANT_STATES.map((state) => (
            <li key={state} data-state={state}>
              <span
                className={styles.swatch}
                style={{ background: STATE_COLORS[state] }}
                aria-hidden
              />
              <span className={styles.countLabel}>{STATE_LABELS[state]}</span>
              <span className={styles.countValue}>{counts[state]}</span>
            </li>
          ))}
          <li className={styles.total} data-state="total">
            <span className={styles.swatch} aria-hidden />
            <span className={styles.countLabel}>Total</span>
            <span className={styles.countValue}>{counts.total}</span>
          </li>
        </ul>
        <p className={styles.legend}>
          <span className={styles.warningIcon} aria-hidden>
            ▲
          </span>{" "}
          marks a phone whose clock sync is degraded.
        </p>
        {connection !== "open" ? (
          <p className={styles.status}>
            {connection === "reconnecting" ? "Reconnecting…" : "Connecting…"}
          </p>
        ) : null}
      </aside>
    </main>
  );
}

/** The QR code for `text` as an SVG data URL, or null while rendering. */
function useQrSvg(text: string | null): string | null {
  const [qr, setQr] = useState<{ text: string; url: string } | null>(null);
  useEffect(() => {
    if (!text) return;
    let cancelled = false;
    QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M" })
      .then((svg) => {
        if (cancelled) return;
        setQr({
          text,
          url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [text]);
  return qr && qr.text === text ? qr.url : null;
}
