"use client";

import { Inter, Space_Grotesk } from "next/font/google";
import { use, useEffect, useRef, useState } from "react";
import { decodeFrame, hexToRgbBytes, parseSeats } from "@/lib/crowd-stream";
import { STATE_COLORS } from "@/lib/host-map";
import type { Point } from "@/lib/types";
import styles from "./mock.module.css";
import type { MockScene } from "./scene";

const body = Inter({ subsets: ["latin"], weight: ["300", "400", "500"] });
const wordmark = Space_Grotesk({ subsets: ["latin"], weight: "700" });

const DEFAULT_STREAM_PORT = 8787;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 5000;
const COUNT_EVERY_MS = 250;

type Status = "waiting" | "live";

const STAT_STATES = ["connected", "seated", "syncing", "standby"] as const;
type Counts = Record<(typeof STAT_STATES)[number] | "playing", number>;
const NO_COUNTS: Counts = {
  connected: 0,
  seated: 0,
  syncing: 0,
  standby: 0,
  playing: 0,
};
const STATE_BYTES = STAT_STATES.map((s) => hexToRgbBytes(STATE_COLORS[s]));

/** Counts clients by the state colour they show; any other colour is playing. */
function countStates(rgb: Uint8Array): Counts {
  const counts = { ...NO_COUNTS };
  for (let i = 0; i + 2 < rgb.length; i += 3) {
    const k = STATE_BYTES.findIndex(
      (c) => c[0] === rgb[i] && c[1] === rgb[i + 1] && c[2] === rgb[i + 2],
    );
    counts[k < 0 ? "playing" : STAT_STATES[k]]++;
  }
  return counts;
}

/**
 * The simulated crowd in 3D (`scripts/sim.ts --stream`): a mock arena with
 * every simulated phone as an LED panel on the raked floor, in the language
 * of the participant page's room view. Testing only: it shows whichever
 * session the local sim is streaming. `?stream=` picks the stream port.
 */
export default function MockPage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const streamParam = use(props.searchParams).stream;
  const port = parsePort(streamParam);

  const stage = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>("waiting");
  const [code, setCode] = useState<string | null>(null);
  const [clients, setClients] = useState(0);
  const [counts, setCounts] = useState<Counts>(NO_COUNTS);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    let disposed = false;
    let scene: MockScene | null = null;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let backoff = RECONNECT_MIN_MS;
    let seatCount = 0;
    let latest: Uint8Array | null = null;

    const connect = () => {
      if (disposed) return;
      const socket = new WebSocket(`ws://${window.location.hostname}:${port}`);
      ws = socket;
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        backoff = RECONNECT_MIN_MS;
      };
      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          const r = parseSeats(event.data);
          if (!r.ok) return;
          const seats: (Point | null)[] = r.value.seats;
          seatCount = seats.length;
          latest = null;
          setCode(r.value.code.toUpperCase());
          setClients(seatCount);
          setStatus("live");
          scene?.setSeats(seats, r.value.venue);
          return;
        }
        const r = decodeFrame(event.data, seatCount);
        if (!r.ok) return;
        latest = r.value.rgb;
        scene?.setFrame(r.value.rgb);
      };
      socket.onclose = () => {
        if (ws === socket) ws = null;
        if (disposed) return;
        setStatus("waiting");
        retry = setTimeout(connect, backoff);
        backoff = Math.min(RECONNECT_MAX_MS, backoff * 1.6);
      };
    };

    // three.js loads only on this route, and only in the browser.
    void import("./scene").then(({ createMockScene }) => {
      if (disposed) return;
      scene = createMockScene(el);
      connect();
    });

    const counter = setInterval(() => {
      if (latest) setCounts(countStates(latest));
    }, COUNT_EVERY_MS);

    return () => {
      disposed = true;
      clearTimeout(retry);
      clearInterval(counter);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      scene?.dispose();
    };
  }, [port]);

  return (
    <main className={`${styles.shell} ${body.className}`}>
      <div className={styles.stage} ref={stage} />
      <header className={styles.top}>
        <span className={`${styles.wordmark} ${wordmark.className}`}>
          lightshow
        </span>
        <p className={styles.label} role="status">
          {status === "live"
            ? `Stream live · ${code}`
            : "Waiting for simulation"}
        </p>
      </header>

      {status === "waiting" ? (
        <div className={styles.waiting}>
          <p className={styles.label}>Waiting for simulation</p>
          <LedLoader />
          <p className={styles.fine}>
            Run <code>npx tsx scripts/sim.ts --stream {port}</code>
          </p>
        </div>
      ) : null}

      {status !== "waiting" ? (
        <div className={styles.stats}>
          <Stat value={clients} caption="Clients" />
          {STAT_STATES.map((s) => (
            <Stat
              key={s}
              value={counts[s]}
              caption={s}
              color={STATE_COLORS[s]}
            />
          ))}
          <Stat value={counts.playing} caption="playing" color="#fff" />
        </div>
      ) : null}
    </main>
  );
}

function parsePort(raw: string | string[] | undefined): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_STREAM_PORT;
}

function LedLoader() {
  return (
    <div className={styles.loader} aria-hidden>
      {Array.from({ length: 7 }, (_, i) => (
        <i key={i} style={{ animationDelay: `${i * 0.12}s` }} />
      ))}
    </div>
  );
}

function Stat({
  value,
  caption,
  color,
}: {
  value: number;
  caption: string;
  color?: string;
}) {
  return (
    <div className={styles.stat}>
      <p className={styles.statValue}>{value}</p>
      <p className={styles.label}>
        {color ? (
          <i
            className={styles.dot}
            style={{ background: color, color }}
            aria-hidden
          />
        ) : null}
        {caption}
      </p>
    </div>
  );
}
