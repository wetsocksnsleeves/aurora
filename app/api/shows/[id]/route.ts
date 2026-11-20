import { deleteShow, getShow, updateShow } from "@/server/db";
import { errorResponse, guardApiRequest, readJson } from "@/server/http";
import { parseShowPatch } from "@/server/show-validation";

// better-sqlite3 is a native module, so this must run on Node.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function notFound(): Response {
  return errorResponse(404, "show not found");
}

/** `{ show }`, or 404. */
export async function GET(
  request: Request,
  { params }: Context,
): Promise<Response> {
  const refused = guardApiRequest(request, { write: false });
  if (refused) return refused;
  const show = getShow((await params).id);
  return show ? Response.json({ show }) : notFound();
}

/**
 * Update a show. Any of `name`, `venue`, `audio`, `clips` may be sent; fields
 * left out keep their stored value. Replies `{ show }` with the saved show.
 */
export async function PUT(
  request: Request,
  { params }: Context,
): Promise<Response> {
  const refused = guardApiRequest(request, { write: true });
  if (refused) return refused;
  const body = await readJson(request);
  if (!body.ok) return body.response;
  const patch = parseShowPatch(body.value);
  if (!patch.ok) return errorResponse(400, patch.error);
  const show = updateShow((await params).id, patch.value);
  return show ? Response.json({ show }) : notFound();
}

export const PATCH = PUT;

/** 204, or 404. */
export async function DELETE(
  request: Request,
  { params }: Context,
): Promise<Response> {
  const refused = guardApiRequest(request, { write: true });
  if (refused) return refused;
  return deleteShow((await params).id)
    ? new Response(null, { status: 204 })
    : notFound();
}
