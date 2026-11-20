"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { TEST_SHOW_ID } from "@/lib/test-show";
import { browserHostDeps, createHostedSession } from "./sessions/host-client";
import styles from "./page.module.css";

/**
 * Temporary (DEVELOPMENT.md chunk 3): host a session for the hardcoded test
 * show. Chunk 15 replaces it with Host buttons on the show list.
 */
export function NewTestSessionButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onClick = async () => {
    setBusy(true);
    setError(null);
    try {
      const code = await createHostedSession(TEST_SHOW_ID, browserHostDeps());
      router.push(`/sessions/${code}/host`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className={styles.actions}>
      <button
        type="button"
        className={styles.button}
        onClick={onClick}
        disabled={busy}
      >
        {busy ? "Creating…" : "New test session"}
      </button>
      {error ? <p className={styles.error}>{error}</p> : null}
    </div>
  );
}
