import { describe, expect, it } from "vitest";
import { safeJoinUrl } from "./join-url";

const hosts = new Set(["localhost", "192.168.0.20", "show.example"]);

describe("safeJoinUrl", () => {
  it("accepts this session's join page on an allowed host", () => {
    expect(safeJoinUrl("https://show.example/j/ABC234", "ABC234", hosts)).toBe(
      "https://show.example/j/ABC234",
    );
    expect(
      safeJoinUrl("http://192.168.0.20:3000/j/abc234", "ABC234", hosts),
    ).toBe("http://192.168.0.20:3000/j/abc234");
  });

  it("refuses other hosts, paths, sessions and schemes", () => {
    for (const join of [
      "https://evil.example/j/ABC234",
      "https://show.example/phish",
      "https://show.example/j/OTHER9",
      "https://show.example/j/ABC234?next=https://evil.example",
      "https://user@show.example/j/ABC234",
      "javascript:alert(1)",
      "not a url",
      undefined,
      ["https://show.example/j/ABC234"],
    ]) {
      expect(safeJoinUrl(join, "ABC234", hosts)).toBeNull();
    }
  });
});
