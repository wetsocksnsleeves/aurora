import type { ParticipantSummary } from "@/lib/protocol";

/**
 * The room's phones as DOM elements standing upright on the CSS 3D floor.
 * Each phone is an absolutely placed element in the floor's 0..1 box, folded
 * up from the floor about its bottom edge, parallel to the screen. Phones are
 * kept by participant id, so a fresh participant list moves, adds and removes
 * elements instead of rebuilding them.
 */

/** An unlit phone reads as this much white, like `.loader > i`. */
const UNLIT_LIFT = 0.08;
/** Phones glow only up to this many (see `.crowd[data-glow]`). */
const GLOW_MAX = 120;

export type Crowd = {
  /** Match the phones to the list; participants without a seat are left out. */
  setPhones: (list: readonly ParticipantSummary[]) => void;
  /** Colour every phone: a `#rrggbb` colour per participant. */
  paint: (colorOf: (p: ParticipantSummary) => string) => void;
  dispose: () => void;
};

/** Phone width as a fraction of the floor: smaller as the crowd grows. */
export function phoneWidth(count: number): number {
  return Math.min(0.026, Math.max(0.006, 0.32 / Math.sqrt(Math.max(1, count))));
}

/** `#rrggbb` lifted off black like an unlit LED, as a CSS colour. */
export function ledColor(hex: string): string {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  if (hex.length < 7 || Number.isNaN(n)) return hex;
  const lift = (v: number) =>
    Math.round(255 * (UNLIT_LIFT + (1 - UNLIT_LIFT) * (v / 255)));
  return `rgb(${lift((n >> 16) & 255)} ${lift((n >> 8) & 255)} ${lift(n & 255)})`;
}

type Phone = { el: HTMLElement; p: ParticipantSummary; color: string };

export function createCrowd(layer: HTMLElement, phoneClass: string): Crowd {
  const phones = new Map<string, Phone>();
  const led = new Map<string, string>();

  const setPhones: Crowd["setPhones"] = (list) => {
    const seen = new Set<string>();
    for (const p of list) {
      if (p.x === null || p.y === null || p.state === "disconnected") continue;
      seen.add(p.id);
      let phone = phones.get(p.id);
      if (!phone) {
        const el = document.createElement("i");
        el.className = phoneClass;
        layer.appendChild(el);
        phone = { el, p, color: "" };
        phones.set(p.id, phone);
        el.style.left = `${clamp01(p.x) * 100}%`;
        el.style.top = `${clamp01(p.y) * 100}%`;
      } else {
        if (phone.p.x !== p.x) phone.el.style.left = `${clamp01(p.x) * 100}%`;
        if (phone.p.y !== p.y) phone.el.style.top = `${clamp01(p.y) * 100}%`;
      }
      phone.p = p;
    }
    for (const [id, phone] of phones) {
      if (seen.has(id)) continue;
      phone.el.remove();
      phones.delete(id);
    }
    layer.style.setProperty("--phone", String(phoneWidth(phones.size)));
    layer.toggleAttribute("data-glow", phones.size <= GLOW_MAX);
  };

  const paint: Crowd["paint"] = (colorOf) => {
    for (const phone of phones.values()) {
      const hex = colorOf(phone.p);
      if (hex === phone.color) continue;
      phone.color = hex;
      let css = led.get(hex);
      if (css === undefined) {
        css = ledColor(hex);
        led.set(hex, css);
      }
      phone.el.style.setProperty("--led", css);
    }
  };

  return {
    setPhones,
    paint,
    dispose: () => {
      layer.replaceChildren();
      phones.clear();
    },
  };
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}
