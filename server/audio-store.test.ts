import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { MIXTAPE_AUDIO_FILE_ID } from "@/lib/mixtape-show";
import {
  audioExtFor,
  audioFilePath,
  contentFileId,
  isAudioFileId,
  parseRange,
} from "./audio-store";

describe("contentFileId", () => {
  it("makes a valid file id that changes with the bytes", () => {
    const a = contentFileId(new Uint8Array([1, 2, 3]), "mp3");
    expect(isAudioFileId(a)).toBe(true);
    expect(contentFileId(new Uint8Array([1, 2, 3]), "mp3")).toBe(a);
    expect(contentFileId(new Uint8Array([1, 2, 4]), "mp3")).not.toBe(a);
  });

  it("matches the bundled mixtape, so a changed mp3 gets a new URL", () => {
    // Fails if mixtape.mp3 was replaced without rerunning scripts/mixtape.ts.
    const bytes = fs.readFileSync(audioFilePath(MIXTAPE_AUDIO_FILE_ID));
    expect(contentFileId(bytes, "mp3")).toBe(MIXTAPE_AUDIO_FILE_ID);
  });
});

describe("parseRange", () => {
  it("returns null without a header", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("", 100)).toBeNull();
  });

  it("parses a closed range", () => {
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
  });

  it("parses an open-ended range", () => {
    expect(parseRange("bytes=50-", 100)).toEqual({ start: 50, end: 99 });
  });

  it("clamps an end past the file to the last byte", () => {
    expect(parseRange("bytes=90-500", 100)).toEqual({ start: 90, end: 99 });
  });

  it("parses a suffix range", () => {
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-500", 100)).toEqual({ start: 0, end: 99 });
  });

  it("marks a start past the end as unsatisfiable", () => {
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
  });

  it("ignores malformed and multi-range headers", () => {
    expect(parseRange("bytes=9-0", 100)).toBeNull();
    expect(parseRange("bytes=-", 100)).toBeNull();
    expect(parseRange("items=0-9", 100)).toBeNull();
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
  });
});

describe("audioExtFor", () => {
  it("prefers the file extension", () => {
    expect(audioExtFor("Song.MP3", "application/octet-stream")).toBe("mp3");
    expect(audioExtFor("a.m4a", "")).toBe("m4a");
  });

  it("falls back to the MIME type", () => {
    expect(audioExtFor("blob", "audio/x-wav")).toBe("wav");
    expect(audioExtFor("blob", "audio/mpeg")).toBe("mp3");
  });

  it("rejects other formats", () => {
    expect(audioExtFor("a.ogg", "audio/ogg")).toBeNull();
  });
});

describe("isAudioFileId", () => {
  it("accepts <uuid>.<ext> only", () => {
    expect(isAudioFileId("0b6f4c1e-2a7d-4b8e-9f00-123456789abc.mp3")).toBe(
      true,
    );
    expect(isAudioFileId("../lightshow.db")).toBe(false);
    expect(isAudioFileId("0b6f4c1e-2a7d-4b8e-9f00-123456789abc.exe")).toBe(
      false,
    );
  });
});
