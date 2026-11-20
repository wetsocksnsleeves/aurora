import { describe, expect, it } from "vitest";
import type { Show } from "@/lib/types";
import type { ShowSummary } from "@/server/db";
import { withTempDataDir } from "@/server/testing/temp-data-dir";
import * as item from "./[id]/route";
import * as collection from "./route";

withTempDataDir();

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

function jsonRequest(method: string, body?: unknown): Request {
  return new Request("http://test/api/shows", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const venue: Show["venue"] = {
  shapes: [
    {
      id: "stalls",
      points: [
        { x: 0.1, y: 0.1 },
        { x: 0.9, y: 0.1 },
        { x: 0.9, y: 0.6 },
        { x: 0.1, y: 0.6 },
      ],
    },
  ],
};

async function create(body?: unknown): Promise<Show> {
  const res = await collection.POST(jsonRequest("POST", body));
  expect(res.status).toBe(201);
  return ((await res.json()) as { show: Show }).show;
}

describe("/api/shows", () => {
  it("creates an empty show from an empty body", async () => {
    const show = await create();
    expect(show.name).toBe("Untitled show");
    expect(show.venue).toEqual({ shapes: [] });
    expect(show.audio).toEqual({ fileId: "", durationMs: 0 });
    expect(show.clips).toEqual([]);
    expect(show.createdAt).toBe(show.updatedAt);
  });

  it("creates a show with a name and venue, and reads it back", async () => {
    const created = await create({ name: "  Finale  ", venue });
    expect(created.name).toBe("Finale");

    const res = await item.GET(jsonRequest("GET"), ctx(created.id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { show: Show }).show).toEqual(created);
  });

  it("lists shows, most recently updated first", async () => {
    const a = await create({ name: "A" });
    const b = await create({ name: "B" });
    await item.PUT(jsonRequest("PUT", { name: "A2" }), ctx(a.id));

    const res = collection.GET();
    const { shows } = (await res.json()) as { shows: ShowSummary[] };
    const ids = shows.map((s) => s.id);
    expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(b.id));
    expect(shows.find((s) => s.id === a.id)).toMatchObject({ name: "A2" });
    expect(shows[0]).not.toHaveProperty("venue");
  });

  it("updates only the fields sent", async () => {
    const created = await create({ name: "Keep me" });
    const clip = {
      id: "c1",
      layer: 0,
      startMs: 0,
      endMs: 1000,
      color: "#ffffff",
      fadeInMs: 0,
      fadeOutMs: 100,
      shape: { kind: "fill" },
    };
    const res = await item.PUT(
      jsonRequest("PUT", { venue, clips: [clip] }),
      ctx(created.id),
    );
    expect(res.status).toBe(200);
    const updated = ((await res.json()) as { show: Show }).show;
    expect(updated.name).toBe("Keep me");
    expect(updated.venue).toEqual(venue);
    expect(updated.clips).toEqual([clip]);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt >= created.updatedAt).toBe(true);

    const reread = await item.GET(jsonRequest("GET"), ctx(created.id));
    expect(((await reread.json()) as { show: Show }).show).toEqual(updated);
  });

  it("ignores attempts to change id and timestamps", async () => {
    const created = await create();
    const res = await item.PUT(
      jsonRequest("PUT", {
        id: "other",
        createdAt: "1970-01-01T00:00:00.000Z",
      }),
      ctx(created.id),
    );
    const updated = ((await res.json()) as { show: Show }).show;
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
  });

  it("rejects invalid shows with 400", async () => {
    const created = await create();
    const outside = {
      venue: {
        shapes: [
          {
            id: "s",
            points: [
              { x: 0, y: 0 },
              { x: 2, y: 0 },
              { x: 0, y: 1 },
            ],
          },
        ],
      },
    };
    const cases: unknown[] = [
      outside,
      { name: "" },
      { venue: { shapes: [{ id: "s", points: [{ x: 0, y: 0 }] }] } },
      { audio: { fileId: "../../etc/passwd", durationMs: 0 } },
      {
        clips: [
          {
            id: "c",
            layer: 0,
            startMs: 10,
            endMs: 5,
            color: "#fff",
            fadeInMs: 0,
            fadeOutMs: 0,
            shape: { kind: "fill" },
          },
        ],
      },
      [],
    ];
    for (const body of cases) {
      const res = await item.PUT(jsonRequest("PUT", body), ctx(created.id));
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBeTruthy();
    }
    const bad = await item.PUT(
      new Request("http://test", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
      ctx(created.id),
    );
    expect(bad.status).toBe(400);
  });

  it("deletes a show", async () => {
    const created = await create();
    const res = await item.DELETE(jsonRequest("DELETE"), ctx(created.id));
    expect(res.status).toBe(204);
    expect((await item.GET(jsonRequest("GET"), ctx(created.id))).status).toBe(
      404,
    );
    expect(
      (await item.DELETE(jsonRequest("DELETE"), ctx(created.id))).status,
    ).toBe(404);
  });

  it("returns 404 for unknown shows", async () => {
    expect((await item.GET(jsonRequest("GET"), ctx("nope"))).status).toBe(404);
    expect(
      (await item.PUT(jsonRequest("PUT", { name: "x" }), ctx("nope"))).status,
    ).toBe(404);
  });

  it("replies 415 unless the body is declared as JSON", async () => {
    const created = await create();
    for (const headers of [{}, { "content-type": "text/plain" }] as Record<
      string,
      string
    >[]) {
      const body = JSON.stringify({ name: "x" });
      const post = await collection.POST(
        new Request("http://test/api/shows", { method: "POST", headers, body }),
      );
      expect(post.status).toBe(415);
      const put = await item.PUT(
        new Request("http://test/api/shows/x", {
          method: "PUT",
          headers,
          body,
        }),
        ctx(created.id),
      );
      expect(put.status).toBe(415);
    }
    const withCharset = await collection.POST(
      new Request("http://test/api/shows", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: "{}",
      }),
    );
    expect(withCharset.status).toBe(201);
  });

  it("refuses cross-site writes with 403", async () => {
    const created = await create({ name: "Target" });
    const crossSite: Record<string, string>[] = [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { origin: "https://evil.example", host: "aurora.example" },
      { origin: "null", host: "aurora.example" },
    ];
    for (const extra of crossSite) {
      const headers = { "content-type": "application/json", ...extra };
      const body = JSON.stringify({ name: "pwned" });
      const label = JSON.stringify(extra);
      const post = await collection.POST(
        new Request("http://test/api/shows", { method: "POST", headers, body }),
      );
      expect(post.status, label).toBe(403);
      const put = await item.PUT(
        new Request("http://test/api/shows/x", {
          method: "PUT",
          headers,
          body,
        }),
        ctx(created.id),
      );
      expect(put.status, label).toBe(403);
      const patch = await item.PATCH(
        new Request("http://test/api/shows/x", {
          method: "PATCH",
          headers,
          body,
        }),
        ctx(created.id),
      );
      expect(patch.status, label).toBe(403);
      const del = await item.DELETE(
        new Request("http://test/api/shows/x", { method: "DELETE", headers }),
        ctx(created.id),
      );
      expect(del.status, label).toBe(403);
    }
    const still = await item.GET(jsonRequest("GET"), ctx(created.id));
    expect(((await still.json()) as { show: Show }).show.name).toBe("Target");
  });

  it("allows same-origin writes", async () => {
    const created = await create();
    const sameOrigin: Record<string, string>[] = [
      { "sec-fetch-site": "same-origin" },
      { origin: "http://aurora.example:3000", host: "aurora.example:3000" },
    ];
    for (const extra of sameOrigin) {
      const res = await item.PUT(
        new Request("http://test/api/shows/x", {
          method: "PUT",
          headers: { "content-type": "application/json", ...extra },
          body: JSON.stringify({ name: "ok" }),
        }),
        ctx(created.id),
      );
      expect(res.status, JSON.stringify(extra)).toBe(200);
    }
  });
});
