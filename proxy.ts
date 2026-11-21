import { rejectDisallowedHost } from "@/server/http";

/**
 * Host allowlist for every API route, including ones added later (DNS
 * rebinding defence; see `rejectDisallowedHost`). Route handlers also call
 * `guardApiRequest` themselves, so the check holds if this matcher changes.
 */
export function proxy(request: Request): Response | undefined {
  return rejectDisallowedHost(request) ?? undefined;
}

export const config = {
  // Every /api path except the audio upload, `/api/audio` itself. Next
  // buffers the body of each request proxy matches and silently cuts it at
  // 10 MB (`proxyClientMaxBodySize`), which truncates large uploads. The
  // upload route enforces its own size cap and runs `guardApiRequest`.
  // `/api/audio/<fileId>` is still matched.
  matcher: "/api/((?!audio$).*)",
};
