import { storageRequest } from "./storage/client";
import { isValidSessionId } from "./session-file-references-core";
import { isRecord } from "./type-guards";

/**
 * Server-side, per-install UI state of the session list that must follow the
 * user across browsers and devices (the browser-local state lives in
 * lib/sidebar-ui-state.ts). Today that is the set of pinned sessions.
 */

/** Oldest pins are dropped beyond this many. */
export const MAX_PINNED_SESSIONS = 200;

export interface PinnedSession {
  id: string;
  /** Epoch milliseconds of the pin. */
  at: number;
}

export interface SessionUiState {
  /** Newest pin first. */
  pinned: PinnedSession[];
}

export interface PinChange {
  /** Ids to pin. An id that is already pinned keeps its position. */
  pin?: readonly string[];
  /** Ids to unpin; applied before `pin`. */
  unpin?: readonly string[];
}


/** Anything that is not a well-formed state (bad ids, duplicates, junk) is dropped, never thrown. */
export function parseSessionUiState(raw: unknown): SessionUiState {
  if (!isRecord(raw) || !Array.isArray(raw.pinned)) return { pinned: [] };
  const seen = new Set<string>();
  const pinned: PinnedSession[] = [];
  for (const entry of raw.pinned) {
    if (!isRecord(entry) || typeof entry.id !== "string" || !isValidSessionId(entry.id)) continue;
    if (typeof entry.at !== "number" || !Number.isFinite(entry.at) || seen.has(entry.id)) continue;
    seen.add(entry.id);
    pinned.push({ id: entry.id, at: entry.at });
  }
  // Stable: pins sharing a timestamp keep their stored order.
  pinned.sort((a, b) => b.at - a.at);
  return { pinned: pinned.slice(0, MAX_PINNED_SESSIONS) };
}

export function loadSessionUiState(): Promise<SessionUiState> {
  return storageRequest({ operation: "pins.get" });
}

/** Transactional command: untouched pins and their timestamps remain intact. */
export function updateSessionPins(change: PinChange, now: number = Date.now()): Promise<SessionUiState> {
  return storageRequest({ operation: "pins.patch", pin: change.pin ? [...change.pin] : undefined, unpin: change.unpin ? [...change.unpin] : undefined, now });
}
