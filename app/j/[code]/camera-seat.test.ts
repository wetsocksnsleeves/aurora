import { describe, expect, it } from "vitest";
import {
  androidBackCameras,
  mainBackCamera,
  plausibleFov,
  rankBackCameras,
} from "./camera-seat";

const cam = (deviceId: string, label: string) => ({
  deviceId,
  label,
  kind: "videoinput" as MediaDeviceKind,
});

describe("mainBackCamera", () => {
  it("picks the lowest numbered back camera on Android", () => {
    expect(
      mainBackCamera([
        cam("front", "camera2 1, facing front"),
        cam("uw", "camera2 2, facing back"),
        cam("main", "camera2 0, facing back"),
        cam("tele", "camera2 3, facing back"),
      ]),
    ).toBe("main");
  });

  it('reads Samsung\'s "camera N" names too', () => {
    expect(
      mainBackCamera([
        cam("uw", "camera 2, facing back"),
        cam("front", "camera 1, facing front"),
        cam("main", "camera 0, facing back"),
      ]),
    ).toBe("main");
  });

  it("skips lenses named as ultra-wide or telephoto", () => {
    expect(
      mainBackCamera([
        cam("uw", "camera2 0, facing back (ultra wide)"),
        cam("main", "camera2 4, facing back"),
      ]),
    ).toBe("main");
  });

  it("leaves other browsers to choose (iPhone names cameras differently)", () => {
    expect(
      mainBackCamera([
        cam("a", "Back Ultra Wide Camera"),
        cam("b", "Back Camera"),
      ]),
    ).toBeNull();
    expect(mainBackCamera([])).toBeNull();
  });
});

describe("rankBackCameras", () => {
  const backs = androidBackCameras([
    cam("main", "camera 3, facing back"),
    cam("uw", "camera 0, facing back"),
    cam("tele", "camera 2, facing back"),
  ]);

  it("puts the camera with the flash and autofocus first", () => {
    const traits = new Map([
      ["main", { torch: true, autofocus: true }],
      ["uw", { torch: false, autofocus: false }],
      ["tele", { torch: false, autofocus: true }],
    ]);
    expect(rankBackCameras(backs, traits)).toEqual(["main", "tele", "uw"]);
  });

  it("falls back to the lowest number when cameras can't tell", () => {
    expect(rankBackCameras(backs, new Map())).toEqual(["uw", "tele", "main"]);
  });

  it("puts cameras a scan found to be ultra-wide last", () => {
    expect(rankBackCameras(backs, new Map(), ["uw"])).toEqual([
      "tele",
      "main",
      "uw",
    ]);
  });
});

describe("plausibleFov", () => {
  it("accepts main cameras through ultra-wides", () => {
    expect(plausibleFov(66)).toBe(true);
    expect(plausibleFov(110)).toBe(true);
    expect(plausibleFov(30)).toBe(false);
    expect(plausibleFov(140)).toBe(false);
  });
});
