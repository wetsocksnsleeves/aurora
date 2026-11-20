import type { Metadata } from "next";
import { ScreenApp } from "./ScreenApp";

export const metadata: Metadata = {
  title: "Lightshow screen",
};

/**
 * The big screen (SPEC 2.4): the positioning target phones scan to find
 * their seat, with the join QR code in the middle. The host page links here
 * with the session's join URL in `?join=`.
 */
export default async function ScreenPage(
  props: PageProps<"/sessions/[code]/screen">,
) {
  const { code } = await props.params;
  const { join } = await props.searchParams;
  return (
    <ScreenApp
      code={code.toUpperCase()}
      joinUrl={typeof join === "string" ? join : null}
    />
  );
}
