"use client";

import { useEffect, useState } from "react";
import { openEventStream } from "@/lib/event-stream";

const NO_SESSIONS: ReadonlySet<string> = new Set();

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * Ids of sessions with a run in flight, from the shared `running` channel (one
 * more subscription on the single event socket, never a new connection). The
 * shell mounts this so the session tabs keep their indicators while the
 * sidebar is unmounted (full-page Settings). `listVersion` ticks whenever the
 * server hints that the session list changed.
 */
export function useRunningSessionIds(enabled: boolean): { runningIds: ReadonlySet<string>; listVersion: number } {
  const [runningIds, setRunningIds] = useState<ReadonlySet<string>>(NO_SESSIONS);
  const [listVersion, setListVersion] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const source = openEventStream({ kind: "running" });
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string; runningSessionIds?: string[]; refreshSessionList?: boolean };
        if (data.type === "running") {
          const next = new Set(data.runningSessionIds ?? []);
          setRunningIds((current) => (sameIds(current, next) ? current : next));
          if (data.refreshSessionList) setListVersion((version) => version + 1);
        } else if (data.type === "sessions-changed" && data.refreshSessionList) {
          setListVersion((version) => version + 1);
        }
      } catch {
        // ignore malformed frames
      }
    };
    return () => {
      source.close();
      setRunningIds(NO_SESSIONS);
    };
  }, [enabled]);

  return { runningIds, listVersion };
}
