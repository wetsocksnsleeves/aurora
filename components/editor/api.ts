import type { Show } from "@/lib/types";

async function errorFrom(res: Response): Promise<Error> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // Not JSON: keep the status line.
  }
  return new Error(message);
}

/** Create a show (empty unless fields are given) and return it. */
export async function createShow(
  fields: Partial<Pick<Show, "name" | "venue" | "audio" | "clips">> = {},
): Promise<Show> {
  const res = await fetch("/api/shows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw await errorFrom(res);
  return ((await res.json()) as { show: Show }).show;
}

/** Write the editable fields of `show` and return the stored show. */
export async function saveShow(show: Show): Promise<Show> {
  const res = await fetch(`/api/shows/${encodeURIComponent(show.id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: show.name,
      venue: show.venue,
      audio: show.audio,
      clips: show.clips,
    }),
  });
  if (!res.ok) throw await errorFrom(res);
  return ((await res.json()) as { show: Show }).show;
}

/** Upload an mp3, wav or m4a file. Returns the id to store in `show.audio.fileId`. */
export async function uploadAudio(
  file: File,
): Promise<{ fileId: string; url: string }> {
  const form = new FormData();
  form.set("file", file);
  const res = await fetch("/api/audio", { method: "POST", body: form });
  if (!res.ok) throw await errorFrom(res);
  return (await res.json()) as { fileId: string; url: string };
}

export function audioUrl(fileId: string): string {
  return `/api/audio/${encodeURIComponent(fileId)}`;
}
