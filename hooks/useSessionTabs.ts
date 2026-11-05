"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";
import { getSessionStore, useSessionStoreSelector } from "@/hooks/useSessionStore";
import { resolveStoreSession, type ResolvedSession } from "@/lib/resolve-session";
import type { SessionStoreSnapshot } from "@/lib/session-store";
import {
  SESSION_TABS_STORAGE_KEY,
  closeSessionTab,
  mergeStoredSessionTabs,
  moveSessionTab,
  parseSessionTabs,
  reconcileSessionTabs,
  removeSessionTab,
  renameSessionTabId,
  serializeSessionTabs,
  sessionTabFromSession,
  shiftSessionTab,
  upsertSessionTab,
  rememberScrollAnchor,
  type ScrollAnchor,
  type SessionTab,
} from "@/lib/session-tabs";

const selectSessions = (snapshot: SessionStoreSnapshot) => snapshot.sessions;
const selectSessionsReady = (snapshot: SessionStoreSnapshot) => snapshot.sessionsStatus === "ready";

/**
 * Open session tabs for the desktop tab strip. The selected session is always
 * a tab; the list persists per browser and is reconciled with the session list
 * so titles stay current and deleted or archived sessions fall away. The
 * list comes from the shared session store; this hook never fetches it.
 */
export function useSessionTabs({ enabled, selectedSession }: {
  enabled: boolean;
  selectedSession: SessionInfo | null;
}) {
  const [tabs, setTabs] = useState<SessionTab[]>([]);
  const [storageLoaded, setStorageLoaded] = useState(false);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // Full session records for the tabs, so activating one needs no list fetch.
  const sessionCacheRef = useRef(new Map<string, SessionInfo>());
  // Sessions shown since this page loaded may not be on disk yet; the list
  // reconciliation must not mistake them for deleted ones.
  const openedRef = useRef(new Set<string>());
  const scrollAnchorsRef = useRef(new Map<string, ScrollAnchor>());
  const sessions = useSessionStoreSelector(selectSessions);
  const sessionsReady = useSessionStoreSelector(selectSessionsReady);

  useEffect(() => {
    if (!enabled || storageLoaded) return;
    let stored: SessionTab[] = [];
    try {
      stored = parseSessionTabs(window.localStorage.getItem(SESSION_TABS_STORAGE_KEY));
    } catch {
      // Storage unavailable: start with only the tabs opened this page load.
    }
    setTabs((current) => mergeStoredSessionTabs(stored, current));
    setStorageLoaded(true);
  }, [enabled, storageLoaded]);

  useEffect(() => {
    if (!enabled || !storageLoaded) return;
    try {
      window.localStorage.setItem(SESSION_TABS_STORAGE_KEY, serializeSessionTabs(tabs));
    } catch {
      // The tabs still work for this page load.
    }
  }, [enabled, storageLoaded, tabs]);

  const selectedId = selectedSession?.id ?? null;
  useEffect(() => {
    if (!enabled || !selectedSession) return;
    openedRef.current.add(selectedSession.id);
    sessionCacheRef.current.set(selectedSession.id, selectedSession);
    const tab = sessionTabFromSession(selectedSession);
    setTabs((current) => upsertSessionTab(current, tab));
  }, [enabled, selectedSession]);

  const hasTabs = tabs.length > 0;
  useEffect(() => {
    // Before the first answer the list is empty, which would read as "every tab was deleted".
    if (!enabled || !storageLoaded || !hasTabs || !sessionsReady) return;
    const tabIds = new Set(tabsRef.current.map((tab) => tab.id));
    for (const session of sessions) {
      if (tabIds.has(session.id)) sessionCacheRef.current.set(session.id, session);
    }
    const keep = new Set(openedRef.current);
    setTabs((current) => reconcileSessionTabs(current, sessions, keep));
  }, [enabled, storageLoaded, hasTabs, sessionsReady, sessions]);

  /** Closes a tab. Returns the tab to show next when the closed one was on screen. */
  const closeTab = useCallback((id: string): SessionTab | null => {
    const result = closeSessionTab(tabsRef.current, id, selectedId);
    setTabs(result.tabs);
    sessionCacheRef.current.delete(id);
    scrollAnchorsRef.current.delete(id);
    openedRef.current.delete(id);
    return result.next;
  }, [selectedId]);

  const removeTab = useCallback((id: string) => {
    setTabs((current) => removeSessionTab(current, id));
    sessionCacheRef.current.delete(id);
    scrollAnchorsRef.current.delete(id);
    openedRef.current.delete(id);
  }, []);

  const renameTabId = useCallback((oldId: string, newId: string) => {
    setTabs((current) => renameSessionTabId(current, oldId, newId));
    const cached = sessionCacheRef.current.get(oldId);
    sessionCacheRef.current.delete(oldId);
    if (cached) sessionCacheRef.current.set(newId, { ...cached, id: newId, path: "" });
    const anchor = scrollAnchorsRef.current.get(oldId);
    scrollAnchorsRef.current.delete(oldId);
    if (anchor) scrollAnchorsRef.current.set(newId, anchor);
    openedRef.current.delete(oldId);
    openedRef.current.add(newId);
  }, []);

  const moveTab = useCallback((id: string, toIndex: number) => setTabs((current) => moveSessionTab(current, id, toIndex)), []);
  const shiftTab = useCallback((id: string, direction: -1 | 1) => setTabs((current) => shiftSessionTab(current, id, direction)), []);

  /** The full session record for a tab: the cache, else the session list. */
  const resolveSession = useCallback(async (id: string): Promise<ResolvedSession> => {
    const cached = sessionCacheRef.current.get(id);
    if (cached) return cached;
    return resolveStoreSession(getSessionStore(), id);
  }, []);

  const getScrollAnchor = useCallback((id: string): ScrollAnchor | null => scrollAnchorsRef.current.get(id) ?? null, []);
  const setScrollAnchor = useCallback((id: string, anchor: ScrollAnchor | null) => {
    rememberScrollAnchor(scrollAnchorsRef.current, id, anchor);
  }, []);

  return { tabs, closeTab, removeTab, renameTabId, moveTab, shiftTab, resolveSession, getScrollAnchor, setScrollAnchor };
}
