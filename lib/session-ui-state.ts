import { readFileSync } from "fs";
import { join } from "path";
import { writeFileAtomic } from "./fs-atomic";
import { getAgentDir } from "./omp/paths";
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

export function sessionUiStatePath(): string {
  return join(getAgentDir(), "omp-web", "session-ui.json");
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

/** A missing, unreadable or corrupt file is an empty state. */
export function loadSessionUiState(): SessionUiState {
  let text: string;
  try {
    text = readFileSync(sessionUiStatePath(), "utf8");
  } catch {
    return { pinned: [] };
  }
  try {
    return parseSessionUiState(JSON.parse(text));
  } catch {
    return { pinned: [] };
  }
}

/**
 * Apply a pin/unpin change and persist it atomically. Synchronous from read to
 * write, so concurrent requests in this process cannot interleave. The file is
 * only rewritten when the pin list actually changes.
 */
export function updateSessionPins(change: PinChange, now: number = Date.now()): SessionUiState {
  const current = loadSessionUiState();
  const removed = new Set(change.unpin ?? []);
  const pinned = current.pinned.filter((entry) => !removed.has(entry.id));
  const present = new Set(pinned.map((entry) => entry.id));
  for (const id of change.pin ?? []) {
    if (present.has(id)) continue;
    present.add(id);
    pinned.unshift({ id, at: now });
  }
  const next: SessionUiState = { pinned: pinned.slice(0, MAX_PINNED_SESSIONS) };
  const unchanged = next.pinned.length === current.pinned.length
    && next.pinned.every((entry, index) => entry.id === current.pinned[index].id && entry.at === current.pinned[index].at);
  if (!unchanged) writeFileAtomic(sessionUiStatePath(), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
