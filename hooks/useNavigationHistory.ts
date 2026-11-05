"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  canGoNavigationBack,
  canGoNavigationForward,
  createNavigationHistory,
  peekNavigationEntry,
  pushNavigationEntry,
  removeNavigationEntryAt,
  stepNavigationHistory,
  type NavigationEntry,
  type NavigationHistory,
} from "@/lib/navigation-history";

export interface NavigationHistoryController {
  /** A previous view exists (enables the Navigate-back button). */
  canBack: boolean;
  /** A forward view exists (enables the Navigate-forward button). */
  canForward: boolean;
  /**
   * Record the currently displayed view. Re-recording the entry the cursor
   * already sits on is a no-op, so AppShell's view-change effect can call
   * this unconditionally: back/forward application re-records its own target
   * and pushes nothing, while every other view change pushes normally.
   */
  record: (entry: NavigationEntry) => void;
  /** The entry one step back/forward without moving the cursor. */
  peekBack: () => NavigationEntry | null;
  peekForward: () => NavigationEntry | null;
  /** Move the cursor one step — call only after the peeked entry resolved. */
  commitBack: () => void;
  commitForward: () => void;
  /** Drop the peeked entry (its session is gone) so the next peek skips it. */
  dropPeekedBack: () => void;
  dropPeekedForward: () => void;
}

/**
 * In-app back/forward over visited chat views (see lib/navigation-history.ts
 * for why this is not the browser History API). AppShell drives it:
 *
 *   record()      from a view-change effect (every session switch, new chat,
 *                 fork, created session, close);
 *   peek/commit   around resolving the target session — peek, fetch the
 *                 session by id, commit + select it, and dropPeeked when the
 *                 id no longer resolves so navigation skips dead entries.
 */
export function useNavigationHistory(): NavigationHistoryController {
  const [history, setHistory] = useState<NavigationHistory>(createNavigationHistory);

  // The ref is the source of truth; `history` state only mirrors it for
  // rendering. AppShell's skip loop peeks again right after dropping a dead
  // entry, in the same tick and before React re-renders, so every transition
  // must be visible to peek() immediately. Updating through a queued
  // `setHistory(prev => ...)` made the loop re-peek the entry it had just
  // dropped and then drop its (live) neighbor instead.
  const historyRef = useRef(history);
  const apply = useCallback((transition: (prev: NavigationHistory) => NavigationHistory) => {
    const next = transition(historyRef.current);
    if (next === historyRef.current) return;
    historyRef.current = next;
    setHistory(next);
  }, []);

  const record = useCallback((entry: NavigationEntry) => {
    apply((prev) => pushNavigationEntry(prev, entry));
  }, [apply]);

  const peekBack = useCallback(() => peekNavigationEntry(historyRef.current, -1), []);
  const peekForward = useCallback(() => peekNavigationEntry(historyRef.current, 1), []);
  const commitBack = useCallback(() => {
    apply((prev) => stepNavigationHistory(prev, -1));
  }, [apply]);
  const commitForward = useCallback(() => {
    apply((prev) => stepNavigationHistory(prev, 1));
  }, [apply]);
  const dropPeekedBack = useCallback(() => {
    apply((prev) => removeNavigationEntryAt(prev, prev.index - 1));
  }, [apply]);
  const dropPeekedForward = useCallback(() => {
    apply((prev) => removeNavigationEntryAt(prev, prev.index + 1));
  }, [apply]);

  return useMemo(() => ({
    canBack: canGoNavigationBack(history),
    canForward: canGoNavigationForward(history),
    record,
    peekBack,
    peekForward,
    commitBack,
    commitForward,
    dropPeekedBack,
    dropPeekedForward,
  }), [history, record, peekBack, peekForward, commitBack, commitForward, dropPeekedBack, dropPeekedForward]);
}
