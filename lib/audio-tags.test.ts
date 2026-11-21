import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_TAG_TEXT,
  readAudioTags,
  sniffImageType,
  titleFromFileName,
} from "./audio-tags";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4,
]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]);

const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const utf8 = (s: string) => new TextEncoder().encode(s);
const cat = (...parts: (Uint8Array | number[])[]) =>
  Uint8Array.from(parts.flatMap((p) => Array.from(p)));
const be32 = (n: number) => [
  n >>> 24,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
];
const le32 = (n: number) => be32(n).reverse();
const synchsafe = (n: number) => [
  (n >>> 21) & 127,
  (n >>> 14) & 127,
  (n >>> 7) & 127,
  n & 127,
];

function utf16le(s: string): Uint8Array {
  const out: number[] = [0xff, 0xfe];
  for (const c of s) out.push(c.charCodeAt(0) & 255, c.charCodeAt(0) >> 8);
  return Uint8Array.from(out);
}

function id3(major: 2 | 3 | 4, frames: Uint8Array[], flags = 0): Uint8Array {
  const body = cat(...frames, new Uint8Array(16)); // Plus padding.
  return cat(latin1("ID3"), [major, 0, flags], synchsafe(body.length), body);
}

function frame(major: 3 | 4, id: string, data: Uint8Array): Uint8Array {
  const size = major === 4 ? synchsafe(data.length) : be32(data.length);
  return cat(latin1(id), size, [0, 0], data);
}

function frame22(id: string, data: Uint8Array): Uint8Array {
  const n = data.length;
  return cat(latin1(id), [n >> 16, (n >> 8) & 255, n & 255], data);
}

function atom(
  type: string,
  ...children: (Uint8Array | number[])[]
): Uint8Array {
  const body = cat(...children);
  return cat(be32(body.length + 8), latin1(type), body);
}

function ilstItem(type: string, dataType: number, payload: Uint8Array) {
  return atom(type, atom("data", be32(dataType), [0, 0, 0, 0], payload));
}

function riff(type: string, data: Uint8Array): Uint8Array {
  const pad = data.length & 1 ? [0] : [];
  return cat(latin1(type), le32(data.length), data, pad);
}

describe("readAudioTags", () => {
  it("reads ID3v2.3 text and the front cover", () => {
    const tags = readAudioTags(
      id3(3, [
        frame(3, "TIT2", cat([0], latin1("Café Song"))),
        frame(3, "TPE1", cat([1], utf16le("DJ Über"), [0, 0])),
        // A back cover (type 4) first, then the front cover (type 3).
        frame(3, "APIC", cat([0], latin1("image/png"), [0, 4], [0], PNG)),
        frame(
          3,
          "APIC",
          cat([0], latin1("image/jpeg"), [0, 3], latin1("x"), [0], JPEG),
        ),
      ]),
    );
    expect(tags.title).toBe("Café Song");
    expect(tags.artist).toBe("DJ Über");
    expect(tags.picture).toEqual({ mimeType: "image/jpeg", data: JPEG });
  });

  it("reads ID3v2.4 UTF-8 frames and joins multiple values", () => {
    const tags = readAudioTags(
      id3(4, [
        frame(4, "TIT2", cat([3], utf8("✨ Night ✨"))),
        frame(4, "TPE1", cat([3], utf8("A\0B"))),
        frame(
          4,
          "APIC",
          cat([3], latin1("image/png"), [0, 3], utf8("desc"), [0], PNG),
        ),
      ]),
    );
    expect(tags).toEqual({
      title: "✨ Night ✨",
      artist: "A, B",
      picture: { mimeType: "image/png", data: PNG },
    });
  });

  it("reads ID3v2.2 frames", () => {
    const tags = readAudioTags(
      id3(2, [
        frame22("TT2", cat([0], latin1("Old"))),
        frame22("PIC", cat([0], latin1("PNG"), [3, 0], PNG)),
      ]),
    );
    expect(tags).toEqual({
      title: "Old",
      picture: { mimeType: "image/png", data: PNG },
    });
  });

  it("undoes whole-tag unsynchronisation in ID3v2.3", () => {
    // 0xFF 0xD8 0xFF is written as 0xFF 0x00 0xD8 0xFF 0x00.
    const unsynced = Uint8Array.from([0xff, 0x00, 0xd8, 0xff, 0x00, 0xe0, 1]);
    const data = cat([0], latin1("image/jpeg"), [0, 3], [0], unsynced);
    // Frame sizes count the bytes after resynchronisation.
    const header = cat(latin1("APIC"), be32(data.length - 2), [0, 0]);
    const tags = readAudioTags(id3(3, [cat(header, data)], 0x80));
    expect(tags.picture?.data).toEqual(
      Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1]),
    );
  });

  it("falls back to ID3v1 at the end of an mp3", () => {
    const tag = new Uint8Array(128);
    tag.set(latin1("TAG"), 0);
    tag.set(latin1("Short Title"), 3);
    tag.set(latin1("Someone"), 33);
    const tags = readAudioTags(
      cat([0xff, 0xfb, 0x90, 0x00], new Uint8Array(400), tag),
    );
    expect(tags).toEqual({ title: "Short Title", artist: "Someone" });
  });

  it("reads m4a ilst atoms", () => {
    const file = cat(
      atom("ftyp", latin1("M4A "), be32(0)),
      atom(
        "moov",
        atom("mvhd", new Uint8Array(8)),
        atom(
          "udta",
          atom(
            "meta",
            [0, 0, 0, 0], // Full box version and flags.
            atom("hdlr", new Uint8Array(25)),
            atom(
              "ilst",
              ilstItem("aART", 1, utf8("Album Person")),
              ilstItem("©nam", 1, utf8("M4A Song")),
              ilstItem("©ART", 1, utf8("Track Person")),
              ilstItem("covr", 13, JPEG),
            ),
          ),
        ),
      ),
      atom("mdat", new Uint8Array(32)),
    );
    expect(readAudioTags(file)).toEqual({
      title: "M4A Song",
      artist: "Track Person",
      picture: { mimeType: "image/jpeg", data: JPEG },
    });
  });

  it("reads wav LIST/INFO and id3 chunks", () => {
    const info = cat(
      latin1("INFO"),
      riff("INAM", cat(latin1("Wave Name"), [0])),
      riff("IART", cat(latin1("Wavy"), [0])),
    );
    const embedded = id3(3, [
      frame(3, "APIC", cat([0], latin1("image/png"), [0, 3], [0], PNG)),
    ]);
    const body = cat(
      latin1("WAVE"),
      riff("fmt ", new Uint8Array(16)),
      riff("data", new Uint8Array(9)),
      riff("LIST", info),
      riff("id3 ", embedded),
    );
    const file = cat(latin1("RIFF"), le32(body.length), body);
    expect(readAudioTags(file)).toEqual({
      title: "Wave Name",
      artist: "Wavy",
      picture: { mimeType: "image/png", data: PNG },
    });
  });

  it("cuts very long titles to MAX_TAG_TEXT characters", () => {
    const tags = readAudioTags(
      id3(3, [frame(3, "TIT2", cat([0], latin1("x".repeat(5000))))]),
    );
    expect(tags.title).toHaveLength(MAX_TAG_TEXT);
    expect(tags.title?.endsWith("\u2026")).toBe(true);
    expect(titleFromFileName(`${"y".repeat(300)}.mp3`)).toHaveLength(
      MAX_TAG_TEXT,
    );
  });

  it("returns nothing for untagged, truncated or junk bytes", () => {
    expect(readAudioTags(new Uint8Array(0))).toEqual({});
    expect(
      readAudioTags(Uint8Array.from({ length: 300 }, (_, i) => i)),
    ).toEqual({});
    const truncated = id3(3, [
      frame(3, "TIT2", cat([0], latin1("Cut off here"))),
    ]);
    expect(readAudioTags(truncated.subarray(0, 18))).toEqual({});
  });

  it("ignores pictures that aren't web images", () => {
    const tags = readAudioTags(
      id3(3, [
        frame(
          3,
          "APIC",
          cat([0], latin1("text/html"), [0, 3], [0], latin1("<script>")),
        ),
      ]),
    );
    expect(tags.picture).toBeUndefined();
  });

  it("reads the built-in mixtape, which has no title or cover", () => {
    const bytes = new Uint8Array(
      fs.readFileSync("public/builtin-audio/mixtape.mp3"),
    );
    expect(readAudioTags(bytes)).toEqual({});
  });
});

describe("sniffImageType", () => {
  it("recognises JPEG and PNG only by their bytes", () => {
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(latin1("GIF89a"))).toBe("image/gif");
    expect(sniffImageType(latin1("<svg"))).toBeNull();
  });
});

describe("titleFromFileName", () => {
  it("drops the extension and any folder", () => {
    expect(titleFromFileName("My Song.mp3")).toBe("My Song");
    expect(titleFromFileName("dir/a.b.wav")).toBe("a.b");
    expect(titleFromFileName(".hidden")).toBe(".hidden");
  });
});
