/** Helpers shared by the API route handlers and `proxy.ts`. */

export type BodyResult<T> =
  { ok: true; value: T } | { ok: false; response: Response };

/** Largest JSON request body accepted. A big show is a few hundred KB. */
export const MAX_JSON_BYTES = 2 * 1024 * 1024;

export function errorResponse(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/** Hostnames served on any port, for local use. */
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

/**
 * The lowercased hostname, without port, of a `Host` header value or a URL.
 * IPv6 literals keep their brackets (`[::1]`). Null when it does not parse.
 */
export function hostnameOf(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  try {
    const url = trimmed.includes("://")
      ? new URL(trimmed)
      : new URL(`http://${trimmed}`);
    return url.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Hostnames the API answers to: loopback, the host of `PUBLIC_URL`, and the
 * comma-separated `ALLOWED_HOSTS` (for example a LAN address). Ports are
 * ignored. Read on every call so tests and restarts see env changes.
 */
export function allowedHostnames(
  env: Record<string, string | undefined> = process.env,
): Set<string> {
  const hosts = new Set(LOOPBACK_HOSTNAMES);
  const candidates = [env.PUBLIC_URL, ...(env.ALLOWED_HOSTS ?? "").split(",")];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const host = hostnameOf(candidate);
    if (host) hosts.add(host);
  }
  return hosts;
}

function isAllowedHost(value: string | null): boolean {
  if (value === null) return false;
  const host = hostnameOf(value);
  return host !== null && allowedHostnames().has(host);
}

/**
 * Refuse requests whose `Host` is not on the allowlist. Without this, DNS
 * rebinding lets a page on an attacker's domain reach the API through the
 * victim's browser, with that domain as both Host and Origin.
 * Returns a 403 response to send, or null when the request may proceed.
 */
export function rejectDisallowedHost(request: Request): Response | null {
  const host = request.headers.get("host") ?? new URL(request.url).host;
  return isAllowedHost(host) ? null : errorResponse(403, "unknown host");
}

/**
 * There is no host login (SPEC section 8), so write routes only accept
 * requests from the app's own pages. This blocks a page on another site from
 * using the visitor's browser to change or delete shows.
 *
 * Returns a 403 response to send, or null when the request may proceed.
 * - `Sec-Fetch-Site` (sent by current browsers) must be `same-origin` or
 *   `none` (typed URL, curl-like tools that copy it).
 * - Without it, an `Origin` header, if present, must name an allowed host.
 * - Requests with neither (curl, tests, server-to-server) are allowed.
 */
export function rejectCrossSite(request: Request): Response | null {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null) {
    return site === "same-origin" || site === "none"
      ? null
      : errorResponse(403, "cross-site request refused");
  }
  const origin = request.headers.get("origin");
  if (origin === null) return null;
  // "null" and malformed origins fail to parse and are refused.
  return isAllowedHost(origin)
    ? null
    : errorResponse(403, "cross-origin request refused");
}

/**
 * The checks every API route runs first: the Host allowlist, plus the
 * same-origin check for writes. Returns a response to send, or null.
 */
export function guardApiRequest(
  request: Request,
  { write }: { write: boolean },
): Response | null {
  return (
    rejectDisallowedHost(request) ?? (write ? rejectCrossSite(request) : null)
  );
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  return value.split(";")[0].trim().toLowerCase() === "application/json";
}

/**
 * Read a JSON request body of at most MAX_JSON_BYTES. Replies 415 unless
 * Content-Type is `application/json`, 413 when the body is too large, 400 for
 * invalid UTF-8 or JSON. An empty body yields `fallback` when one is given,
 * otherwise 400.
 */
export async function readJson(
  request: Request,
  fallback?: unknown,
): Promise<BodyResult<unknown>> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return {
      ok: false,
      response: errorResponse(415, "Content-Type must be application/json"),
    };
  }
  const declared = Number(request.headers.get("content-length") ?? "0");
  const bytes =
    declared > MAX_JSON_BYTES
      ? null
      : await readBodyWithLimit(request.body, MAX_JSON_BYTES);
  if (bytes === null) {
    return {
      ok: false,
      response: errorResponse(
        413,
        `request body is larger than ${MAX_JSON_BYTES} bytes`,
      ),
    };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      ok: false,
      response: errorResponse(400, "request body is not valid UTF-8"),
    };
  }
  if (text.trim() === "") {
    return fallback === undefined
      ? { ok: false, response: errorResponse(400, "request body is empty") }
      : { ok: true, value: fallback };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return {
      ok: false,
      response: errorResponse(400, "request body is not valid JSON"),
    };
  }
}

/**
 * Read the raw body, stopping as soon as it passes `maxBytes`. The cap holds
 * for chunked uploads and ones without Content-Length, because bytes are
 * counted as they stream in instead of after the whole body is buffered.
 * Returns null when the body is larger than `maxBytes`.
 */
export async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("body too large");
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
