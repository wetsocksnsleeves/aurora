import type { Metadata } from "next";
import { headers } from "next/headers";
import { allowedHostnames, hostnameOf } from "@/server/http";
import { safeJoinUrl } from "./join-url";
import { ScreenApp } from "./ScreenApp";

export const metadata: Metadata = {
  title: "Lightshow screen",
};

/**
 * The big screen (SPEC 2.4): the positioning target phones scan to find
 * their seat, with the join QR code in the middle. The host page links here
 * with the session's join URL in `?join=`, checked by `safeJoinUrl`.
 */
export default async function ScreenPage(
  props: PageProps<"/sessions/[code]/screen">,
) {
  const { code } = await props.params;
  const { join } = await props.searchParams;
  // This page's own host is fine too (a tunnel without PUBLIC_URL set).
  const hosts = allowedHostnames();
  const ownHost = hostnameOf((await headers()).get("host") ?? "");
  if (ownHost) hosts.add(ownHost);
  return (
    <ScreenApp
      code={code.toUpperCase()}
      joinUrl={safeJoinUrl(join, code, hosts)}
    />
  );
}
