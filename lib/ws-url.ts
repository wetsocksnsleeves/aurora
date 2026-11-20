/** Path the app's WebSocket listens on (SPEC 5.1). Mirrors `server/ws.ts`. */
export const WS_PATH = "/ws";

/**
 * The app WebSocket URL for a page served from `location`: `wss:` behind
 * HTTPS (tunnels, TLS hosts), `ws:` otherwise. Pass `window.location`.
 */
export function wsUrlFor(location: { protocol: string; host: string }): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${WS_PATH}`;
}
