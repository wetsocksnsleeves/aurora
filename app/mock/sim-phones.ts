import type { KeyValueStorage } from "@/lib/client-socket";
import { randomSeat } from "@/lib/venue-geometry";
import {
  DEFAULT_CONNECT_DELAY_MAX_MS,
  DEFAULT_RECONNECT_BASE_MS,
  DEFAULT_RECONNECT_MAX_MS,
  ParticipantClient,
} from "@/app/j/[code]/participant-client";
import { browserClockEnv } from "../browser-clock";

/**
 * Simulated phones run from the mock tab: each is the participant page's own
 * `ParticipantClient` on a real WebSocket, so the server sees an ordinary
 * participant. After `welcome` it takes a random seat inside the venue and
 * taps Ready, like `scripts/sim` does, then syncs its clock and plays when
 * the host presses Start. Lowering the count closes the newest phones; the
 * server drops them from the room once they time out (SPEC 5.3).
 */

/**
 * No cap here, but browsers limit open WebSockets (Chrome to a few hundred)
 * and a quick tunnel to about 200 in-flight requests, so past that some
 * phones never join. `counts().joined` shows how many got in.
 */
export type SimPhoneCounts = { open: number; joined: number; ready: number };

export type SimPhones = {
  /** Open or close phones until `count` are running. */
  setCount: (count: number) => void;
  counts: () => SimPhoneCounts;
  /** Close every phone. */
  dispose: () => void;
};

export function createSimPhones(code: string, wsUrl: string): SimPhones {
  const phones: { client: ParticipantClient; unsubscribe: () => void }[] = [];

  const add = () => {
    const client = new ParticipantClient(code, {
      wsUrl,
      createSocket: (url) => new WebSocket(url),
      storage: memoryStorage(),
      random: Math.random,
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (h) => window.clearTimeout(h as number),
      connectDelayMaxMs: DEFAULT_CONNECT_DELAY_MAX_MS,
      reconnectBaseMs: DEFAULT_RECONNECT_BASE_MS,
      reconnectMaxMs: DEFAULT_RECONNECT_MAX_MS,
      clock: browserClockEnv(),
    });
    let seated = false;
    const unsubscribe = client.subscribe(() => {
      const s = client.getSnapshot();
      if (seated || !s.welcomed || !s.venue) return;
      seated = true;
      client.setSeat(randomSeat(s.venue, Math.random));
      client.ready();
    });
    client.start();
    phones.push({ client, unsubscribe });
  };

  const removeLast = () => {
    const phone = phones.pop();
    if (!phone) return;
    phone.unsubscribe();
    phone.client.stop();
  };

  return {
    setCount: (count) => {
      const target = Math.max(0, Math.floor(count));
      while (phones.length < target) add();
      while (phones.length > target) removeLast();
    },
    counts: () => {
      let joined = 0;
      let ready = 0;
      for (const { client } of phones) {
        const s = client.getSnapshot();
        if (s.welcomed && s.connection === "open") joined++;
        if (s.readyTapped && s.schedule !== null && s.clockReady) ready++;
      }
      return { open: phones.length, joined, ready };
    },
    dispose: () => {
      while (phones.length) removeLast();
    },
  };
}

/** Per phone, so each joins as its own participant (no shared resume token). */
function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}
