import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_AUDIO_BYTES } from "@/server/audio-store";
import { withTempDataDir } from "@/server/testing/temp-data-dir";
import * as item from "./[fileId]/route";
import * as upload from "./route";

const dataDir = withTempDataDir();

function uploadRequest(file: File | string | null): Request {
  const form = new FormData();
  if (file !== null) form.set("file", file);
  return new Request("http://localhost/api/audio", {
    method: "POST",
    body: form,
  });
}

function getRequest(range?: string): Request {
  return new Request("http://localhost/api/audio/x", {
    headers: range ? { range } : {},
  });
}

function ctx(fileId: string) {
  return { params: Promise.resolve({ fileId }) };
}

// 256 distinct bytes, so any slice is easy to check.
const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);

async function uploadMp3(): Promise<string> {
  const res = await upload.POST(
    uploadRequest(new File([bytes], "track.mp3", { type: "audio/mpeg" })),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { fileId: string; url: string };
  expect(body.url).toBe(`/api/audio/${body.fileId}`);
  return body.fileId;
}

describe("/api/audio", () => {
  it("stores the upload under data/audio/<id>.<ext>", async () => {
    const fileId = await uploadMp3();
    expect(fileId).toMatch(/\.mp3$/);
    const stored = fs.readFileSync(path.join(dataDir(), "audio", fileId));
    expect(new Uint8Array(stored)).toEqual(bytes);
  });

  it("serves the whole file with the right content type", async () => {
    const fileId = await uploadMp3();
    const res = await item.GET(getRequest(), ctx(fileId));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("256");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("serves byte ranges with 206", async () => {
    const fileId = await uploadMp3();
    const res = await item.GET(getRequest("bytes=10-19"), ctx(fileId));
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 10-19/256");
    expect(res.headers.get("content-length")).toBe("10");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      bytes.slice(10, 20),
    );

    const tail = await item.GET(getRequest("bytes=-6"), ctx(fileId));
    expect(tail.status).toBe(206);
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(bytes.slice(250));
  });

  it("replies 416 to a range past the end", async () => {
    const fileId = await uploadMp3();
    const res = await item.GET(getRequest("bytes=300-"), ctx(fileId));
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */256");
  });

  it("serves wav and m4a with their content types", async () => {
    for (const [name, type] of [
      ["a.wav", "audio/wav"],
      ["a.m4a", "audio/mp4"],
    ] as const) {
      const res = await upload.POST(uploadRequest(new File([bytes], name)));
      const { fileId } = (await res.json()) as { fileId: string };
      const got = await item.GET(getRequest(), ctx(fileId));
      expect(got.headers.get("content-type")).toBe(type);
      await got.arrayBuffer();
    }
  });

  it("rejects missing, empty and unsupported uploads", async () => {
    expect((await upload.POST(uploadRequest(null))).status).toBe(400);
    expect((await upload.POST(uploadRequest("not a file"))).status).toBe(400);
    expect(
      (await upload.POST(uploadRequest(new File([], "a.mp3")))).status,
    ).toBe(400);
    expect(
      (
        await upload.POST(
          uploadRequest(new File([bytes], "a.ogg", { type: "audio/ogg" })),
        )
      ).status,
    ).toBe(415);
    const notForm = new Request("http://localhost/api/audio", {
      method: "POST",
      body: "x",
    });
    expect((await upload.POST(notForm)).status).toBe(400);
  });

  it("returns 404 for unknown or invalid ids", async () => {
    const missing = "0b6f4c1e-2a7d-4b8e-9f00-123456789abc.mp3";
    expect((await item.GET(getRequest(), ctx(missing))).status).toBe(404);
    expect((await item.GET(getRequest(), ctx("..%2Faurora.db"))).status).toBe(
      404,
    );
  });

  it("replies 413 to an oversized chunked upload without reading all of it", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const sendLimit = MAX_AUDIO_BYTES * 4;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= sendLimit) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    // No Content-Length: the body streams in chunks of unknown total size.
    const request = new Request("http://localhost/api/audio", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body,
      duplex: "half",
    } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();
    const res = await upload.POST(request);
    expect(res.status).toBe(413);
    // Stopped within a few chunks of the cap, not at the end of the stream.
    expect(sent).toBeLessThan(MAX_AUDIO_BYTES + 4 * chunk.byteLength);
  });

  it("replies 413 when Content-Length is over the cap", async () => {
    const request = new Request("http://localhost/api/audio", {
      method: "POST",
      headers: { "content-length": String(MAX_AUDIO_BYTES + 1) },
    });
    expect((await upload.POST(request)).status).toBe(413);
  });

  it("refuses cross-site uploads with 403", async () => {
    const crossSite: Record<string, string>[] = [
      { "sec-fetch-site": "cross-site" },
      { origin: "https://evil.example", host: "localhost:3000" },
    ];
    for (const headers of crossSite) {
      const form = new FormData();
      form.set("file", new File([bytes], "a.mp3"));
      const res = await upload.POST(
        new Request("http://localhost/api/audio", {
          method: "POST",
          headers,
          body: form,
        }),
      );
      expect(res.status, JSON.stringify(headers)).toBe(403);
    }
  });

  it("refuses unknown Host headers with 403", async () => {
    const fileId = await uploadMp3();
    const res = await item.GET(
      new Request("http://localhost/api/audio/x", {
        headers: { host: "rebind.evil.example" },
      }),
      ctx(fileId),
    );
    expect(res.status).toBe(403);
    const form = new FormData();
    form.set("file", new File([bytes], "a.mp3"));
    const up = await upload.POST(
      new Request("http://localhost/api/audio", {
        method: "POST",
        headers: { host: "rebind.evil.example" },
        body: form,
      }),
    );
    expect(up.status).toBe(403);
  });
});
