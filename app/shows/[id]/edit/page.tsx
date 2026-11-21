import { redirect } from "next/navigation";

/** Shows are edited in the room on `/` now (SPEC 2.5). */
export default function EditShowPage() {
  redirect("/");
}
