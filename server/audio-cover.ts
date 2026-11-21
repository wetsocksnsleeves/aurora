import fs from "node:fs";
import { readAudioTags, type AudioPicture } from "@/lib/audio-tags";
import { audioFilePath, isAudioFileId } from "./audio-store";

/** Audio files never change, so a file's cover is looked up once. */
const cache = new Map<string, AudioPicture | null>();
const CACHE_LIMIT = 64;

/**
 * The cover art embedded in an uploaded (or built-in) audio file, or null
 * when it has none or the file is missing.
 */
export async function readCover(fileId: string): Promise<AudioPicture | null> {
  if (!isAudioFileId(fileId)) return null;
  const cached = cache.get(fileId);
  if (cached !== undefined) return cached;
  let cover: AudioPicture | null;
  try {
    const bytes = await tagBytes(audioFilePath(fileId));
    cover = readAudioTags(bytes).picture ?? null;
  } catch {
    return null; // Missing file: don't cache, it may be uploaded later.
  }
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(fileId, cover);
  return cover;
}

/**
 * The bytes that hold the tags. For mp3 that is just the ID3v2 block at the
 * start (ID3v1 has no pictures); m4a and wav tags can sit anywhere, so the
 * whole file is read.
 */
async function tagBytes(file: string): Promise<Uint8Array> {
  if (!file.endsWith(".mp3")) {
    return new Uint8Array(await fs.promises.readFile(file));
  }
  const handle = await fs.promises.open(file, "r");
  try {
    const header = new Uint8Array(10);
    const { bytesRead } = await handle.read(header, 0, 10, 0);
    const isId3 =
      header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33; // "ID3"
    if (bytesRead < 10 || !isId3) return new Uint8Array(0);
    const size =
      ((header[6]! & 0x7f) << 21) |
      ((header[7]! & 0x7f) << 14) |
      ((header[8]! & 0x7f) << 7) |
      (header[9]! & 0x7f);
    const bytes = new Uint8Array(10 + size);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    return bytes.subarray(0, read.bytesRead);
  } finally {
    await handle.close();
  }
}
