import fs from "node:fs";
import { readAudioTags, type AudioPicture } from "@/lib/audio-tags";
import { audioFilePath, isAudioFileId } from "./audio-store";

/** Most bytes read from one file to find its tags. */
export const MAX_TAG_BYTES = 16 * 1024 * 1024;
/** Covers larger than this are not served (real ones are well under 1 MB). */
export const MAX_COVER_BYTES = 5 * 1024 * 1024;
/** Total picture bytes kept in the cache. */
const CACHE_BYTES = 32 * 1024 * 1024;

/** Audio files never change, so a file's cover is looked up once. */
const cache = new Map<string, AudioPicture | null>();
let cachedBytes = 0;
/** Lookups in progress, so concurrent requests share one read. */
const pending = new Map<string, Promise<AudioPicture | null>>();

/**
 * The cover art embedded in an uploaded (or built-in) audio file, or null
 * when it has none, it is too large, or the file is missing.
 */
export function readCover(fileId: string): Promise<AudioPicture | null> {
  if (!isAudioFileId(fileId)) return Promise.resolve(null);
  const cached = cache.get(fileId);
  if (cached !== undefined) return Promise.resolve(cached);
  let lookup = pending.get(fileId);
  if (!lookup) {
    lookup = lookUp(fileId).finally(() => pending.delete(fileId));
    pending.set(fileId, lookup);
  }
  return lookup;
}

async function lookUp(fileId: string): Promise<AudioPicture | null> {
  let cover: AudioPicture | null;
  try {
    const bytes = await tagBytes(audioFilePath(fileId));
    cover = readAudioTags(bytes).picture ?? null;
  } catch {
    return null; // Missing file: don't cache, it may be uploaded later.
  }
  if (cover && cover.data.length > MAX_COVER_BYTES) cover = null;
  remember(fileId, cover);
  return cover;
}

function remember(fileId: string, cover: AudioPicture | null): void {
  const size = cover?.data.length ?? 0;
  // Evict the oldest entries until it fits, and cap the entry count too.
  while (
    cache.size > 0 &&
    (cachedBytes + size > CACHE_BYTES || cache.size >= 256)
  ) {
    const [oldest, picture] = cache.entries().next().value!;
    cache.delete(oldest);
    cachedBytes -= picture?.data.length ?? 0;
  }
  cache.set(fileId, cover);
  cachedBytes += size;
}

/**
 * Just the parts of the file that hold its tags, at most MAX_TAG_BYTES, in
 * a shape `readAudioTags` understands: the ID3v2 block of an mp3, the
 * `ftyp` + `moov` atoms of an m4a, or the RIFF header + LIST/id3 chunks of
 * a wav. The audio data itself is never read.
 */
async function tagBytes(file: string): Promise<Uint8Array> {
  const handle = await fs.promises.open(file, "r");
  try {
    const { size } = await handle.stat();
    const read = async (at: number, length: number) => {
      const bytes = new Uint8Array(Math.max(0, Math.min(length, size - at)));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, at);
      return bytes.subarray(0, bytesRead);
    };
    if (file.endsWith(".mp3")) return await mp3Tag(read);
    if (file.endsWith(".m4a")) return await mp4Tags(read, size);
    if (file.endsWith(".wav")) return await wavTags(read, size);
    return new Uint8Array(0);
  } finally {
    await handle.close();
  }
}

type Read = (at: number, length: number) => Promise<Uint8Array>;

/** The ID3v2 block at the start (ID3v1 at the end has no pictures). */
async function mp3Tag(read: Read): Promise<Uint8Array> {
  const header = await read(0, 10);
  const isId3 =
    header.length === 10 &&
    header[0] === 0x49 && // "ID3"
    header[1] === 0x44 &&
    header[2] === 0x33;
  if (!isId3) return new Uint8Array(0);
  const tagSize =
    ((header[6]! & 0x7f) << 21) |
    ((header[7]! & 0x7f) << 14) |
    ((header[8]! & 0x7f) << 7) |
    (header[9]! & 0x7f);
  if (10 + tagSize > MAX_TAG_BYTES) return new Uint8Array(0);
  return read(0, 10 + tagSize);
}

/** `ftyp` and `moov`, found by walking the top-level atom headers. */
async function mp4Tags(read: Read, size: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  for (let at = 0; at + 8 <= size;) {
    const header = await read(at, 16);
    if (header.length < 8) break;
    let atomSize = u32be(header, 0);
    if (atomSize === 1) {
      if (header.length < 16 || u32be(header, 8) !== 0) break; // > 4 GB.
      atomSize = u32be(header, 12);
    } else if (atomSize === 0) {
      atomSize = size - at;
    }
    if (atomSize < 8) break;
    const type = String.fromCharCode(...header.subarray(4, 8));
    if (type === "ftyp" || type === "moov") {
      total += atomSize;
      if (total > MAX_TAG_BYTES) return new Uint8Array(0);
      parts.push(await read(at, atomSize));
      if (type === "moov") break;
    }
    at += atomSize;
  }
  return concat(parts);
}

/** The RIFF header plus any LIST and id3 chunks, re-wrapped as a RIFF file. */
async function wavTags(read: Read, size: number): Promise<Uint8Array> {
  const parts: Uint8Array[] = [await read(0, 12)];
  let total = 12;
  for (let at = 12; at + 8 <= size;) {
    const header = await read(at, 8);
    if (header.length < 8) break;
    const type = String.fromCharCode(...header.subarray(0, 4));
    const chunkSize = u32le(header, 4);
    if (type === "LIST" || type === "id3 " || type === "ID3 ") {
      total += 8 + chunkSize + (chunkSize & 1);
      if (total > MAX_TAG_BYTES) return new Uint8Array(0);
      parts.push(await read(at, 8 + chunkSize + (chunkSize & 1)));
    }
    at += 8 + chunkSize + (chunkSize & 1);
  }
  return concat(parts);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function u32be(data: Uint8Array, at: number): number {
  return (
    data[at]! * 0x1000000 +
    ((data[at + 1]! << 16) | (data[at + 2]! << 8) | data[at + 3]!)
  );
}

function u32le(data: Uint8Array, at: number): number {
  return (
    data[at + 3]! * 0x1000000 +
    ((data[at + 2]! << 16) | (data[at + 1]! << 8) | data[at]!)
  );
}
