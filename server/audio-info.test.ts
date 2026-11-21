import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readAudioInfo, readCover } from "./audio-info";
import { audioDir } from "./data-dir";
import { withTempDataDir } from "./testing/temp-data-dir";

withTempDataDir();

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5,
]);
const latin1 = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const be32 = (n: number) => [
  n >>> 24,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
];
const le32 = (n: number) => be32(n).reverse();
const cat = (...parts: ArrayLike<number>[]) =>
  Uint8Array.from(parts.flatMap((p) => Array.from(p)));

function atom(type: string, ...children: ArrayLike<number>[]): Uint8Array {
  const body = cat(...children);
  return cat(be32(body.length + 8), latin1(type), body);
}

function riff(type: string, data: Uint8Array): Uint8Array {
  return cat(latin1(type), le32(data.length), data, data.length & 1 ? [0] : []);
}

function id3WithPng(): Uint8Array {
  const apic = cat([0], latin1("image/png"), [0, 3, 0], PNG);
  const frame = cat(latin1("APIC"), be32(apic.length), [0, 0], apic);
  return cat(latin1("ID3"), [3, 0, 0, 0, 0, 0, frame.length], frame);
}

function write(ext: string, bytes: Uint8Array): string {
  const fileId = `${randomUUID()}.${ext}`;
  fs.mkdirSync(audioDir(), { recursive: true });
  fs.writeFileSync(path.join(audioDir(), fileId), bytes);
  return fileId;
}

describe("readCover", () => {
  it("finds an m4a cover in a moov atom after the audio data", async () => {
    const fileId = write(
      "m4a",
      cat(
        atom("ftyp", latin1("M4A "), be32(0)),
        atom("mdat", new Uint8Array(4096)),
        atom(
          "moov",
          atom(
            "udta",
            atom(
              "meta",
              [0, 0, 0, 0],
              atom("hdlr", new Uint8Array(25)),
              atom("ilst", atom("covr", atom("data", be32(14), be32(0), PNG))),
            ),
          ),
        ),
      ),
    );
    expect((await readCover(fileId))?.data).toEqual(PNG);
  });

  it("finds a cover in a wav id3 chunk", async () => {
    const body = cat(
      latin1("WAVE"),
      riff("fmt ", new Uint8Array(16)),
      riff("data", new Uint8Array(4097)),
      riff("id3 ", id3WithPng()),
    );
    const fileId = write("wav", cat(latin1("RIFF"), le32(body.length), body));
    expect((await readCover(fileId))?.mimeType).toBe("image/png");
  });

  it("ignores an mp3 whose ID3 header claims a huge tag", async () => {
    // Synchsafe 0x7f x4 = 256 MB, in a tiny file.
    const fileId = write(
      "mp3",
      cat(latin1("ID3"), [3, 0, 0, 127, 127, 127, 127]),
    );
    expect(await readCover(fileId)).toBeNull();
  });

  it("reads the title and artist too", async () => {
    const title = cat([0], latin1("Tagged"));
    const frame = cat(latin1("TIT2"), be32(title.length), [0, 0], title);
    const fileId = write(
      "mp3",
      cat(latin1("ID3"), [3, 0, 0, 0, 0, 0, frame.length], frame),
    );
    expect(await readAudioInfo(fileId)).toEqual({ title: "Tagged" });
  });

  it("shares one lookup between concurrent requests", async () => {
    const fileId = write("mp3", id3WithPng());
    const [a, b] = await Promise.all([readCover(fileId), readCover(fileId)]);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });
});
