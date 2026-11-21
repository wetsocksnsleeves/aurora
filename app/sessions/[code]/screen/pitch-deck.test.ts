import { describe, expect, it } from "vitest";
import { parseDeckMessage } from "./pitch-deck";

describe("parseDeckMessage", () => {
  it.each(["demo", "fullscreen"] as const)("reads %s", (action) => {
    expect(parseDeckMessage({ type: "lightshow-deck", action })).toBe(action);
  });

  it.each([
    null,
    undefined,
    "demo",
    {},
    { type: "lightshow-deck" },
    { type: "lightshow-deck", action: "navigate" },
    { type: "other", action: "demo" },
  ])("ignores %j", (data) => {
    expect(parseDeckMessage(data)).toBeNull();
  });
});
