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
  matcher: "/api/:path*",
};
