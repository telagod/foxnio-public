import type { NotificationEvent, NotificationHistoryEntry } from "./notification-events";
import { storageRequest } from "./storage/client";

/** Newest first; errors never masquerade as an empty history. */
export function listHistory(): Promise<NotificationHistoryEntry[]> {
  return storageRequest({ operation: "notifications.list" });
}

/** Reused tags replace their occurrence; input settlement shares the same commit. */
export function recordHistory(event: NotificationEvent, options: { at?: number; read?: boolean; settleInputIds?: string[] } = {}): Promise<NotificationHistoryEntry> {
  return storageRequest({ operation: "notifications.record", event, ...options });
}

export function markHistoryRead(ids: string[]): Promise<void> {
  return storageRequest({ operation: "notifications.read", ids });
}

export function removeHistory(id: string): Promise<void> {
  return storageRequest({ operation: "notifications.remove", id });
}

export function clearHistory(): Promise<void> {
  return storageRequest({ operation: "notifications.clear" });
}
