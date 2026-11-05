"use client";

import { useEffect, useRef, useState } from "react";
import { getSessionStore } from "@/hooks/useSessionStore";
import type { SessionInfo } from "@/lib/types";
import { nextRestoreStep } from "./restore-plan";

export interface InitialRestoreOptions {
  /** Session id from `?session=`. */
  readonly initialSessionId: string | null | undefined;
  /** The shell was asked for a specific cwd: no restore, no automatic pick. */
  readonly skip: boolean | undefined;
  /** The first session list has not settled yet. */
  readonly sessionsLoading: boolean;
  readonly onRestore: (session: SessionInfo) => void;
  /** The session never showed up. */
  readonly onGiveUp?: () => void;
}

/**
 * Reopen the session named in the URL once the list has loaded. A session
 * created moments ago has no file yet, so the lookup is retried a few times
 * (`nextRestoreStep`) before the shell is told it is gone. Returns whether
 * the restore is still looking, so the automatic workspace pick waits for it.
 */
export function useInitialSessionRestore(options: InitialRestoreOptions): { pending: boolean } {
  const { initialSessionId, skip, sessionsLoading } = options;
  const [settled, setSettled] = useState(false);
  const callbacks = useRef({ onRestore: options.onRestore, onGiveUp: options.onGiveUp });
  callbacks.current = { onRestore: options.onRestore, onGiveUp: options.onGiveUp };

  const active = Boolean(initialSessionId) && !skip && !settled;
  useEffect(() => {
    if (!initialSessionId || !active || sessionsLoading) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lookup = async (failedBefore: number): Promise<void> => {
      const target = await getSessionStore().ensureSession(initialSessionId);
      if (cancelled) return;
      if (target) {
        setSettled(true);
        callbacks.current.onRestore(target);
        return;
      }
      const step = nextRestoreStep(failedBefore + 1);
      if (step.action === "give-up") {
        setSettled(true);
        callbacks.current.onGiveUp?.();
        return;
      }
      timer = setTimeout(() => void lookup(failedBefore + 1), step.delayMs);
    };
    void lookup(0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [initialSessionId, active, sessionsLoading]);

  return { pending: active };
}
