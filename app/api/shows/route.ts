import { createShow, listShows } from "@/server/db";
import { errorResponse, guardApiRequest, readJson } from "@/server/http";
import { parseShowPatch } from "@/server/show-validation";

// better-sqlite3 is a native module, so this must run on Node.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List shows, most recently updated first: `{ shows: ShowSummary[] }`. */
export function GET(request: Request): Response {
  const refused = guardApiRequest(request, { write: false });
  if (refused) return refused;
  return Response.json({ shows: listShows() });
}

/**
 * Create a show. The JSON body may set `name`, `venue`, `audio` and `clips`;
 * an empty body creates an untitled, empty show. Replies 201 with `{ show }`.
 */
export async function POST(request: Request): Promise<Response> {
  const refused = guardApiRequest(request, { write: true });
  if (refused) return refused;
  const body = await readJson(request, {});
  if (!body.ok) return body.response;
  const patch = parseShowPatch(body.value);
  if (!patch.ok) return errorResponse(400, patch.error);
  const show = createShow(patch.value);
  return Response.json({ show }, { status: 201 });
}
