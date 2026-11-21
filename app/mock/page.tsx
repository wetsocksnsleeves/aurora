"use client";

import { Inter, Space_Grotesk } from "next/font/google";
import {
  use,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import {
  HostClient,
  ROOM_STORAGE_KEY,
  browserHostDeps,
  type HostFatal,
  type HostSnapshot,
} from "@/app/sessions/host-client";
import { VenueView } from "@/components/venue/VenueView";
import { showDurationMs } from "@/lib/compile";
import {
  STATE_COLORS,
  countByState,
  liveDotColor,
  showStatus,
} from "@/lib/host-map";
import { TARGET_SHARE_OF_SCREEN } from "@/lib/positioning/seat";
import type { ParticipantSummary } from "@/lib/protocol";
import { wsUrlFor } from "@/lib/ws-url";
import { createCrowd } from "./crowd";
import styles from "./mock.module.css";
import { attachOrbit } from "./orbit";
import {
  createSimPhones,
  type SimPhoneCounts,
  type SimPhones,
} from "./sim-phones";

const body = Inter({ subsets: ["latin"], weight: ["300", "400", "500"] });
const wordmark = Space_Grotesk({ subsets: ["latin"], weight: "700" });

const STAT_STATES = [
  "connected",
  "seated",
  "syncing",
  "standby",
  "playing",
] as const;
/** Screen width as a share of the floor before the room's size is known. */
const DEFAULT_SCREEN_SHARE = 0.55;
/**
 * The screen is drawn to scale against the room, but never narrower than
 * this: a crowd fitted wide would otherwise shrink it to a dot.
 */
const MIN_SCREEN_SHARE = 0.3;

const FATAL_TEXT: Record<HostFatal, (code: string) => string> = {
  "no-token": (code) =>
    `This browser does not host room ${code}. Open the mock in the browser that hosts it.`,
  "not-host": (code) =>
    `The server refused this browser's key for room ${code}.`,
  "unknown-session": (code) => `There is no room ${code} on this server.`,
};

/**
 * A hosted room in 3D, drawn with CSS 3D transforms in the language of the
 * participant page's `RoomView`: a tilted LED floor, the big screen standing
 * at its far edge, and every seated phone held upright at its seat, showing
 * the colour it shows (or its state colour, like the host map).
 *
 * `?code=` picks the room. The mock attaches as a host with the token this
 * browser keeps for that room, so it works in the browser that hosts it and
 * nowhere else. It never sends Start, Stop or edits. The side panel adds
 * simulated phones to the room from this tab (`sim-phones.ts`).
 */
export default function MockPage(props: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const raw = use(props.searchParams).code;
  const code = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase();
  return (
    <main className={`${styles.shell} ${body.className}`}>
      {code ? <RoomWatch key={code} code={code} /> : <CodeForm />}
    </main>
  );
}

function Header({ status }: { status?: string }) {
  return (
    <header className={styles.top}>
      <a href="/mock" className={`${styles.wordmark} ${wordmark.className}`}>
        lightshow
      </a>
      {status ? (
        <p className={styles.label} role="status">
          {status}
        </p>
      ) : null}
    </header>
  );
}

/** Asks for a room code, prefilled with the room this browser hosts. */
function CodeForm() {
  const hosted = useSyncExternalStore(noSubscribe, readHostedRoom, () => "");
  return (
    <>
      <Header />
      <form className={styles.centre} method="get" action="/mock">
        <label className={styles.label} htmlFor="code">
          Room code
        </label>
        <input
          // Remount once the stored code is read after hydration.
          key={hosted}
          id="code"
          name="code"
          className={styles.codeInput}
          defaultValue={hosted}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={16}
          required
          autoFocus
        />
        <button type="submit" className={styles.watch}>
          Watch
        </button>
        <p className={styles.fine}>
          Open this in the browser that hosts the room.
        </p>
      </form>
    </>
  );
}

function noSubscribe(): () => void {
  return () => {};
}

function readHostedRoom(): string {
  try {
    return window.localStorage.getItem(ROOM_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function RoomWatch({ code }: { code: string }) {
  const [client] = useState(() => new HostClient(code, browserHostDeps));
  const snapshot = useSyncExternalStore(
    client.subscribe,
    client.getSnapshot,
    client.getSnapshot,
  );
  const stage = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const crowdLayer = useRef<HTMLDivElement>(null);
  const latest = useRef<HostSnapshot>(snapshot);
  useEffect(() => {
    latest.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);

  // A tab back from hidden resyncs its clock (SPEC 4.3, 4.9).
  useEffect(() => {
    const onVisibility = () =>
      client.setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [client]);

  useEffect(() => {
    const surface = stage.current;
    const target = world.current;
    if (!surface || !target) return;
    return attachOrbit(surface, target);
  }, []);

  // Phones follow the participant list; colours follow the show clock.
  useEffect(() => {
    const layer = crowdLayer.current;
    if (!layer) return;
    const crowd = createCrowd(layer, styles.phone);
    const stateColor = (p: ParticipantSummary) => STATE_COLORS[p.state];
    let list: ParticipantSummary[] | null = null;
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const { participants, session, T0 } = latest.current;
      if (participants !== list) {
        list = participants;
        crowd.setPhones(participants);
      }
      crowd.paint(
        session && T0 !== null
          ? liveDotColor(session.show, client.clock.serverNow() - T0)
          : stateColor,
      );
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      crowd.dispose();
    };
  }, [client]);

  const { session, participants, room, T0, fatal, connection } = snapshot;

  // Re-render the status line's show clock while a show runs.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (T0 === null) return;
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [T0]);
  const counts = countByState(participants);
  const inRoom = counts.total - counts.disconnected;

  // The floor takes the room's proportions, and the screen its real width.
  const aspect = room ? room.widthM / room.depthM : 1;
  const floorSize = {
    "--fw": Math.min(1, aspect),
    "--fh": Math.min(1, 1 / aspect),
  } as CSSProperties;
  const screenShare =
    room && session
      ? Math.min(
          1,
          Math.max(
            MIN_SCREEN_SHARE,
            session.positioning.targetWidthM /
              TARGET_SHARE_OF_SCREEN /
              room.widthM,
          ),
        )
      : DEFAULT_SCREEN_SHARE;

  return (
    <>
      <div className={styles.stage} ref={stage}>
        <div className={styles.world} ref={world}>
          <div className={styles.floor} style={floorSize}>
            {session ? (
              <VenueView
                venue={session.venue}
                aspectRatio={aspect}
                className={styles.outline}
                label="Venue outline"
              />
            ) : null}
            <div
              className={styles.screen}
              style={{ width: `${screenShare * 100}%` }}
            />
            <div className={styles.crowd} ref={crowdLayer} />
          </div>
        </div>
      </div>

      <Header status={roomStatus(snapshot, client)} />

      {fatal ? (
        <div className={styles.centre}>
          <p className={styles.message}>{FATAL_TEXT[fatal](code)}</p>
          <a className={styles.watch} href="/mock">
            Try another code
          </a>
        </div>
      ) : connection !== "open" && !session ? (
        <div className={styles.centre}>
          <p className={styles.label}>Connecting to room {code}</p>
          <LedLoader />
        </div>
      ) : null}

      {session && !fatal ? <SimPanel code={code} /> : null}

      {session ? (
        <div className={styles.stats}>
          <Stat value={inRoom} caption="In the room" />
          {STAT_STATES.map((s) => (
            <Stat
              key={s}
              value={counts[s]}
              caption={s}
              color={s === "playing" && T0 !== null ? "#fff" : STATE_COLORS[s]}
            />
          ))}
        </div>
      ) : null}
    </>
  );
}

/** Wait for typing to pause before opening or closing phones. */
const SIM_APPLY_MS = 400;

/** A whole number of phones, or null while the box holds anything else. */
function parseCount(text: string): number | null {
  return /^\s*\d+\s*$/.test(text) ? Number.parseInt(text, 10) : null;
}

/** Side panel: how many simulated phones this tab keeps in the room. */
function SimPanel({ code }: { code: string }) {
  const sim = useRef<SimPhones | null>(null);
  const [draft, setDraft] = useState("0");
  const [counts, setCounts] = useState<SimPhoneCounts>({
    open: 0,
    joined: 0,
    ready: 0,
  });
  const count = parseCount(draft);

  useEffect(() => {
    const phones = createSimPhones(code, wsUrlFor(window.location));
    sim.current = phones;
    const poll = setInterval(() => setCounts(phones.counts()), 500);
    return () => {
      clearInterval(poll);
      phones.dispose();
      sim.current = null;
    };
  }, [code]);

  useEffect(() => {
    if (count === null) return;
    const id = setTimeout(() => sim.current?.setCount(count), SIM_APPLY_MS);
    return () => clearTimeout(id);
  }, [count]);

  return (
    <form
      className={styles.panel}
      aria-label="Simulated phones"
      onSubmit={(e) => {
        e.preventDefault();
        if (count !== null) sim.current?.setCount(count);
      }}
    >
      <label className={styles.label} htmlFor="sim-count">
        Simulated phones
      </label>
      <input
        id="sim-count"
        className={styles.countInput}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        value={draft}
        aria-invalid={count === null}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
      />
      <p className={styles.fine}>
        {counts.joined} of {counts.open} joined · {counts.ready} ready
      </p>
      <p className={styles.fine}>
        They join from this tab and leave when it closes.
      </p>
    </form>
  );
}

function roomStatus(snapshot: HostSnapshot, client: HostClient): string {
  const { code, session, T0, connection } = snapshot;
  if (connection === "reconnecting") return `Room ${code} · Reconnecting`;
  if (!session) return `Room ${code}`;
  if (T0 === null) return `Room ${code} · Waiting for Start`;
  const showMs = client.clock.serverNow() - T0;
  return `Room ${code} · ${showStatus(showMs, showDurationMs(session.show))}`;
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
