/** The pitch deck, served from `public/`. */
export const PITCH_DECK_PATH = "/pitch.html";

/**
 * What the deck, embedded in the big screen, asks of it with
 * `postMessage({ type: "lightshow-deck", action })`:
 * - `demo`: the deck reached its live demo slide, so hide it and show the
 *   QR code.
 * - `fullscreen`: F was pressed inside the deck. Fullscreen belongs to the
 *   big screen page, so the deck asks it to toggle.
 */
export type DeckAction = "demo" | "fullscreen";

export function parseDeckMessage(data: unknown): DeckAction | null {
  if (typeof data !== "object" || data === null) return null;
  const { type, action } = data as { type?: unknown; action?: unknown };
  if (type !== "lightshow-deck") return null;
  return action === "demo" || action === "fullscreen" ? action : null;
}
