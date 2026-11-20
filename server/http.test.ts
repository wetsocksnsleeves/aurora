import { describe, expect, it } from "vitest";
import { readBodyWithLimit, readJson, rejectCrossSite } from "./http";

function streamOf(...chunks: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const n of chunks) controller.enqueue(new Uint8Array(n).fill(n));
      controller.close();
    },
  });
}

describe("readBodyWithLimit", () => {
  it("joins chunks up to the limit", async () => {
    const bytes = await readBodyWithLimit(streamOf(2, 3), 5);
    expect(bytes).toEqual(Uint8Array.from([2, 2, 3, 3, 3]));
  });

  it("returns null past the limit", async () => {
    expect(await readBodyWithLimit(streamOf(2, 3), 4)).toBeNull();
  });

  it("treats a missing body as empty", async () => {
    expect(await readBodyWithLimit(null, 4)).toEqual(new Uint8Array(0));
  });
});

describe("rejectCrossSite", () => {
  const req = (headers: Record<string, string>) =>
    new Request("http://test/", { method: "POST", headers });

  it("allows same-origin and direct requests", () => {
    expect(rejectCrossSite(req({}))).toBeNull();
    expect(
      rejectCrossSite(req({ "sec-fetch-site": "same-origin" })),
    ).toBeNull();
    expect(rejectCrossSite(req({ "sec-fetch-site": "none" }))).toBeNull();
    expect(
      rejectCrossSite(req({ origin: "https://a.example", host: "a.example" })),
    ).toBeNull();
  });

  it("refuses other sites", () => {
    expect(
      rejectCrossSite(req({ "sec-fetch-site": "cross-site" }))?.status,
    ).toBe(403);
    expect(
      rejectCrossSite(req({ "sec-fetch-site": "same-site" }))?.status,
    ).toBe(403);
    expect(
      rejectCrossSite(req({ origin: "https://b.example", host: "a.example" }))
        ?.status,
    ).toBe(403);
    expect(
      rejectCrossSite(req({ origin: "null", host: "a.example" }))?.status,
    ).toBe(403);
  });

  it("trusts Sec-Fetch-Site over Origin when both are present", () => {
    expect(
      rejectCrossSite(
        req({
          "sec-fetch-site": "cross-site",
          origin: "https://a.example",
          host: "a.example",
        }),
      )?.status,
    ).toBe(403);
  });
});

describe("readJson", () => {
  it("requires application/json", async () => {
    const res = await readJson(
      new Request("http://t/", { method: "POST", body: "{}" }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(415);
  });
});
