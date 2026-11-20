"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createShow } from "@/components/editor/api";

/**
 * Creates an empty show and opens it in the editor. Used by the show list.
 */
export function CreateShowButton({
  className,
  errorClassName,
}: {
  className?: string;
  errorClassName?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setBusy(true);
    setError(null);
    try {
      const show = await createShow();
      router.push(`/shows/${show.id}/edit`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={className}
        onClick={onClick}
        disabled={busy}
      >
        {busy ? "Creating…" : "New show"}
      </button>
      {error && (
        <p role="alert" className={errorClassName}>
          Could not create a show: {error}
        </p>
      )}
    </>
  );
}
