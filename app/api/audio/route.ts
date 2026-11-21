import { readAudioInfo } from "@/server/audio-info";
import { audioExtFor, MAX_AUDIO_BYTES, saveAudio } from "@/server/audio-store";
import { listRecentAudio } from "@/server/db";
import {
  errorResponse,
  readBodyWithLimit,
  guardApiRequest,
} from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The music used by saved shows, newest first: `{ tracks: Show["audio"][] }`.
 * A track saved without a title or artist gets them from the file's tags.
 */
export async function GET(request: Request): Promise<Response> {
  const refused = guardApiRequest(request, { write: false });
  if (refused) return refused;
  const tracks = await Promise.all(
    listRecentAudio().map(async (track) => {
      if (track.title && track.artist) return track;
      const tags = await readAudioInfo(track.fileId);
      const title = track.title ?? tags.title;
      const artist = track.artist ?? tags.artist;
      return {
        ...track,
        ...(title ? { title } : {}),
        ...(artist ? { artist } : {}),
      };
    }),
  );
  return Response.json({ tracks });
}

/**
 * Upload an audio file as multipart form data with the file in the `file`
 * field. Accepts mp3, wav and m4a up to MAX_AUDIO_BYTES. Replies 201 with
 * `{ fileId, url }`, where `url` is `/api/audio/<fileId>`. Store `fileId` in
 * `show.audio.fileId`.
 */
export async function POST(request: Request): Promise<Response> {
  const refused = guardApiRequest(request, { write: true });
  if (refused) return refused;

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_AUDIO_BYTES) return tooLarge();

  // Count bytes as they arrive: Content-Length may be absent (chunked) or
  // wrong, and request.formData() would buffer an unbounded body.
  const raw = await readBodyWithLimit(request.body, MAX_AUDIO_BYTES);
  if (raw === null) return tooLarge();

  let form: FormData;
  try {
    form = await new Response(raw, {
      headers: { "content-type": request.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    return errorResponse(
      400,
      "expected multipart/form-data with a `file` field",
    );
  }
  const file = form.get("file");
  if (!(file instanceof File))
    return errorResponse(400, "missing `file` field");
  if (file.size === 0) return errorResponse(400, "file is empty");
  const ext = audioExtFor(file.name, file.type);
  if (!ext) {
    return errorResponse(415, "unsupported audio type; use mp3, wav or m4a");
  }
  const fileId = await saveAudio(new Uint8Array(await file.arrayBuffer()), ext);
  return Response.json(
    { fileId, url: `/api/audio/${fileId}` },
    { status: 201 },
  );
}

function tooLarge(): Response {
  return errorResponse(413, `upload is larger than ${MAX_AUDIO_BYTES} bytes`);
}
