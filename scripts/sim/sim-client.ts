import type { ClockSyncEnv } from "@/lib/clock-sync";
import type { KeyValueStorage } from "@/lib/client-socket";
import { ScheduleCursor, eventIndexAt, playbackFrame } from "@/lib/playback";
import { STATE_COLORS } from "@/lib/host-map";
import type { Point, ScheduleEvent, Venue } from "@/lib/types";
import {
  DEFAULT_CONNECT_DELAY_MAX_MS,
  DEFAULT_RECONNECT_BASE_MS,
  DEFAULT_RECONNECT_MAX_MS,
  ParticipantClient,
} from "@/app/j/[code]/participant-client";
import type { ClientFaults } from "./faults";
import { FaultySocket } from "./faulty-socket";

/** The harness's true clock: this process's `performance.now()`. */
export const trueNow = (): number => performance.now();

/**
 * One simulated phone: the participant page's own `ParticipantClient` (so
 * the join, seat, ready, clock report and reconnect flow are the browser's)
 * over a `FaultySocket`, with a local clock that is offset and drifts.
 *
 * `frame()` stands in for one requestAnimationFrame: it runs the page's
 * `playbackFrame` and records, for each schedule event the frame crossed,
 * how far the true render time was from the event's true time.
 */
export class SimClient {
  readonly client: ParticipantClient;
  private socket: FaultySocket | null = null;

  /** True time the first `join` went out. */
  joinAt: number | null = null;
  /** True time the page first showed standby. */
  standbyAt: number | null = null;
  /** Socket opens; more than one means the client reconnected. */
  opens = 0;
  /** Participant ids from every `welcome`; a resume keeps the same id. */
  readonly participantIds = new Set<string>();
  /** The seat picked after the first `welcome`. */
  seat: Point | null = null;
  /** A drop is planned at this fraction of the show, else null. */
  readonly dropAt: number | null;
  dropped = false;

  /** Signed render error per recorded event, ms. */
  readonly errors: number[] = [];
  /** `serverNow()` minus the true server clock at each recorded event, ms. */
  readonly clockErrors: number[] = [];
  /** Events skipped over (more than one crossed in a frame). */
  skipped = 0;
  /** The page reached "show over". */
  over = false;

  /** Colour of the last playback frame once a show has started, else null. */
  private playColor: string | null = null;

  private cursor: ScheduleCursor | null = null;
  private cursorEvents: readonly ScheduleEvent[] | null = null;
  /** Index of the last event recorded. */
  private recorded = -1;

  constructor(
    code: string,
    wsUrl: string,
    private readonly chooseSeat: (venue: Venue) => Point,
    readonly faults: ClientFaults,
    random: () => number,
    dropAt: number | null,
  ) {
    this.dropAt = dropAt;
    const { offsetMs, driftPpm } = faults;
    const scale = 1 + driftPpm / 1e6;
    // Timers stay real: drift on timer intervals does not affect sync.
    const clock: ClockSyncEnv = {
      now: () => trueNow() * scale + offsetMs,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    };
    this.client = new ParticipantClient(code, {
      wsUrl,
      createSocket: (url) => {
        this.socket = new FaultySocket(url, (dir) => faults.delay(dir));
        return this.socket;
      },
      storage: memoryStorage(),
      random,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      connectDelayMaxMs: DEFAULT_CONNECT_DELAY_MAX_MS,
      reconnectBaseMs: DEFAULT_RECONNECT_BASE_MS,
      reconnectMaxMs: DEFAULT_RECONNECT_MAX_MS,
      clock,
    });
    this.client.addListener({
      onOpen: () => {
        this.opens += 1;
        this.joinAt ??= trueNow();
      },
      onMessage: (message) => {
        if (message.type === "welcome") {
          this.participantIds.add(message.participantId);
        }
      },
    });
    this.client.subscribe(() => this.onChange());
  }

  start(): void {
    this.client.start();
  }

  stop(): void {
    this.client.stop();
  }

  /** Drops the socket if its planned moment in the show has come. */
  maybeDrop(now: number, serverOffset: number): void {
    if (this.dropAt === null || this.dropped) return;
    const s = this.client.getSnapshot();
    if (s.T0 === null || !s.schedule) return;
    const showMs = now + serverOffset - s.T0;
    if (showMs >= this.dropAt * s.schedule.durationMs) this.drop();
  }

  /** Network drop: the page sees a 1006 close and reconnects with resume. */
  drop(): void {
    this.dropped = true;
    this.socket?.drop();
  }

  get venue(): Venue | null {
    return this.client.getSnapshot().venue ?? null;
  }

  get standby(): boolean {
    const s = this.client.getSnapshot();
    return s.readyTapped && s.schedule !== null && s.clockReady;
  }

  get T0(): number | null {
    return this.client.getSnapshot().T0;
  }

  get degraded(): boolean {
    return this.client.getSnapshot().clockDegraded;
  }

  /**
   * The colour this phone shows (`#rrggbb`). During playback, what
   * `playbackFrame` last produced (black when dark or over); before it, the
   * host-map colour of its state (SPEC 5.3).
   */
  get color(): string {
    if (this.playColor !== null) return this.playColor;
    const s = this.client.getSnapshot();
    if (s.connection === "closed" || s.connection === "reconnecting") {
      return STATE_COLORS.disconnected;
    }
    if (!s.seat) return STATE_COLORS.connected;
    if (!s.readyTapped) return STATE_COLORS.seated;
    return this.standby ? STATE_COLORS.standby : STATE_COLORS.syncing;
  }

  private onChange(): void {
    const s = this.client.getSnapshot();
    // Pick the seat and tap Ready once, as a person would after `welcome`.
    if (s.welcomed && s.venue && this.seat === null) {
      this.seat = this.chooseSeat(s.venue);
      this.client.setSeat(this.seat);
      this.client.ready();
    }
    if (this.standbyAt === null && this.standby) this.standbyAt = trueNow();
  }

  /**
   * One display frame at true time `now`. `serverOffset` is the server
   * clock minus the true clock (0 when the server runs in this process).
   */
  frame(now: number, serverOffset: number): void {
    if (this.over) return;
    const s = this.client.getSnapshot();
    if (!s.schedule || s.T0 === null) {
      // No show running (or the host pressed Stop): back to state colours.
      this.playColor = null;
      return;
    }
    if (s.schedule.events !== this.cursorEvents) {
      // A resumed client gets its schedule again: same seat, same events,
      // so the recorded index stays valid.
      this.cursorEvents = s.schedule.events;
      this.cursor = new ScheduleCursor(s.schedule.events);
    }
    const serverNow = this.client.clock.serverNow();
    const frame = playbackFrame(
      { clockReady: s.clockReady, T0: s.T0, schedule: s.schedule, serverNow },
      this.cursor,
    );
    this.playColor = frame.kind === "color" ? frame.color : "#000000";
    const events = s.schedule.events;
    // The show's true start: T0 is on the server clock.
    const trueT0 = s.T0 - serverOffset;
    let upTo = -1;
    if (frame.kind === "color") upTo = this.cursor!.position;
    if (frame.kind === "over") {
      this.over = true;
      // Every event before the end of the show; later ones never play.
      upTo = eventIndexAt(events, s.schedule.durationMs - 1e-6);
    }
    if (upTo > this.recorded) this.skipped += upTo - this.recorded - 1;
    for (let i = this.recorded + 1; i <= upTo; i++) {
      const event = events[i]!;
      this.errors.push(now - (trueT0 + event.tMs));
      this.clockErrors.push(serverNow - (now + serverOffset));
    }
    this.recorded = Math.max(this.recorded, upTo);
  }
}

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}
