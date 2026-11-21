import { redirect } from "next/navigation";

/** The room on `/` is the host screen now (SPEC 2.5). */
export default function HostPage() {
  redirect("/");
}
