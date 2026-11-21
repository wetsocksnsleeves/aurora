/**
 * Read the title, artist and cover art embedded in an audio file, so the
 * editor can show which track was added. Understands:
 *
 * - mp3: ID3v2.2/2.3/2.4 at the start (TIT2, TPE1, APIC), else ID3v1 at the
 *   end (title and artist only).
 * - m4a: the iTunes `moov/udta/meta/ilst` atoms (©nam, ©ART, covr).
 * - wav: a RIFF `LIST/INFO` chunk (INAM, IART) or an embedded `id3 ` chunk.
 *
 * The format is picked from the bytes, not the file name. Damaged or missing
 * tags give an empty result rather than an error.
 */

export type AudioPicture = {
  /** Sniffed from the image bytes: image/jpeg, image/png, image/gif or image/webp. */
  mimeType: string;
  data: Uint8Array;
};

export type AudioTags = {
  title?: string;
  artist?: string;
  picture?: AudioPicture;
};

/**
 * Longest title or artist kept; longer ones are cut with an ellipsis. Shows
 * accept up to this many characters (`server/show-validation.ts`).
 */
export const MAX_TAG_TEXT = 200;

export function readAudioTags(bytes: Uint8Array): AudioTags {
  try {
    if (ascii(bytes, 0, 3) === "ID3") return readId3v2(bytes, 0);
    if (ascii(bytes, 4, 4) === "ftyp") return readMp4(bytes);
    if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE") {
      return readWav(bytes);
    }
    return readId3v1(bytes);
  } catch {
    return {};
  }
}

/** The image type from its magic bytes, or null when it isn't a web image. */
export function sniffImageType(data: Uint8Array): string | null {
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    data[0] === 0x89 &&
    ascii(data, 1, 3) === "PNG" &&
    data[4] === 0x0d &&
    data[5] === 0x0a
  ) {
    return "image/png";
  }
  if (ascii(data, 0, 4) === "GIF8") return "image/gif";
  if (ascii(data, 0, 4) === "RIFF" && ascii(data, 8, 4) === "WEBP") {
    return "image/webp";
  }
  return null;
}

/** "My Song.final.mp3" -> "My Song.final": a title for untagged files. */
export function titleFromFileName(name: string): string {
  const base = name.replace(/^.*[\\/]/, "");
  const dot = base.lastIndexOf(".");
  return cleanText(dot > 0 ? base.slice(0, dot) : base) ?? base;
}

// ---- ID3v2 ---------------------------------------------------------------

/** Picture type 3 in APIC/PIC frames. */
const FRONT_COVER = 3;

function readId3v2(bytes: Uint8Array, start: number): AudioTags {
  const major = bytes[start + 3]!;
  if (major < 2 || major > 4) return {};
  const flags = bytes[start + 5]!;
  const size = synchsafe(bytes, start + 6);
  let body = bytes.subarray(start + 10, start + 10 + size);
  // v2.2 and v2.3 unsynchronise the whole tag; v2.4 does it per frame.
  if (flags & 0x80 && major < 4) body = unsynchronise(body);

  let pos = 0;
  if (flags & 0x40 && major >= 3) {
    // Extended header: v2.3 size excludes its own 4 bytes, v2.4 includes them.
    pos = major === 3 ? u32(body, 0) + 4 : synchsafe(body, 0);
  }

  const idLength = major === 2 ? 3 : 4;
  const headerLength = major === 2 ? 6 : 10;
  const tags: AudioTags = {};
  let picture: { type: number; picture: AudioPicture } | undefined;

  while (pos + headerLength <= body.length) {
    const id = ascii(body, pos, idLength);
    if (!/^[A-Z0-9]+$/.test(id)) break; // Padding or garbage.
    const frameSize =
      major === 2
        ? (body[pos + 3]! << 16) | (body[pos + 4]! << 8) | body[pos + 5]!
        : major === 4
          ? synchsafe(body, pos + 4)
          : u32(body, pos + 4);
    const frameFlags = major === 2 ? 0 : (body[pos + 8]! << 8) | body[pos + 9]!;
    const frameStart = pos + headerLength;
    pos = frameStart + frameSize;
    if (pos > body.length) break;
    let data = body.subarray(frameStart, pos);

    if (major === 4) {
      // Compressed or encrypted frames aren't worth decoding here.
      if (frameFlags & 0x000c) continue;
      if (frameFlags & 0x0002) data = unsynchronise(data);
      if (frameFlags & 0x0001) data = data.subarray(4); // Data length indicator.
    } else if (major === 3 && frameFlags & 0x00c0) {
      continue;
    }

    switch (id) {
      case "TIT2":
      case "TT2":
        tags.title ??= id3Text(data);
        break;
      case "TPE1":
      case "TP1":
        tags.artist ??= id3Text(data);
        break;
      case "APIC":
      case "PIC": {
        const found = id3Picture(data, id === "PIC");
        // Keep the front cover if there is one, else the first picture.
        if (
          found &&
          (!picture ||
            (picture.type !== FRONT_COVER && found.type === FRONT_COVER))
        ) {
          picture = found;
        }
        break;
      }
    }
  }
  if (picture) tags.picture = picture.picture;
  return dropEmpty(tags);
}

function id3Text(data: Uint8Array): string | undefined {
  if (data.length < 1) return undefined;
  const values = decodeId3String(data[0]!, data.subarray(1))
    .split("\0")
    .map((v) => cleanText(v))
    .filter((v): v is string => v !== undefined);
  // v2.4 separates multiple values with NULs: "A\0B" -> "A, B".
  return values.length ? values.join(", ") : undefined;
}

function id3Picture(
  data: Uint8Array,
  v22: boolean,
): { type: number; picture: AudioPicture } | undefined {
  const encoding = data[0]!;
  let pos = 1;
  if (v22) {
    pos += 3; // Three-letter image format, e.g. "JPG".
  } else {
    while (pos < data.length && data[pos] !== 0) pos++;
    pos++; // MIME type and its terminator.
  }
  const type = data[pos]!;
  pos = skipTerminated(data, pos + 1, encoding); // Description.
  return picture(data.subarray(pos), type);
}

/** Skip a NUL-terminated string in `encoding` and return the byte after it. */
function skipTerminated(data: Uint8Array, pos: number, encoding: number) {
  if (encoding === 1 || encoding === 2) {
    while (pos + 1 < data.length && (data[pos] !== 0 || data[pos + 1] !== 0)) {
      pos += 2;
    }
    return pos + 2;
  }
  while (pos < data.length && data[pos] !== 0) pos++;
  return pos + 1;
}

function decodeId3String(encoding: number, data: Uint8Array): string {
  switch (encoding) {
    case 1: {
      // UTF-16 with a byte order mark; little-endian if it is missing.
      if (data[0] === 0xfe && data[1] === 0xff)
        return utf16(data.subarray(2), false);
      if (data[0] === 0xff && data[1] === 0xfe)
        return utf16(data.subarray(2), true);
      return utf16(data, true);
    }
    case 2:
      return utf16(data, false);
    case 3:
      return utf8(data);
    default:
      return latin1(data);
  }
}

/** Undo ID3 unsynchronisation: every 0xFF 0x00 becomes 0xFF. */
function unsynchronise(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  let n = 0;
  for (let i = 0; i < data.length; i++) {
    out[n++] = data[i]!;
    if (data[i] === 0xff && data[i + 1] === 0x00) i++;
  }
  return out.subarray(0, n);
}

function synchsafe(data: Uint8Array, at: number): number {
  return (
    ((data[at]! & 0x7f) << 21) |
    ((data[at + 1]! & 0x7f) << 14) |
    ((data[at + 2]! & 0x7f) << 7) |
    (data[at + 3]! & 0x7f)
  );
}

// ---- ID3v1 ---------------------------------------------------------------

function readId3v1(bytes: Uint8Array): AudioTags {
  const at = bytes.length - 128;
  if (at < 0 || ascii(bytes, at, 3) !== "TAG") return {};
  const field = (offset: number) => {
    const raw = bytes.subarray(at + offset, at + offset + 30);
    const end = raw.indexOf(0);
    return cleanText(latin1(end === -1 ? raw : raw.subarray(0, end)));
  };
  return dropEmpty({ title: field(3), artist: field(33) });
}

// ---- MP4 / m4a -----------------------------------------------------------

type Atom = { type: string; start: number; end: number };

function* atoms(bytes: Uint8Array, start: number, end: number) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = u32(bytes, pos);
    const type = ascii(bytes, pos + 4, 4);
    let header = 8;
    if (size === 1) {
      // 64-bit size. Files here are < 4 GB, so the high word must be 0.
      if (u32(bytes, pos + 8) !== 0) return;
      size = u32(bytes, pos + 12);
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) return;
    yield { type, start: pos + header, end: pos + size } satisfies Atom;
    pos += size;
  }
}

function child(bytes: Uint8Array, parent: Atom, type: string) {
  for (const a of atoms(bytes, parent.start, parent.end)) {
    if (a.type === type) return a;
  }
  return undefined;
}

function readMp4(bytes: Uint8Array): AudioTags {
  const file: Atom = { type: "", start: 0, end: bytes.length };
  const moov = child(bytes, file, "moov");
  const udta = moov && child(bytes, moov, "udta");
  const meta = udta && child(bytes, udta, "meta");
  if (!meta) return {};
  // `meta` is a full box (4 bytes of version and flags before its children)
  // in MP4 files, but a plain atom in QuickTime ones.
  const fullBox = ascii(bytes, meta.start + 8, 4) === "hdlr";
  const ilst = child(
    bytes,
    { ...meta, start: meta.start + (fullBox ? 4 : 0) },
    "ilst",
  );
  if (!ilst) return {};

  const tags: AudioTags = {};
  let albumArtist: string | undefined;
  for (const item of atoms(bytes, ilst.start, ilst.end)) {
    const data = child(bytes, item, "data");
    // `data` payload: 1 byte version, 3 bytes type, 4 bytes locale.
    if (!data || data.end - data.start < 8) continue;
    const payload = bytes.subarray(data.start + 8, data.end);
    switch (item.type) {
      case "©nam":
        tags.title ??= cleanText(utf8(payload));
        break;
      case "©ART":
        tags.artist ??= cleanText(utf8(payload));
        break;
      case "aART":
        albumArtist ??= cleanText(utf8(payload));
        break;
      case "covr":
        tags.picture ??= picture(payload, FRONT_COVER)?.picture;
        break;
    }
  }
  // Album artist only stands in when there is no track artist.
  tags.artist ??= albumArtist;
  return dropEmpty(tags);
}

// ---- WAV -----------------------------------------------------------------

function readWav(bytes: Uint8Array): AudioTags {
  const tags: AudioTags = {};
  for (const chunk of riffChunks(bytes, 12, bytes.length)) {
    if (chunk.type === "id3 " || chunk.type === "ID3 ") {
      const id3 = bytes.subarray(chunk.start, chunk.end);
      if (ascii(id3, 0, 3) === "ID3") {
        const found = readId3v2(id3, 0);
        tags.title ??= found.title;
        tags.artist ??= found.artist;
        tags.picture ??= found.picture;
      }
    } else if (
      chunk.type === "LIST" &&
      ascii(bytes, chunk.start, 4) === "INFO"
    ) {
      for (const info of riffChunks(bytes, chunk.start + 4, chunk.end)) {
        const raw = bytes.subarray(info.start, info.end);
        const end = raw.indexOf(0);
        const value = cleanText(utf8(end === -1 ? raw : raw.subarray(0, end)));
        if (info.type === "INAM") tags.title ??= value;
        if (info.type === "IART") tags.artist ??= value;
      }
    }
  }
  return dropEmpty(tags);
}

function* riffChunks(bytes: Uint8Array, start: number, end: number) {
  let pos = start;
  while (pos + 8 <= end) {
    const type = ascii(bytes, pos, 4);
    const size = u32le(bytes, pos + 4);
    const dataEnd = pos + 8 + size;
    if (dataEnd > end) return;
    yield { type, start: pos + 8, end: dataEnd } satisfies Atom;
    pos = dataEnd + (size & 1); // Chunks are padded to an even length.
  }
}

// ---- Helpers -------------------------------------------------------------

function picture(
  data: Uint8Array,
  type: number,
): { type: number; picture: AudioPicture } | undefined {
  const mimeType = sniffImageType(data);
  if (!mimeType) return undefined;
  // Copy, so the picture doesn't keep the whole audio buffer alive.
  return { type, picture: { mimeType, data: data.slice() } };
}

/** Collapse whitespace and drop control characters; undefined when blank. */
function cleanText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let text = value
    .replace(/[\u0000-\u001f\u007f\ufeff]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > MAX_TAG_TEXT) {
    // Cut in UTF-16 units (what the server counts), never mid surrogate pair.
    text = `${text
      .slice(0, MAX_TAG_TEXT - 1)
      .replace(/[\ud800-\udbff]$/, "")
      .trimEnd()}…`;
  }
  return text === "" ? undefined : text;
}

function dropEmpty(tags: AudioTags): AudioTags {
  const out: AudioTags = {};
  if (tags.title) out.title = tags.title;
  if (tags.artist) out.artist = tags.artist;
  if (tags.picture) out.picture = tags.picture;
  return out;
}

function ascii(data: Uint8Array, at: number, length: number): string {
  if (at < 0 || at + length > data.length) return "";
  return latin1(data.subarray(at, at + length));
}

function latin1(data: Uint8Array): string {
  let s = "";
  for (const b of data) s += String.fromCharCode(b);
  return s;
}

function utf8(data: Uint8Array): string {
  return new TextDecoder("utf-8").decode(data);
}

function utf16(data: Uint8Array, littleEndian: boolean): string {
  let s = "";
  for (let i = 0; i + 1 < data.length; i += 2) {
    s += String.fromCharCode(
      littleEndian
        ? data[i]! | (data[i + 1]! << 8)
        : (data[i]! << 8) | data[i + 1]!,
    );
  }
  return s;
}

function u32(data: Uint8Array, at: number): number {
  return (
    ((data[at]! << 24) >>> 0) +
    ((data[at + 1]! << 16) | (data[at + 2]! << 8) | data[at + 3]!)
  );
}

function u32le(data: Uint8Array, at: number): number {
  return (
    ((data[at + 3]! << 24) >>> 0) +
    ((data[at + 2]! << 16) | (data[at + 1]! << 8) | data[at]!)
  );
}
