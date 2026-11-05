"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useRecentRunsLimit } from "@/hooks/useRecentRunsLimit";
import {
  createSessionStore,
  selectWithCache,
  type SelectionCache,
  type SessionStore,
  type SessionStoreSnapshot,
} from "@/lib/session-store";

declare global {
  // Shared across module instances: a hot reload keeps the data and the open event channel.
  var __ompSessionStore: SessionStore | undefined;
}

/** The one store of the page. Create-on-first-use, so importing this module costs nothing. */
export function getSessionStore(): SessionStore {
  globalThis.__ompSessionStore ??= createSessionStore();
  return globalThis.__ompSessionStore;
}

/**
 * Subscribe to a slice of the store. The component re-renders only when the
 * selected value changes under `isEqual` (default `Object.is`), so selectors
 * may build objects or sets as long as an equal comparator is passed.
 */
export function useSessionStoreSelector<T>(
  selector: (snapshot: SessionStoreSnapshot) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const store = getSessionStore();
  const clientCache = useRef<SelectionCache<T> | null>(null);
  const serverCache = useRef<SelectionCache<T> | null>(null);
  const getSnapshot = useCallback(
    () => selectWithCache(clientCache, store.getSnapshot(), selector, isEqual),
    [store, selector, isEqual],
  );
  const getServerSnapshot = useCallback(
    () => selectWithCache(serverCache, store.getServerSnapshot(), selector, isEqual),
    [store, selector, isEqual],
  );
  return useSyncExternalStore(store.subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Keep the store alive for as long as the app is mounted (event channel,
 * recovery listeners, first load) and feed it the user's recent-runs limit.
 * Mount it once, in the shell; the data hooks do not start the store.
 */
export function useSessionStoreLifecycle(): void {
  const { limit } = useRecentRunsLimit();
  useEffect(() => {
    getSessionStore().setRecentRunsLimit(limit);
  }, [limit]);
  useEffect(() => {
    const store = getSessionStore();
    store.retain();
    return () => store.release();
  }, []);
}
