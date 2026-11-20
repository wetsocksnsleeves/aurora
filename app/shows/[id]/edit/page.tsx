import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Editor } from "@/components/editor/Editor";
import { getShow } from "@/server/db";

// Reads SQLite (better-sqlite3, a native module) on every request.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Edit show · Aurora" };

export default async function EditShowPage({
  params,
}: PageProps<"/shows/[id]/edit">) {
  const { id } = await params;
  const show = getShow(id);
  if (!show) notFound();
  return <Editor initialShow={show} />;
}
