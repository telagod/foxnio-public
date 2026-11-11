import { useSyncExternalStore } from "react";
import { getDataStore, type DataStore } from "./data-store";
import type { NotificationHistoryEntry } from "./notification-events";
import type { DataSnapshot } from "./storage/protocol";

interface HistoryMutation {
  apply(entries: NotificationHistoryEntry[]): NotificationHistoryEntry[];
  committedAfter?: DataSnapshot | null;
  awaitingRefresh?: boolean;
}
export interface NotificationHistory {
  subscribe(listener: () => void): () => void;
  get(): NotificationHistoryEntry[];
  load(): Promise<void>;
  markRead(id: string): void;
  markAllRead(): void;
  markSessionInputRead(sessionId: string): void;
  remove(id: string): void;
  clear(): void;
}

/** History is durable. Only pending user commands are overlaid locally. */
export function createNotificationHistory({ dataStore, fetch: request }: {
  dataStore: DataStore;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}): NotificationHistory {
  let entries: NotificationHistoryEntry[] = [];
  let base: NotificationHistoryEntry[] = [];
  let unsubscribe: (() => void) | undefined;
  let queue: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const pending = new Set<HistoryMutation>();

  function reconcile(): void {
    const snapshot = dataStore.getSnapshot().snapshot;
    if (snapshot) base = snapshot.data.notifications;
    for (const mutation of pending) {
      if (!mutation.awaitingRefresh && "committedAfter" in mutation && snapshot && snapshot !== mutation.committedAfter) pending.delete(mutation);
    }
    let next = base;
    for (const mutation of pending) next = mutation.apply(next);
    if (entries === next || JSON.stringify(entries) === JSON.stringify(next)) return;
    entries = next;
    for (const listener of listeners) listener();
  }
  function send(query: string, init: RequestInit, apply: HistoryMutation["apply"]): void {
    const mutation: HistoryMutation = { apply };
    pending.add(mutation);
    reconcile();
    queue = queue.then(async () => {
      try {
        const response = await request(`/api/notifications/history${query}`, { ...init, signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        mutation.committedAfter = dataStore.getSnapshot().snapshot;
        mutation.awaitingRefresh = true;
        await dataStore.refresh();
        mutation.awaitingRefresh = false;
        if (dataStore.getSnapshot().status === "ready") pending.delete(mutation);
      } catch {
        pending.delete(mutation);
        reconcile();
        await dataStore.refresh();
      } finally { reconcile(); }
    });
  }
  function mark(ids: string[]): void {
    send("", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) },
      (list) => list.map((entry) => ids.includes(entry.id) && !entry.read ? { ...entry, read: true } : entry));
  }
  return {
    subscribe(listener) {
      listeners.add(listener);
      if (!unsubscribe) {
        unsubscribe = dataStore.subscribe(reconcile);
        dataStore.retain();
        reconcile();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && unsubscribe) { unsubscribe(); unsubscribe = undefined; dataStore.release(); }
      };
    },
    get: () => entries,
    async load() { await dataStore.refresh(); reconcile(); },
    markRead(id) { if (entries.some((entry) => entry.id === id && !entry.read)) mark([id]); },
    markAllRead() { const ids = entries.filter((entry) => !entry.read).map((entry) => entry.id); if (ids.length) mark(ids); },
    // Reading a history marker never dismisses an actual pending RPC dialog.
    markSessionInputRead(sessionId) { mark([`${sessionId}:input`]); },
    remove(id) { send(`?id=${encodeURIComponent(id)}`, { method: "DELETE" }, (list) => list.filter((entry) => entry.id !== id)); },
    clear() { const ids = new Set(entries.map((entry) => entry.id)); send("?all=1", { method: "DELETE" }, (list) => list.filter((entry) => !ids.has(entry.id))); },
  };
}
export const notificationHistory = createNotificationHistory({ dataStore: getDataStore(), fetch: (url, init) => fetch(url, init) });
export function useNotificationHistory(): NotificationHistoryEntry[] {
  return useSyncExternalStore(notificationHistory.subscribe, notificationHistory.get, notificationHistory.get);
}
const unreadCount = () => notificationHistory.get().reduce((count, entry) => count + (entry.read ? 0 : 1), 0);
export function useUnreadNotificationCount(): number {
  return useSyncExternalStore(notificationHistory.subscribe, unreadCount, unreadCount);
}
