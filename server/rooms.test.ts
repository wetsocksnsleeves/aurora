import { describe, expect, it } from "vitest";
import { getRoom, saveRoom } from "./db";
import { withTempDataDir } from "./testing/temp-data-dir";

withTempDataDir();

const positioning = { targetWidthM: 0.94, venueWidthM: 200, venueDepthM: 200 };

describe("rooms table (SPEC 2.5)", () => {
  it("saves and reads back a room", () => {
    saveRoom({ code: "ABC234", hostToken: "t", showId: "s1", positioning });
    expect(getRoom("ABC234")).toEqual({
      code: "ABC234",
      hostToken: "t",
      showId: "s1",
      positioning,
    });
    expect(getRoom("ZZZZZZ")).toBeNull();
  });

  it("updates the show and sizes but never the host token", () => {
    saveRoom({ code: "DEF567", hostToken: "first", showId: "s1", positioning });
    saveRoom({
      code: "DEF567",
      hostToken: "second",
      showId: "s2",
      positioning: { ...positioning, targetWidthM: 2 },
    });
    expect(getRoom("DEF567")).toMatchObject({
      hostToken: "first",
      showId: "s2",
      positioning: { targetWidthM: 2 },
    });
  });
});
