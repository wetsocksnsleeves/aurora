import type { Metadata } from "next";
import { ParticipantApp } from "./ParticipantApp";

export const metadata: Metadata = {
  title: "lightshow: join the show",
};

export default async function JoinPage(props: PageProps<"/j/[code]">) {
  const { code } = await props.params;
  return <ParticipantApp code={code.toUpperCase()} />;
}
