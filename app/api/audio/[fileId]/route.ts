import fs from "node:fs";
import { Readable } from "node:stream";
import {
  audioFilePath,
  contentTypeFor,
  isAudioFileId,
  parseRange,
} from "@/server/audio-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ fileId: string }> };

/**
 * Serve an uploaded audio file. Supports single `Range` requests (206), which
 * `<audio>` elements need to seek. File ids are unique and files never change,
 * so responses are cacheable forever.
 */
export async function GET(
  request: Request,
  { params }: Context,
): Promise<Response> {
  const { fileId } = await params;
  if (!isAudioFileId(fileId)) return notFound();

  const file = audioFilePath(fileId);
  let size: number;
  try {
    size = (await fs.promises.stat(file)).size;
  } catch {
    return notFound();
  }

  const headers = new Headers({
    "Content-Type": contentTypeFor(fileId),
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable",
  });

  const range = parseRange(request.headers.get("range"), size);
  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  const length = size === 0 ? 0 : end - start + 1;
  // Next drops Content-Length when it pipes the body to Node, so clients see
  // a chunked reply. Content-Range still carries the total size, which is
  // what media elements use to seek.
  headers.set("Content-Length", String(length));
  if (range) headers.set("Content-Range", `bytes ${start}-${end}/${size}`);

  const body =
    length === 0
      ? null
      : // Node's web ReadableStream type differs nominally from the DOM one
        // that Response expects; they are the same object at runtime.
        (Readable.toWeb(
          fs.createReadStream(file, { start, end }),
        ) as unknown as ReadableStream<Uint8Array>);
  return new Response(body, { status: range ? 206 : 200, headers });
}

function notFound(): Response {
  return Response.json({ error: "audio not found" }, { status: 404 });
}
