/** Helpers shared by the API route handlers. */

export type BodyResult<T> =
  { ok: true; value: T } | { ok: false; response: Response };

export function errorResponse(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

/**
 * There is no host login (SPEC section 8), so write routes only accept
 * requests from the app's own pages. This blocks a page on another site from
 * using the visitor's browser to change or delete shows.
 *
 * Returns a 403 response to send, or null when the request may proceed.
 * - `Sec-Fetch-Site` (sent by current browsers) must be `same-origin` or
 *   `none` (typed URL, curl-like tools that copy it).
 * - Without it, an `Origin` header, if present, must match `Host`.
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
  const host = request.headers.get("host");
  let originHost: string | null = null;
  try {
    originHost = new URL(origin).host;
  } catch {
    // "null" or a malformed Origin: treat as foreign.
  }
  return originHost !== null && host !== null && originHost === host
    ? null
    : errorResponse(403, "cross-origin request refused");
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  return value.split(";")[0].trim().toLowerCase() === "application/json";
}

/**
 * Read a JSON request body. Replies 415 unless Content-Type is
 * `application/json`, 400 for invalid JSON. An empty body yields `fallback`
 * when one is given, otherwise 400.
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
  const text = await request.text();
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
