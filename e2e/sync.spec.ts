import { devices, expect, test, type Page } from "@playwright/test";
import { WebSocket } from "ws";
import {
  spawnServer,
  type SpawnedServer,
} from "../server/testing/spawn-server";

/**
 * Browser sync test (SPEC 6.3, DEVELOPMENT.md chunk 7), after the reference
 * repo's `test/sync_harness.mjs`: several phone-sized browser contexts run
 * the real participant page, join one session, pick the same seat, tap
 * Ready and play the test wave. Each page records the wall-clock time of
 * every colour change of the playback fill; the test asserts that the
 * phones change colour together, p95 spread under 50 ms.
 *
 * The contexts share this machine's clock, so this covers the page, the
 * rAF loop and the real handshake over loopback, not clock skew or bad
 * networks; `scripts/sim.ts` covers those.
 */

const PHONES = 4;
/** Colour changes per phone to compare: 2 per 2 s wave, 5 waves. */
const CHANGES = 10;
const MAX_P95_SPREAD_MS = 50;
/** Where every phone taps, relative to the map: inside the left block. */
const SEAT_TAP = { x: 0.25, y: 0.55 };

type Change = { t: number; color: string };

declare global {
  interface Window {
    __colorChanges?: Change[];
  }
}

let server: SpawnedServer;

test.beforeAll(async () => {
  server = await spawnServer();
});

test.afterAll(async () => {
  await server?.stop();
});

test("phones change colour within 50 ms of each other", async ({ browser }) => {
  const host = await Host.create(server.wsUrl);
  try {
    const phones: Page[] = [];
    for (let i = 0; i < PHONES; i++) {
      // One device profile for all, so every phone taps the exact same seat
      // and gets the same schedule.
      const context = await browser.newContext({ ...devices["Pixel 7"] });
      const page = await context.newPage();
      await page.addInitScript(recordColorChanges);
      phones.push(page);
    }

    // Join, pick a seat, tap Ready.
    await Promise.all(
      phones.map(async (page) => {
        await page.goto(`${server.httpUrl}/j/${host.code}`);
        const map = page.getByRole("button", { name: /seating map/i });
        const box = await map.boundingBox();
        if (!box) throw new Error("seat map has no box");
        await page.mouse.click(
          box.x + box.width * SEAT_TAP.x,
          box.y + box.height * SEAT_TAP.y,
        );
        await page.getByRole("button", { name: "Ready" }).click();
        await expect(page.locator('[data-screen="standby"]')).toBeVisible({
          timeout: 30_000,
        });
      }),
    );
    await host.waitForStandby(PHONES);

    await host.start();
    // Wait until every phone has recorded enough changes.
    for (const page of phones) {
      await page.waitForFunction(
        (n) =>
          (window.__colorChanges ?? []).filter((c) => c.color === "white")
            .length >=
          n / 2 + 1,
        CHANGES,
        { timeout: 30_000 },
      );
    }

    const timelines = await Promise.all(
      phones.map((page) => page.evaluate(() => window.__colorChanges ?? [])),
    );
    const changes = timelines.map((timeline) => showChanges(timeline));
    for (const c of changes) expect(c.length).toBeGreaterThanOrEqual(CHANGES);

    // Every phone has the same schedule, so the i-th change is the same event.
    const spreads: number[] = [];
    for (let i = 0; i < CHANGES; i++) {
      const colors = new Set(changes.map((c) => c[i]!.color));
      expect(colors.size, `change ${i} has one colour on every phone`).toBe(1);
      const times = changes.map((c) => c[i]!.t);
      spreads.push(Math.max(...times) - Math.min(...times));
    }
    const p95 = percentile(spreads, 95);
    console.log(
      `colour change spread over ${PHONES} phones, ${CHANGES} changes: ` +
        `p50 ${percentile(spreads, 50).toFixed(1)} ms, ` +
        `p95 ${p95.toFixed(1)} ms, max ${Math.max(...spreads).toFixed(1)} ms`,
    );
    expect(p95).toBeLessThan(MAX_P95_SPREAD_MS);
  } finally {
    host.close();
  }
});

/**
 * Runs in every page before its scripts: records each colour the playback
 * fill is painted, with a wall-clock timestamp. `Playback` writes the colour
 * straight to the element's style inside requestAnimationFrame, and the
 * observer runs at the end of that same task, so the time is the frame's.
 */
function recordColorChanges() {
  const changes: Change[] = [];
  window.__colorChanges = changes;
  const name = (css: string) =>
    css === "rgb(255, 255, 255)"
      ? "white"
      : css === "rgb(0, 0, 0)"
        ? "black"
        : css;
  const observer = new MutationObserver((records) => {
    const t = performance.timeOrigin + performance.now();
    for (const r of records) {
      const el = r.target as HTMLElement;
      if (el.dataset.screen !== "playing") continue;
      const color = name(el.style.backgroundColor);
      if (color && changes.at(-1)?.color !== color) changes.push({ t, color });
    }
  });
  const start = () =>
    observer.observe(document.documentElement, {
      subtree: true,
      attributes: true,
      attributeFilter: ["style"],
    });
  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start);
}

/** The changes from the first flash on: before it the fill is just dark. */
function showChanges(timeline: Change[]): Change[] {
  const first = timeline.findIndex((c) => c.color === "white");
  return first < 0 ? [] : timeline.slice(first);
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1]!;
}

/** The host side over a plain socket: creates the session, presses Start. */
class Host {
  private standby = 0;
  private waiters: (() => void)[] = [];

  private constructor(
    private readonly ws: WebSocket,
    readonly code: string,
  ) {
    ws.on("message", (data) => {
      const m = JSON.parse(String(data)) as {
        type: string;
        list?: { state: string }[];
      };
      if (m.type === "participants" && m.list) {
        this.standby = m.list.filter((p) => p.state === "standby").length;
      }
      for (const w of this.waiters) w();
    });
  }

  static async create(wsUrl: string): Promise<Host> {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const code = await new Promise<string>((resolve, reject) => {
      ws.once("message", (data) => {
        const m = JSON.parse(String(data)) as { type: string; code?: string };
        if (m.type === "session" && m.code) resolve(m.code);
        else reject(new Error(`expected session, got ${String(data)}`));
      });
      ws.send(JSON.stringify({ type: "host", showId: "test" }));
    });
    return new Host(ws, code);
  }

  waitForStandby(count: number): Promise<void> {
    return this.until(() => this.standby >= count);
  }

  async start(): Promise<void> {
    this.ws.send(JSON.stringify({ type: "start" }));
  }

  close(): void {
    this.ws.terminate();
  }

  private until(done: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      if (done()) return resolve();
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for the host")),
        30_000,
      );
      this.waiters.push(() => {
        if (!done()) return;
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
