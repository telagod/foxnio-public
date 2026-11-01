/**
 * Pure state for the desktop session tab strip above the chat.
 *
 * A tab is a shortcut to a session, not a mounted chat: the app keeps exactly
 * one live ChatWindow (one SSE subscription), and activating a tab selects that
 * session in it. Everything here is free of React and the DOM so the open /
 * close / reorder / persistence rules can be tested directly.
 */

export interface SessionTab {
  id: string;
  /** Resolved display title; empty until the session has a name or first message. */
  title: string;
  cwd: string;
}

/** Where the chat was scrolled, as an anchor that survives remounting the transcript. */
export interface ScrollAnchor {
  /** `data-message-index` of the first message that was in view. */
  messageIndex: number;
  /** Distance in px from the scroller's top edge to that message's top edge (may be negative). */
  offset: number;
}

/** Per-browser list of open session tabs. */
export const SESSION_TABS_STORAGE_KEY = "omp-web:session-tabs";
/** "Show session tabs" preference; tabs are on unless stored as "false". */
export const SESSION_TABS_ENABLED_STORAGE_KEY = "omp-web:session-tabs-enabled";

/** Oldest tab drops when opening a tab would exceed this. */
export const MAX_SESSION_TABS = 24;
const MAX_TITLE_LENGTH = 80;
const MAX_FIELD_LENGTH = 4096;

const NO_MESSAGES = "(no messages)";

/** First-line, control-character-free, whitespace-collapsed title; "" when nothing usable. */
function cleanTitle(value: string | undefined): string {
  if (!value || value === NO_MESSAGES) return "";
  const firstLine = value.split(/\r?\n/)[0] ?? "";
  const stripped = firstLine.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  const characters = Array.from(stripped);
  if (characters.length <= MAX_TITLE_LENGTH) return stripped;
  return `${characters.slice(0, MAX_TITLE_LENGTH).join("").trimEnd()}…`;
}

/** The sidebar's title rule: the session name, else the first message. */
export function sessionTabTitle(session: { name?: string; firstMessage?: string }): string {
  return cleanTitle(session.name) || cleanTitle(session.firstMessage);
}

export function sessionTabFromSession(session: { id: string; cwd: string; name?: string; firstMessage?: string }): SessionTab {
  return { id: session.id, title: sessionTabTitle(session), cwd: session.cwd };
}

/**
 * Adds a tab, or refreshes the existing one in place (position is kept). An
 * empty incoming title never erases a known one: transient client-built
 * sessions carry no name or first message yet.
 */
export function upsertSessionTab(tabs: SessionTab[], tab: SessionTab): SessionTab[] {
  const index = tabs.findIndex((item) => item.id === tab.id);
  if (index >= 0) {
    const current = tabs[index];
    const title = tab.title || current.title;
    const cwd = tab.cwd || current.cwd;
    if (title === current.title && cwd === current.cwd) return tabs;
    const next = tabs.slice();
    next[index] = { ...current, title, cwd };
    return next;
  }
  const next = [...tabs, tab];
  return next.length > MAX_SESSION_TABS ? next.slice(next.length - MAX_SESSION_TABS) : next;
}

export interface CloseSessionTabResult {
  tabs: SessionTab[];
  /**
   * The tab to show when the closed tab was the active one: its right
   * neighbour, else its left. `null` when none is left (or the closed tab was
   * not active), in which case the caller keeps the current view or opens a
   * new chat.
   */
  next: SessionTab | null;
}

export function closeSessionTab(tabs: SessionTab[], id: string, activeId: string | null): CloseSessionTabResult {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return { tabs, next: null };
  const remaining = tabs.filter((tab) => tab.id !== id);
  const next = id === activeId ? (remaining[index] ?? remaining[index - 1] ?? null) : null;
  return { tabs: remaining, next };
}

/** Drops a tab (a deleted session) without choosing a replacement. */
export function removeSessionTab(tabs: SessionTab[], id: string): SessionTab[] {
  return tabs.some((tab) => tab.id === id) ? tabs.filter((tab) => tab.id !== id) : tabs;
}

/** omp moved the conversation to a new session id; the tab follows it in place. */
export function renameSessionTabId(tabs: SessionTab[], oldId: string, newId: string): SessionTab[] {
  if (oldId === newId) return tabs;
  const index = tabs.findIndex((tab) => tab.id === oldId);
  if (index < 0) return tabs;
  // The new id may already have a tab (it was opened first): keep one, at the older position.
  const withoutDuplicate = tabs.filter((tab, i) => i === index || tab.id !== newId);
  return withoutDuplicate.map((tab) => (tab.id === oldId ? { ...tab, id: newId } : tab));
}

/** Moves a tab to `toIndex` (clamped) within the list. */
export function moveSessionTab(tabs: SessionTab[], id: string, toIndex: number): SessionTab[] {
  const from = tabs.findIndex((tab) => tab.id === id);
  if (from < 0) return tabs;
  const to = Math.max(0, Math.min(tabs.length - 1, toIndex));
  if (to === from) return tabs;
  const next = tabs.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Moves a tab one slot left (-1) or right (1). */
export function shiftSessionTab(tabs: SessionTab[], id: string, direction: -1 | 1): SessionTab[] {
  const from = tabs.findIndex((tab) => tab.id === id);
  return from < 0 ? tabs : moveSessionTab(tabs, id, from + direction);
}

/**
 * Applies a fresh session list: titles and cwds follow the sessions, and tabs
 * whose session no longer exists are dropped, except those in `keepIds` (the
 * session on screen, and sessions opened since this page loaded, which may not
 * be flushed to disk yet). Returns the same array when nothing changed.
 */
export function reconcileSessionTabs(
  tabs: SessionTab[],
  sessions: ReadonlyArray<{ id: string; cwd: string; name?: string; firstMessage?: string }>,
  keepIds: ReadonlySet<string>,
): SessionTab[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  let changed = false;
  const next: SessionTab[] = [];
  for (const tab of tabs) {
    const session = byId.get(tab.id);
    if (!session) {
      if (keepIds.has(tab.id)) next.push(tab);
      else changed = true;
      continue;
    }
    const updated = { ...tab, title: sessionTabTitle(session) || tab.title, cwd: session.cwd || tab.cwd };
    if (updated.title !== tab.title || updated.cwd !== tab.cwd) {
      changed = true;
      next.push(updated);
    } else {
      next.push(tab);
    }
  }
  return changed ? next : tabs;
}

/** Stored tabs first (their order wins), then tabs opened before storage was read. */
export function mergeStoredSessionTabs(stored: SessionTab[], current: SessionTab[]): SessionTab[] {
  let merged = stored;
  for (const tab of current) merged = upsertSessionTab(merged, tab);
  return merged;
}

function boundedString(value: unknown): string | null {
  return typeof value === "string" && value.length <= MAX_FIELD_LENGTH ? value : null;
}

/** Validates the stored value; malformed input yields `[]` and bad entries are skipped. */
export function parseSessionTabs(raw: string | null): SessionTab[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const tabs: SessionTab[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const id = boundedString(record.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    tabs.push({ id, title: cleanTitle(boundedString(record.title) ?? undefined), cwd: boundedString(record.cwd) ?? "" });
  }
  return tabs.slice(Math.max(0, tabs.length - MAX_SESSION_TABS));
}

export function serializeSessionTabs(tabs: SessionTab[]): string {
  return JSON.stringify(tabs.map(({ id, title, cwd }) => ({ id, title, cwd })));
}

/**
 * Sessions that probably wait for the user: those with an unread "input"
 * notification (an ask / confirm / select dialog the agent is blocked on).
 * Includes the earlier ids of a moved conversation so its tab still matches.
 */
export function sessionIdsWaitingForInput(
  entries: ReadonlyArray<{ read: boolean; event: { type: string; sessionId: string; aliases?: string[] } }>,
): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.read || entry.event.type !== "input") continue;
    ids.add(entry.event.sessionId);
    for (const alias of entry.event.aliases ?? []) ids.add(alias);
  }
  return ids;
}

/** Within this distance of the bottom the transcript counts as "at the bottom". */
const BOTTOM_THRESHOLD_PX = 96;

/** Whether a scroller sits at (or near) the bottom, where following new content is the default. */
export function isScrolledToBottom(scrollTop: number, clientHeight: number, scrollHeight: number): boolean {
  return scrollTop + clientHeight >= scrollHeight - BOTTOM_THRESHOLD_PX;
}

/** Remembers an anchor for a session; `null` (at the bottom) forgets it. Returns the same map. */
export function rememberScrollAnchor(
  anchors: Map<string, ScrollAnchor>,
  sessionId: string,
  anchor: ScrollAnchor | null,
  limit = MAX_SESSION_TABS * 2,
): Map<string, ScrollAnchor> {
  anchors.delete(sessionId);
  if (anchor) {
    anchors.set(sessionId, anchor);
    // Map iteration is insertion order: the least recently updated goes first.
    while (anchors.size > limit) {
      const oldest = anchors.keys().next();
      if (oldest.done) break;
      anchors.delete(oldest.value);
    }
  }
  return anchors;
}
