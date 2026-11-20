"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import {
  browserHostDeps,
  createHostedSession,
} from "@/app/sessions/host-client";

/**
 * Host a show: create a session for `showId` (the server snapshots the saved
 * show), keep the host token in this tab, and open the host screen.
 * `hosting` is the id being hosted, so its button can show progress.
 */
export function useHostShow(): {
  host: (showId: string) => Promise<void>;
  hosting: string | null;
  error: string | null;
} {
  const router = useRouter();
  const [hosting, setHosting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const host = useCallback(
    async (showId: string) => {
      setHosting(showId);
      setError(null);
      try {
        const code = await createHostedSession(showId, browserHostDeps());
        router.push(`/sessions/${code}/host`);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setHosting(null);
      }
    },
    [router],
  );
  return { host, hosting, error };
}
