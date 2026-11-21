import { readCover } from "@/server/audio-info";
import { guardApiRequest } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ fileId: string }> };

/**
 * Serve the cover art embedded in an audio file (ID3 APIC, m4a covr), or 404
 * when it has none. The image type is sniffed from its bytes, so only JPEG,
 * PNG, GIF and WebP are ever served.
 */
export async function GET(
  request: Request,
  { params }: Context,
): Promise<Response> {
  const refused = guardApiRequest(request, { write: false });
  if (refused) return refused;
  const { fileId } = await params;
  const cover = await readCover(fileId);
  if (!cover) {
    return Response.json({ error: "no cover art" }, { status: 404 });
  }
  return new Response(new Blob([cover.data.slice()]), {
    headers: {
      "Content-Type": cover.mimeType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
