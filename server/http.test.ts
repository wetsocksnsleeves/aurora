import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";
import {
  allowedHostnames,
  guardApiRequest,
  hostnameOf,
  MAX_JSON_BYTES,
  readBodyWithLimit,
  readJson,
  rejectCrossSite,
  rejectDisallowedHost,
} from "./http";

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
    new Request("http://localhost/", { method: "POST", headers });

  it("allows same-origin and direct requests", () => {
    expect(rejectCrossSite(req({}))).toBeNull();
    expect(
      rejectCrossSite(req({ "sec-fetch-site": "same-origin" })),
    ).toBeNull();
    expect(rejectCrossSite(req({ "sec-fetch-site": "none" }))).toBeNull();
    expect(
      rejectCrossSite(
        req({ origin: "http://localhost:3000", host: "localhost:3000" }),
      ),
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
      new Request("http://localhost/", { method: "POST", body: "{}" }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(415);
  });
});

describe("hostnameOf", () => {
  it("strips ports and lowercases", () => {
    expect(hostnameOf("LocalHost:3000")).toBe("localhost");
    expect(hostnameOf("[::1]:3000")).toBe("[::1]");
    expect(hostnameOf("https://Show.Example/path")).toBe("show.example");
    expect(hostnameOf("")).toBeNull();
    expect(hostnameOf("null")).toBe("null");
    expect(hostnameOf("bad host")).toBeNull();
  });
});

describe("allowedHostnames", () => {
  it("always includes loopback", () => {
    expect([...allowedHostnames({}, [])].sort()).toEqual([
      "127.0.0.1",
      "[::1]",
      "localhost",
    ]);
  });

  it("adds the PUBLIC_URL host and ALLOWED_HOSTS", () => {
    const hosts = allowedHostnames({
      PUBLIC_URL: "https://abc.trycloudflare.com",
      ALLOWED_HOSTS: " 192.168.1.20:3000 ,aurora.local,,",
    });
    expect(hosts.has("abc.trycloudflare.com")).toBe(true);
    expect(hosts.has("192.168.1.20")).toBe(true);
    expect(hosts.has("aurora.local")).toBe(true);
    expect(hosts.has("")).toBe(false);
  });

  it("adds this machine's LAN addresses", () => {
    const hosts = allowedHostnames({}, ["192.168.0.200", "10.0.0.5"]);
    expect(hosts.has("192.168.0.200")).toBe(true);
    expect(hosts.has("10.0.0.5")).toBe(true);
  });
});

describe("rejectDisallowedHost", () => {
  const req = (host: string) =>
    new Request("http://localhost/api/shows", { headers: { host } });

  it("allows loopback on any port and refuses other hosts", () => {
    expect(rejectDisallowedHost(req("localhost:3000"))).toBeNull();
    expect(rejectDisallowedHost(req("127.0.0.1:45678"))).toBeNull();
    expect(rejectDisallowedHost(req("evil.example"))?.status).toBe(403);
    expect(rejectDisallowedHost(req("localhost.evil.example"))?.status).toBe(
      403,
    );
  });

  it("runs in the API proxy", () => {
    expect(proxy(req("evil.example"))?.status).toBe(403);
    expect(proxy(req("localhost:3000"))).toBeUndefined();
  });
});

describe("rejectCrossSite with Origin", () => {
  const write = (headers: Record<string, string>) =>
    new Request("http://localhost/api/shows", { method: "POST", headers });

  it("accepts exactly the request's own origin", () => {
    expect(
      rejectCrossSite(
        write({ origin: "http://localhost:3000", host: "localhost:3000" }),
      ),
    ).toBeNull();
    // Behind a TLS tunnel the scheme comes from x-forwarded-proto.
    expect(
      rejectCrossSite(
        write({
          origin: "https://show.example",
          host: "show.example",
          "x-forwarded-proto": "https",
        }),
      ),
    ).toBeNull();
  });

  it("refuses the same host on another port", () => {
    for (const origin of ["http://localhost:3001", "http://127.0.0.1:9999"]) {
      const host = origin.includes("127.0.0.1")
        ? "127.0.0.1:3000"
        : "localhost:3000";
      expect(rejectCrossSite(write({ origin, host }))?.status, origin).toBe(
        403,
      );
    }
  });

  it("refuses a different scheme", () => {
    expect(
      rejectCrossSite(
        write({ origin: "https://localhost:3000", host: "localhost:3000" }),
      )?.status,
    ).toBe(403);
    expect(
      rejectCrossSite(
        write({
          origin: "http://show.example",
          host: "show.example",
          "x-forwarded-proto": "https",
        }),
      )?.status,
    ).toBe(403);
  });

  it("accepts the PUBLIC_URL origin", () => {
    const saved = process.env.PUBLIC_URL;
    process.env.PUBLIC_URL = "https://abc.trycloudflare.com";
    try {
      // A tunnel that rewrites Host to the local address.
      expect(
        rejectCrossSite(
          write({
            origin: "https://abc.trycloudflare.com",
            host: "localhost:3000",
          }),
        ),
      ).toBeNull();
      expect(
        rejectCrossSite(
          write({
            origin: "http://abc.trycloudflare.com",
            host: "localhost:3000",
          }),
        )?.status,
      ).toBe(403);
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_URL;
      else process.env.PUBLIC_URL = saved;
    }
  });

  it("refuses null and malformed origins", () => {
    for (const origin of ["null", "not a url", "file:///etc/passwd"]) {
      expect(
        rejectCrossSite(write({ origin, host: "localhost:3000" }))?.status,
        origin,
      ).toBe(403);
    }
  });

  it("leaves DNS rebinding to the Host allowlist", () => {
    // Attacker controls both headers, so Origin matches Host; the Host check
    // in guardApiRequest is what refuses it.
    const rebinding = write({
      origin: "http://evil.example",
      host: "evil.example",
    });
    expect(guardApiRequest(rebinding, { write: true })?.status).toBe(403);
  });
});

describe("readJson size cap", () => {
  it("replies 413 past MAX_JSON_BYTES", async () => {
    const res = await readJson(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `"${"x".repeat(MAX_JSON_BYTES)}"`,
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(413);
  });

  it("rejects invalid UTF-8 with 400", async () => {
    const res = await readJson(
      new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new Uint8Array([0x22, 0xff, 0x22]),
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(400);
  });
});
