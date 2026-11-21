import { describe, expect, it } from "vitest";
import { mainBackCamera, plausibleFov } from "./camera-seat";

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

describe("plausibleFov", () => {
  it("accepts main cameras through ultra-wides", () => {
    expect(plausibleFov(66)).toBe(true);
    expect(plausibleFov(110)).toBe(true);
    expect(plausibleFov(30)).toBe(false);
    expect(plausibleFov(140)).toBe(false);
  });
});
