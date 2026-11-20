import { WebSocket } from "ws";
import type { SocketLike } from "@/lib/client-socket";
import type { Direction } from "./faults";

/**
 * A FIFO that holds each item for a delay before delivering it, without
 * reordering: an item is released no earlier than the one before it, like
 * bytes on one TCP connection. A spike on one message therefore also holds
 * back the messages behind it (head-of-line blocking).
 */
export class DelayQueue<T> {
  private items: { at: number; item: T }[] = [];
  private lastAt = -Infinity;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deliver: (item: T) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  push(item: T, delayMs: number): void {
    const at = Math.max(this.lastAt, this.now() + delayMs);
    this.lastAt = at;
    this.items.push({ at, item });
    if (this.items.length === 1) this.arm();
  }

  /** Drops everything still queued (the connection died). */
  clear(): void {
    this.items = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  get size(): number {
    return this.items.length;
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const head = this.items[0];
    if (!head) return;
    this.timer = setTimeout(
      () => this.flush(),
      Math.max(0, head.at - this.now()),
    );
  }

  private flush(): void {
    this.timer = null;
    // Node timers have 1 ms resolution and may fire a hair early.
    const now = this.now() + 0.5;
    while (this.items.length > 0 && this.items[0]!.at <= now) {
      const { item } = this.items.shift()!;
      // `deliver` may clear the queue (a close); the loop then ends.
      this.deliver(item);
    }
    this.arm();
  }
}

type Incoming =
  | { kind: "message"; data: string }
  | { kind: "close"; code: number; reason: string };

/**
 * A `SocketLike` over a real `ws` socket that delays both legs: `send` goes
 * through an uplink queue, received messages through a downlink queue, each
 * message with its own delay from `delay(direction)`. `drop()` kills the
 * connection like a network loss: queued messages are lost and `onclose`
 * fires at once with code 1006.
 */
export class FaultySocket implements SocketLike {
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;

  private readonly raw: WebSocket;
  private readonly up: DelayQueue<string>;
  private readonly down: DelayQueue<Incoming>;
  private dropped = false;
  private closeDelivered = false;

  constructor(
    url: string,
    private readonly delay: (direction: Direction) => number,
  ) {
    this.raw = new WebSocket(url);
    this.up = new DelayQueue((data) => {
      if (this.raw.readyState === WebSocket.OPEN) this.raw.send(data);
    });
    this.down = new DelayQueue((item) => {
      if (item.kind === "message") this.onmessage?.({ data: item.data });
      else this.deliverClose(item.code, item.reason);
    });
    this.raw.on("open", () => this.onopen?.({}));
    this.raw.on("message", (data) => {
      this.down.push(
        { kind: "message", data: String(data) },
        this.delay("down"),
      );
    });
    this.raw.on("close", (code, reason) => {
      if (this.dropped) return;
      this.up.clear();
      // A graceful close arrives after the messages sent before it.
      this.down.push(
        { kind: "close", code, reason: String(reason) },
        this.delay("down"),
      );
    });
    this.raw.on("error", (err) => this.onerror?.(err));
  }

  get readyState(): number {
    return this.dropped ? WebSocket.CLOSED : this.raw.readyState;
  }

  send(data: string): void {
    if (this.dropped) return;
    this.up.push(data, this.delay("up"));
  }

  close(code?: number, reason?: string): void {
    this.up.clear();
    this.down.clear();
    this.dropped = true;
    this.raw.close(code, reason);
  }

  /** Simulates a network drop: lose everything in flight, close now. */
  drop(): void {
    if (this.dropped) return;
    this.dropped = true;
    this.up.clear();
    this.down.clear();
    this.raw.terminate();
    this.deliverClose(1006, "dropped");
  }

  private deliverClose(code: number, reason: string): void {
    if (this.closeDelivered) return;
    this.closeDelivered = true;
    this.up.clear();
    this.down.clear();
    this.onclose?.({ code, reason });
  }
}
