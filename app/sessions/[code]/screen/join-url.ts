import { hostnameOf } from "@/server/http";

/**
 * The join link the big screen may put in its QR code. `?join=` comes from
 * the host page, but anyone can send a host a crafted link, and the screen
 * shows its QR code to a whole room. So only accept a link to this session's
 * own join page (`/j/<code>`) on a host this app answers to; anything else
 * returns null and the screen links to its own origin instead.
 */
export function safeJoinUrl(
  join: unknown,
  code: string,
  allowedHosts: ReadonlySet<string>,
): string | null {
  if (typeof join !== "string") return null;
  let url: URL;
  try {
    url = new URL(join);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname.toUpperCase() !== `/J/${code.toUpperCase()}`) return null;
  const host = hostnameOf(url.href);
  if (!host || !allowedHosts.has(host)) return null;
  return url.href;
}
