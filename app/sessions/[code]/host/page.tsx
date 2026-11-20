import type { Metadata } from "next";
import { HostApp } from "./HostApp";

export const metadata: Metadata = {
  title: "Aurora: host",
};

export default async function HostPage(
  props: PageProps<"/sessions/[code]/host">,
) {
  const { code } = await props.params;
  return <HostApp code={code.toUpperCase()} />;
}
