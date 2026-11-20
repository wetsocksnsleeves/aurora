import type os from "node:os";
import { describe, expect, it } from "vitest";
import { lanAddresses } from "./lan";
import { reachableOrigin } from "./ws";

type Info = os.NetworkInterfaceInfo;

function iface(address: string, family: "IPv4" | "IPv6", internal = false) {
  return {
    address,
    family,
    internal,
    netmask: "",
    mac: "",
    cidr: null,
    ...(family === "IPv6" ? { scopeid: 0 } : {}),
  } as Info;
}

describe("lanAddresses", () => {
  it("keeps external IPv4 addresses only", () => {
    expect(
      lanAddresses({
        lo0: [iface("127.0.0.1", "IPv4", true), iface("::1", "IPv6", true)],
        en0: [iface("fe80::1", "IPv6"), iface("192.168.0.200", "IPv4")],
        en5: [iface("169.254.10.2", "IPv4")],
        utun3: [iface("10.108.10.252", "IPv4")],
      }),
    ).toEqual(["192.168.0.200", "10.108.10.252"]);
  });
});

describe("reachableOrigin", () => {
  it("swaps loopback for the first LAN address, keeping scheme and port", () => {
    const lan = ["192.168.0.200"];
    expect(reachableOrigin("http://localhost:3000", lan)).toBe(
      "http://192.168.0.200:3000",
    );
    expect(reachableOrigin("http://127.0.0.1:3000", lan)).toBe(
      "http://192.168.0.200:3000",
    );
    expect(reachableOrigin("http://[::1]:3000", lan)).toBe(
      "http://192.168.0.200:3000",
    );
  });

  it("leaves reachable origins and empty LAN lists alone", () => {
    expect(reachableOrigin("https://x.trycloudflare.com", ["1.2.3.4"])).toBe(
      "https://x.trycloudflare.com",
    );
    expect(reachableOrigin("http://localhost:3000", [])).toBe(
      "http://localhost:3000",
    );
  });
});
