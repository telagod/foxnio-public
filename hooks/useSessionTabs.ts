"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionInfo } from "@/lib/types";
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

/** Coalesces the bursts of list-change hints (agent_start + title update + file signal). */
const LIST_REFRESH_DEBOUNCE_MS = 400;

export type ResolvedSession = SessionInfo | null | "unavailable";

/**
 * Open session tabs for the desktop tab strip. The selected session is always
 * a tab; the list persists per browser and is reconciled with the session list
 * so titles stay current and deleted or archived sessions fall away.
 *
 * `refreshToken` is any value that changes when the session list may have
 * changed (the shell's refresh key, the running channel's list hint).
 */
export function useSessionTabs({ enabled, selectedSession, refreshToken }: {
  enabled: boolean;
  selectedSession: SessionInfo | null;
  refreshToken: number;
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
  const sessionsEtagRef = useRef<string | null>(null);

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
    if (!enabled || !storageLoaded || !hasTabs) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const headers: Record<string, string> = {};
      if (sessionsEtagRef.current) headers["If-None-Match"] = sessionsEtagRef.current;
      fetch("/api/sessions", { headers, signal: controller.signal })
        .then(async (response) => {
          if (response.status === 304 || !response.ok) return;
          const data = (await response.json()) as { sessions?: SessionInfo[] };
          if (!data.sessions) return;
          sessionsEtagRef.current = response.headers.get("ETag");
          const keep = new Set(openedRef.current);
          const tabIds = new Set(tabsRef.current.map((tab) => tab.id));
          for (const session of data.sessions) {
            if (tabIds.has(session.id)) sessionCacheRef.current.set(session.id, session);
          }
          const sessions = data.sessions;
          setTabs((current) => reconcileSessionTabs(current, sessions, keep));
        })
        .catch(() => {
          // Aborted or offline: the next change hint tries again.
        });
    }, LIST_REFRESH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, storageLoaded, hasTabs, refreshToken]);

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
    try {
      const response = await fetch("/api/sessions");
      if (!response.ok) return "unavailable";
      const data = (await response.json()) as { sessions?: SessionInfo[] };
      return data.sessions?.find((session) => session.id === id) ?? null;
    } catch {
      return "unavailable";
    }
  }, []);

  const getScrollAnchor = useCallback((id: string): ScrollAnchor | null => scrollAnchorsRef.current.get(id) ?? null, []);
  const setScrollAnchor = useCallback((id: string, anchor: ScrollAnchor | null) => {
    rememberScrollAnchor(scrollAnchorsRef.current, id, anchor);
  }, []);

  return { tabs, closeTab, removeTab, renameTabId, moveTab, shiftTab, resolveSession, getScrollAnchor, setScrollAnchor };
}
