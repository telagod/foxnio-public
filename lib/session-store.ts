import { comparableProjectPath } from "./comparable-path";
import { EVENT_STREAM_CLOSED, openEventStream, reconnectDelayMs } from "./event-stream";
import type { EventStream, EventStreamChannel } from "./event-stream";
import { getDataStore, type DataStore } from "./data-store";
import { mergeCanonicalProjects } from "./project-presentation";
import type { DataSnapshot } from "./storage/protocol";
import {
  loadRecentRuns,
  MAX_RECENT_COMPLETED_RUNS,
  recordCompletedRun,
  removeActiveFromCompleted,
  saveRecentRuns,
  seedRecentRuns,
} from "./recent-runs";
import type { RecentRunEntry } from "./recent-runs";
import { publishSessionsChanged } from "./session-change-bus";
import { isRecord } from "./type-guards";
import type { ExitedRpcSession, ManagedProject, SessionInfo } from "./types";

/** Durable inventory comes from data-store; runtime/navigation state stays local. */

/** A wedged-but-listening server accepts the connection and never answers; without a deadline the list would spin forever. */
export const REQUEST_TIMEOUT_MS = 15_000;
export const PERSIST_DEBOUNCE_MS = 250;
export const UNREAD_SESSIONS_STORAGE_KEY = "omp-web:unread-session-ids";

export type LoadStatus = "loading" | "ready" | "error";

export interface SessionStoreSnapshot {
  readonly sessionsStatus: LoadStatus;
  /** Detail of the last failed list request (not localized); null unless `sessionsStatus` is "error". */
  readonly sessionsError: string | null;
  /** Server order. Unchanged sessions keep their object identity across refreshes. */
  readonly sessions: readonly SessionInfo[];
  readonly projects: readonly ManagedProject[];
  readonly projectsStatus: LoadStatus;
  readonly projectsError: string | null;
  /** Sessions with a run in flight. */
  readonly running: ReadonlySet<string>;
  /** Working directory of live sessions, including the optimistic one. */
  readonly runningCwd: ReadonlyMap<string, string>;
  /** Children that exited unexpectedly, until the session starts again. */
  readonly exited: ReadonlyMap<string, ExitedRpcSession>;
  /** Finished while not being viewed. */
  readonly unread: ReadonlySet<string>;
  /** Finished recently (within the recent-runs limit), whether or not already seen. */
  readonly recentlyCompleted: ReadonlySet<string>;
  /** Newest pin first. */
  readonly pinnedSessionIds: readonly string[];
  /** A session that exists only in memory until its file lands on disk. */
  readonly optimisticSession: SessionInfo | null;
  /** Bumped whenever the corresponding data changes. */
  readonly version: Readonly<{ sessions: number; projects: number; running: number }>;
}

export interface RefreshOptions {
  /** Request current durable data, including all related domains atomically. */
  force?: boolean;
  sessions?: boolean;
  projects?: boolean;
  pins?: boolean;
}

export interface SessionStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): SessionStoreSnapshot;
  /** The empty snapshot every store starts from; stable, for server rendering and hydration. */
  getServerSnapshot(): SessionStoreSnapshot;
  /** Reference-counted: the first retain opens the event channel and window listeners and loads the data; the last release closes them. */
  retain(): void;
  release(): void;
  /** Resolves once a request that started after the call has settled. Never rejects. */
  refresh(options?: RefreshOptions): Promise<void>;
  applyOptimisticSession(session: SessionInfo | null): void;
  /** Clears the optimistic session; when `id` is given, only if it is that session. */
  clearOptimisticSession(id?: string): void;
  /** The session the user is looking at: it never becomes unread and is unmarked when set. */
  setViewedSession(id: string | null): void;
  /** How many recently completed sessions are tracked (clamped to at least 1). */
  setRecentRunsLimit(limit: number): void;
  /** Optimistic; resolves false (after rolling back) when the server refuses. */
  pin(id: string): Promise<boolean>;
  unpin(id: string): Promise<boolean>;
  /** After a delete or archive: drop the session from every list and unpin it. */
  removeSession(id: string): void;
  /** A session of the fetched list (the optimistic one is not included). */
  getSession(id: string): SessionInfo | undefined;
  /** The fetched session, refreshing the list once when it is not there yet; null if it still is not. */
  ensureSession(id: string): Promise<SessionInfo | null>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SessionStoreTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Where the store learns that the user came back, the network returned or the page is going away. */
export interface SessionStoreEnvironment {
  onVisibilityChange(callback: (visible: boolean) => void): () => void;
  onOnline(callback: () => void): () => void;
  onPageHide(callback: () => void): () => void;
}

export interface SessionStoreDeps {
  dataStore: DataStore;
  fetch: FetchLike;
  openStream: (channel: EventStreamChannel) => EventStream;
  /** null disables persistence; omitted uses window.localStorage. */
  storage: Storage | null;
  timers: SessionStoreTimers;
  now: () => number;
  env: SessionStoreEnvironment;
  recentRunsLimit: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function shallowEqualSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function sameMap<V>(a: ReadonlyMap<string, V>, b: ReadonlyMap<string, V>, same: (x: V, y: V) => boolean = Object.is): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (!b.has(key) || !same(value, b.get(key) as V)) return false;
  }
  return true;
}

function sameArray<T>(a: readonly T[], b: readonly T[]): boolean {
  return a === b || (a.length === b.length && a.every((item, index) => item === b[index]));
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && jsonEqual(left[key], right[key]));
}

/** `next` with every item that equals its counterpart in `previous` replaced by that object; `previous` itself when nothing changed. */
function mergeList<T>(previous: readonly T[], next: readonly T[], previousByKey: ReadonlyMap<string, T>, keyOf: (item: T) => string): readonly T[] {
  let identical = previous.length === next.length;
  const merged = next.map((item, index) => {
    const old = previousByKey.get(keyOf(item));
    const kept = old !== undefined && jsonEqual(old, item) ? old : item;
    if (identical && kept !== previous[index]) identical = false;
    return kept;
  });
  return identical ? previous : merged;
}

const sessionIndexCache = new WeakMap<readonly SessionInfo[], Map<string, SessionInfo>>();

function sessionIndex(sessions: readonly SessionInfo[]): ReadonlyMap<string, SessionInfo> {
  let index = sessionIndexCache.get(sessions);
  if (!index) {
    index = new Map(sessions.map((session) => [session.id, session]));
    sessionIndexCache.set(sessions, index);
  }
  return index;
}

/** The fetched session with this id; the optimistic session is a separate field of the snapshot. */
export function selectSession(snapshot: SessionStoreSnapshot, id: string): SessionInfo | undefined {
  return sessionIndex(snapshot.sessions).get(id);
}

/** The last selection made for a hook: reused while the snapshot and selector are unchanged, and replaced by the previous value when the new one is equal. */
export interface SelectionCache<T> {
  snapshot: SessionStoreSnapshot;
  selector: (snapshot: SessionStoreSnapshot) => T;
  value: T;
}

/**
 * useSyncExternalStore needs a referentially stable result; a selector that
 * builds a new object or array on every call would loop forever. Returning the
 * previous value whenever `isEqual` holds also keeps the component from
 * re-rendering for changes outside its slice.
 */
export function selectWithCache<T>(
  cache: { current: SelectionCache<T> | null },
  snapshot: SessionStoreSnapshot,
  selector: (snapshot: SessionStoreSnapshot) => T,
  isEqual: (a: T, b: T) => boolean,
): T {
  const previous = cache.current;
  if (previous && previous.snapshot === snapshot && previous.selector === selector) return previous.value;
  const next = selector(snapshot);
  const value = previous && isEqual(previous.value, next) ? previous.value : next;
  cache.current = { snapshot, selector, value };
  return value;
}

const modifiedMsCache = new WeakMap<SessionInfo, number>();

function modifiedMs(session: SessionInfo): number | undefined {
  let ms = modifiedMsCache.get(session);
  if (ms === undefined) {
    ms = new Date(session.modified).getTime();
    modifiedMsCache.set(session, ms);
  }
  return Number.isNaN(ms) ? undefined : ms;
}

/** Sessions that have content; empty drafts never count as a recent run. */
function hasContent(session: SessionInfo): boolean {
  return Boolean((session.firstMessage && session.firstMessage !== "(no messages)") || session.messageCount > 0 || session.name);
}

/**
 * The `limit` most recently active sessions that are not running: the live and
 * persisted completed runs, backfilled with sessions on disk by modification
 * time. Ties keep first-seen order. Runs in O(n log limit) without sorting n.
 */
export function computeRecentlyCompleted(
  runs: readonly RecentRunEntry[],
  sessions: readonly SessionInfo[],
  running: ReadonlySet<string>,
  limit: number,
): Set<string> {
  if (limit < 1) return new Set();
  const latest = new Map<string, number>();
  for (const run of runs) if (!running.has(run.sessionId)) latest.set(run.sessionId, run.completedAt);
  for (const session of sessions) {
    if (running.has(session.id) || !hasContent(session)) continue;
    const ms = modifiedMs(session);
    if (ms === undefined) continue;
    const known = latest.get(session.id);
    if (known === undefined || ms > known) latest.set(session.id, ms);
  }
  const top: Array<[string, number]> = [];
  for (const entry of latest) {
    if (top.length === limit && entry[1] <= top[top.length - 1][1]) continue;
    let low = 0;
    let high = top.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (top[mid][1] >= entry[1]) low = mid + 1;
      else high = mid;
    }
    top.splice(low, 0, entry);
    if (top.length > limit) top.pop();
  }
  return new Set(top.map(([id]) => id));
}


function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseCwdList(value: unknown): Array<{ id: string; cwd: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const entries: Array<{ id: string; cwd: string }> = [];
  for (const item of value) {
    if (isRecord(item) && typeof item.id === "string" && typeof item.cwd === "string" && item.id && item.cwd) {
      entries.push({ id: item.id, cwd: item.cwd });
    }
  }
  return entries;
}

function parseExitedList(value: unknown): ExitedRpcSession[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ExitedRpcSession => isRecord(item) && typeof item.id === "string");
}

function parsePinnedIds(data: unknown): string[] {
  if (!isRecord(data) || !Array.isArray(data.pinned)) throw new Error("Invalid pinned sessions response");
  const ids: string[] = [];
  for (const entry of data.pinned) {
    if (isRecord(entry) && typeof entry.id === "string") ids.push(entry.id);
  }
  return ids;
}

function loadUnreadSessionIds(storage: Storage): Set<string> {
  try {
    const raw = storage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return new Set(stringList(parsed));
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(storage: Storage, ids: ReadonlySet<string>): void {
  try {
    if (ids.size === 0) storage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else storage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // quota exceeded or private browsing
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function browserEnvironment(): SessionStoreEnvironment {
  const listen = (target: "document" | "window", type: string, callback: () => void): (() => void) => {
    const host: EventTarget | undefined = target === "document"
      ? (typeof document === "undefined" ? undefined : document)
      : (typeof window === "undefined" ? undefined : window);
    if (!host) return () => {};
    host.addEventListener(type, callback);
    return () => host.removeEventListener(type, callback);
  };
  return {
    onVisibilityChange: (callback) => listen("document", "visibilitychange", () => callback(document.visibilityState === "visible")),
    onOnline: (callback) => listen("window", "online", callback),
    onPageHide: (callback) => listen("window", "pagehide", callback),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type State = { -readonly [K in keyof Omit<SessionStoreSnapshot, "version">]: SessionStoreSnapshot[K] };

const NO_SESSIONS: readonly SessionInfo[] = Object.freeze([]);
const NO_PROJECTS: readonly ManagedProject[] = Object.freeze([]);
const NO_IDS: readonly string[] = Object.freeze([]);
const EMPTY_SET: ReadonlySet<string> = new Set();
const NO_CWDS: ReadonlyMap<string, string> = new Map();
const NO_EXITED: ReadonlyMap<string, ExitedRpcSession> = new Map();

const SERVER_SNAPSHOT: SessionStoreSnapshot = Object.freeze({
  sessionsStatus: "loading",
  sessionsError: null,
  sessions: NO_SESSIONS,
  projects: NO_PROJECTS,
  projectsStatus: "loading",
  projectsError: null,
  running: EMPTY_SET,
  runningCwd: NO_CWDS,
  exited: NO_EXITED,
  unread: EMPTY_SET,
  recentlyCompleted: EMPTY_SET,
  pinnedSessionIds: NO_IDS,
  optimisticSession: null,
  version: Object.freeze({ sessions: 0, projects: 0, running: 0 }),
});

export function createSessionStore(overrides: Partial<SessionStoreDeps> = {}): SessionStore {
  const deps: Omit<SessionStoreDeps, "storage"> = {
    dataStore: overrides.dataStore ?? getDataStore(),
    fetch: overrides.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    openStream: overrides.openStream ?? openEventStream,
    timers: overrides.timers ?? {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
    now: overrides.now ?? Date.now,
    env: overrides.env ?? browserEnvironment(),
    recentRunsLimit: overrides.recentRunsLimit ?? MAX_RECENT_COMPLETED_RUNS,
  };
  const { timers } = deps;

  const s: State = {
    sessionsStatus: "loading",
    sessionsError: null,
    sessions: NO_SESSIONS,
    projects: NO_PROJECTS,
    projectsStatus: "loading",
    projectsError: null,
    running: EMPTY_SET,
    runningCwd: NO_CWDS,
    exited: NO_EXITED,
    unread: EMPTY_SET,
    recentlyCompleted: EMPTY_SET,
    pinnedSessionIds: NO_IDS,
    optimisticSession: null,
  };
  let snapshot: SessionStoreSnapshot = SERVER_SNAPSHOT;
  const listeners = new Set<() => void>();
  let appliedData: DataSnapshot["data"] | undefined;
  let appliedPins: DataSnapshot["data"] | undefined;

  let frameCwds: ReadonlyMap<string, string> = NO_CWDS;
  /** Last known cwd per live session: a placeholder row needs it before the file exists. */
  const knownCwds = new Map<string, string>();

  // Tracking.
  let viewedSessionId: string | null = null;
  let recentRuns: RecentRunEntry[] = [];
  let recentLimit = Math.max(1, Math.floor(deps.recentRunsLimit));
  let recentInputs: { sessions: readonly SessionInfo[]; running: ReadonlySet<string>; runs: readonly RecentRunEntry[]; limit: number } | null = null;

  // Persistence.
  let storage: Storage | null = null;
  let hydrated = false;
  let unreadDirty = false;
  let recentDirty = false;
  let persistTimer: unknown;

  // Pins.
  let pinMutations = 0;
  let pendingPinOps = 0;
  const pinOpSeq = new Map<string, number>();
  let pinQueue: Promise<unknown> = Promise.resolve();

  // Lifecycle.
  let retainCount = 0;
  const removers: Array<() => void> = [];
  let stream: EventStream | null = null;
  let streamFailures = 0;
  let reconnectTimer: unknown;

  // ---- publishing ----------------------------------------------------------

  function deriveRecentlyCompleted(): void {
    const inputs = recentInputs;
    if (inputs && inputs.sessions === s.sessions && inputs.running === s.running && inputs.runs === recentRuns && inputs.limit === recentLimit) return;
    recentInputs = { sessions: s.sessions, running: s.running, runs: recentRuns, limit: recentLimit };
    const next = computeRecentlyCompleted(recentRuns, s.sessions, s.running, recentLimit);
    if (!shallowEqualSet(next, s.recentlyCompleted)) s.recentlyCompleted = next;
  }

  function deriveRunningCwd(): void {
    const next = new Map<string, string>();
    for (const id of s.running) {
      const cwd = frameCwds.get(id) ?? knownCwds.get(id);
      if (cwd) next.set(id, cwd);
    }
    const optimistic = s.optimisticSession;
    if (optimistic?.cwd) next.set(optimistic.id, optimistic.cwd);
    if (!sameMap(next, s.runningCwd)) s.runningCwd = next;
  }

  /** Publish the working state if anything changed. Every field keeps its identity when its contents are equal, so a field-by-field identity check is the equality check. */
  function emit(): void {
    deriveRecentlyCompleted();
    deriveRunningCwd();
    const keys = Object.keys(s) as Array<keyof State>;
    if (keys.every((key) => s[key] === snapshot[key as keyof SessionStoreSnapshot])) return;
    const previous = snapshot;
    const runningChanged = s.running !== previous.running || s.runningCwd !== previous.runningCwd || s.exited !== previous.exited;
    snapshot = Object.freeze({
      ...s,
      version: Object.freeze({
        sessions: previous.version.sessions + (s.sessions !== previous.sessions ? 1 : 0),
        projects: previous.version.projects + (s.projects !== previous.projects ? 1 : 0),
        running: previous.version.running + (runningChanged ? 1 : 0),
      }),
    });
    for (const listener of [...listeners]) listener();
  }

  // ---- persistence ---------------------------------------------------------

  /** Load the browser-local state on first use, never at construction: the server render has none of it. */
  function hydrate(): void {
    if (hydrated) return;
    hydrated = true;
    storage = "storage" in overrides ? (overrides.storage ?? null) : browserStorage();
    if (!storage) return;
    const unread = loadUnreadSessionIds(storage);
    if (unread.size > 0) s.unread = unread;
    recentRuns = loadRecentRuns(storage);
  }

  function flushPersist(): void {
    if (persistTimer !== undefined) {
      timers.clearTimeout(persistTimer);
      persistTimer = undefined;
    }
    if (storage) {
      if (unreadDirty) saveUnreadSessionIds(storage, s.unread);
      if (recentDirty) saveRecentRuns(recentRuns, storage, recentLimit);
    }
    unreadDirty = false;
    recentDirty = false;
  }

  function schedulePersist(): void {
    if (retainCount === 0) {
      flushPersist();
      return;
    }
    persistTimer ??= timers.setTimeout(flushPersist, PERSIST_DEBOUNCE_MS);
  }

  function setUnread(next: Set<string>): void {
    if (shallowEqualSet(next, s.unread)) return;
    s.unread = next;
    unreadDirty = true;
    schedulePersist();
  }

  function setRecentRuns(next: RecentRunEntry[]): void {
    recentRuns = next;
    recentDirty = true;
    schedulePersist();
  }

  // ---- requests ------------------------------------------------------------

  /** Commands retain their deadline even when their originating view unmounts. */
  async function request<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timeout = timers.setTimeout(() => controller.abort(new DOMException("Request timed out", "TimeoutError")), REQUEST_TIMEOUT_MS);
    try {
      return await run(controller.signal);
    } finally {
      timers.clearTimeout(timeout);
    }
  }

  function applyDurable(): void {
    const durable = deps.dataStore.getSnapshot();
    const data = durable.snapshot?.data;
    if (data && data !== appliedData) {
      appliedData = data;
      applySessions(data.sessions);
      const foxRoot = comparableProjectPath(data.foxWorkspace);
      const projects = mergeCanonicalProjects({ version: 1, projects: data.projects }, data.sessions.map((session) => session.projectRoot ?? session.cwd))
        .filter((project) => comparableProjectPath(project.path) !== foxRoot);
      s.projects = mergeList(s.projects, projects, new Map(s.projects.map((project) => [project.path, project])), (project) => project.path);
    }
    if (data && data !== appliedPins && pendingPinOps === 0) {
      appliedPins = data;
      setPinned(data.pins.map((pin) => pin.id));
    }
    s.sessionsStatus = durable.status;
    s.sessionsError = durable.error;
    s.projectsStatus = durable.status;
    s.projectsError = durable.error;
    emit();
  }

  // ---- data ----------------------------------------------------------------

  function rememberCwds(entries: ReadonlyArray<{ id: string; cwd: string }> | undefined): void {
    if (entries) for (const entry of entries) knownCwds.set(entry.id, entry.cwd);
  }

  function pruneKnownCwds(): void {
    if (knownCwds.size <= s.running.size + 1) return;
    const index = sessionIndex(s.sessions);
    for (const id of [...knownCwds.keys()]) {
      if (!s.running.has(id) && s.optimisticSession?.id !== id && index.has(id)) knownCwds.delete(id);
    }
  }

  function applySessions(list: SessionInfo[]): void {
    const merged = mergeList(s.sessions, list, sessionIndex(s.sessions), (session) => session.id);
    if (merged === s.sessions) return;
    s.sessions = merged;
    onSessionsChanged();
  }

  /** Everything derived from the list that has to follow a change of it. */
  function onSessionsChanged(): void {
    hydrate();
    // Unread markers of sessions that no longer exist (deleted elsewhere) would linger forever.
    if (s.unread.size > 0) {
      const index = sessionIndex(s.sessions);
      setUnread(new Set([...s.unread].filter((id) => index.has(id))));
    }
    reseedRecentRuns();
    pruneKnownCwds();
  }


  /** Persisted recents are re-seeded from disk when a session was active after the newest recorded run. */
  function reseedRecentRuns(): void {
    let newestOnDisk = 0;
    for (const session of s.sessions) {
      if (!hasContent(session)) continue;
      const ms = modifiedMs(session);
      if (ms !== undefined && ms > newestOnDisk) newestOnDisk = ms;
    }
    if (newestOnDisk === 0) return;
    const newestRecorded = recentRuns.reduce((newest, run) => Math.max(newest, run.completedAt), 0);
    if (recentRuns.length === 0 || newestOnDisk > newestRecorded) setRecentRuns(seedRecentRuns([...s.sessions], recentLimit));
  }


  interface RunningUpdate {
    ids: readonly string[];
    cwds?: ReadonlyArray<{ id: string; cwd: string }>;
    exited?: readonly ExitedRpcSession[];
  }

  /** Applies running state; returns the ids whose run started or finished (empty when the running set is unchanged). */
  function applyRunning(update: RunningUpdate): string[] {
    const previous = s.running;
    const next = new Set(update.ids);
    if (!shallowEqualSet(previous, next)) s.running = next;
    if (update.cwds) {
      const cwds = new Map(update.cwds.map((entry) => [entry.id, entry.cwd]));
      if (!sameMap(cwds, frameCwds)) frameCwds = cwds;
    }
    if (update.exited) {
      const exited = new Map<string, ExitedRpcSession>();
      for (const session of update.exited) {
        const old = s.exited.get(session.id);
        exited.set(session.id, old && jsonEqual(old, session) ? old : session);
      }
      if (!sameMap(exited, s.exited)) s.exited = exited;
    }
    const transitioned = s.running !== previous ? trackTransitions(previous, next) : [];
    pruneKnownCwds();
    return transitioned;
  }

  function trackTransitions(previous: ReadonlySet<string>, next: Set<string>): string[] {
    const completed = [...previous].filter((id) => !next.has(id));
    const started = [...next].filter((id) => !previous.has(id));
    if (completed.length === 0 && started.length === 0) return [];
    hydrate();

    let runs = recentRuns;
    if (started.length > 0) runs = removeActiveFromCompleted(runs, next);
    const now = deps.now();
    for (const id of completed) runs = recordCompletedRun(runs, id, now, recentLimit);
    setRecentRuns(runs);

    const background = completed.filter((id) => id !== viewedSessionId);
    if (background.length > 0 || started.length > 0) {
      const unread = new Set(s.unread);
      for (const id of started) unread.delete(id);
      for (const id of background) unread.add(id);
      setUnread(unread);
    }
    return [...completed, ...started];
  }

  function handleFrame(raw: string): void {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(data)) return;
    if (data.type === "running") {
      const cwds = parseCwdList(data.runningSessions);
      rememberCwds(cwds);
      applyRunning({ ids: stringList(data.runningSessionIds), cwds, exited: parseExitedList(data.exitedSessions) });
      emit();
    } else if (data.type === "sessions-changed") {
      const ids = stringList(data.sessionIds);
      publishSessionsChanged(ids);
    }
  }

  // ---- pins ----------------------------------------------------------------

  function setPinned(ids: readonly string[]): void {
    if (!sameArray(ids, s.pinnedSessionIds)) s.pinnedSessionIds = [...ids];
  }

  function sendPin(body: { pin: string[] } | { unpin: string[] }): Promise<string[]> {
    const task = pinQueue.then(() => request(async (signal) => {
      const res = await deps.fetch("/api/session-ui", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parsePinnedIds(await res.json());
    }));
    // Writes reach the server one at a time and in order, so the last answer is the final state.
    pinQueue = task.catch(() => {});
    return task;
  }

  function mutatePin(id: string, kind: "pin" | "unpin", rollback: boolean): Promise<boolean> {
    const before = s.pinnedSessionIds;
    const index = before.indexOf(id);
    if ((kind === "pin") === (index !== -1)) return Promise.resolve(true);
    const seq = ++pinMutations;
    pinOpSeq.set(id, seq);
    s.pinnedSessionIds = kind === "pin" ? [id, ...before] : before.filter((pinned) => pinned !== id);
    emit();
    pendingPinOps += 1;
    return sendPin(kind === "pin" ? { pin: [id] } : { unpin: [id] }).then(
      (serverIds) => {
        pendingPinOps -= 1;
        if (pinOpSeq.get(id) === seq) pinOpSeq.delete(id);
        if (pendingPinOps === 0) {
          appliedPins = deps.dataStore.getSnapshot().snapshot?.data;
          setPinned(serverIds);
          emit();
        }
        if (pendingPinOps === 0) void deps.dataStore.refresh();
        return true;
      },
      () => {
        pendingPinOps -= 1;
        // A newer operation on the same session has already superseded this one.
        if (pinOpSeq.get(id) !== seq) return false;
        pinOpSeq.delete(id);
        if (rollback) {
          const current = s.pinnedSessionIds.filter((pinned) => pinned !== id);
          if (kind === "unpin") current.splice(Math.min(index, current.length), 0, id);
          setPinned(current);
          emit();
        }
        if (pendingPinOps === 0) void deps.dataStore.refresh();
        return false;
      },
    );
  }

  // ---- lifecycle -----------------------------------------------------------


  function scheduleReconnect(): void {
    reconnectTimer = timers.setTimeout(connect, reconnectDelayMs(streamFailures));
    streamFailures += 1;
  }

  function connect(): void {
    reconnectTimer = undefined;
    let opened: EventStream;
    try {
      opened = deps.openStream({ kind: "running" });
    } catch {
      scheduleReconnect();
      return;
    }
    stream = opened;
    opened.onopen = () => {
      streamFailures = 0;
    };
    opened.onmessage = (event) => {
      if (stream === opened) handleFrame(event.data);
    };
    opened.onerror = () => {
      if (stream !== opened) return;
      if (opened.readyState !== EVENT_STREAM_CLOSED) return;
      stream = null;
      scheduleReconnect();
    };
  }


  function start(): void {
    hydrate();
    removers.push(
      deps.env.onVisibilityChange((visible) => { if (!visible) flushPersist(); }),
      deps.env.onPageHide(flushPersist),
    );
    connect();
    removers.push(deps.dataStore.subscribe(applyDurable));
    deps.dataStore.retain();
    applyDurable();
  }

  function stop(): void {
    for (const remove of removers.splice(0)) remove();
    stream?.close();
    stream = null;
    if (reconnectTimer !== undefined) timers.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    deps.dataStore.release();
    streamFailures = 0;
    flushPersist();
  }

  // ---- public API ----------------------------------------------------------

  const store: SessionStore = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => SERVER_SNAPSHOT,

    retain() {
      retainCount += 1;
      if (retainCount === 1) start();
    },
    release() {
      if (retainCount === 0) return;
      retainCount -= 1;
      if (retainCount === 0) stop();
    },

    async refresh() {
      await deps.dataStore.refresh();
      applyDurable();
    },

    applyOptimisticSession(session) {
      if (session?.cwd) knownCwds.set(session.id, session.cwd);
      s.optimisticSession = session;
      emit();
    },
    clearOptimisticSession(id) {
      if (id !== undefined && s.optimisticSession?.id !== id) return;
      s.optimisticSession = null;
      emit();
    },

    setViewedSession(id) {
      viewedSessionId = id;
      if (id !== null && s.unread.has(id)) {
        hydrate();
        const unread = new Set(s.unread);
        unread.delete(id);
        setUnread(unread);
        emit();
      }
    },

    setRecentRunsLimit(limit) {
      const next = Math.max(1, Math.floor(limit));
      if (next === recentLimit) return;
      hydrate();
      recentLimit = next;
      recentDirty = true;
      schedulePersist();
      emit();
    },

    pin: (id) => mutatePin(id, "pin", true),
    unpin: (id) => mutatePin(id, "unpin", true),

    removeSession(id) {
      hydrate();
      knownCwds.delete(id);
      if (sessionIndex(s.sessions).has(id)) s.sessions = s.sessions.filter((session) => session.id !== id);
      if (s.unread.has(id)) {
        const unread = new Set(s.unread);
        unread.delete(id);
        setUnread(unread);
      }
      if (recentRuns.some((run) => run.sessionId === id)) setRecentRuns(recentRuns.filter((run) => run.sessionId !== id));
      if (s.exited.has(id)) {
        const exited = new Map(s.exited);
        exited.delete(id);
        s.exited = exited;
      }
      if (s.optimisticSession?.id === id) s.optimisticSession = null;
      // A pin of a deleted session is dead weight: the answer is not awaited and a failure is not rolled back.
      if (s.pinnedSessionIds.includes(id)) void mutatePin(id, "unpin", false);
      else emit();
    },

    getSession: (id) => selectSession(snapshot, id),

    async ensureSession(id) {
      const known = selectSession(snapshot, id);
      if (known) return known;
      await store.refresh();
      return selectSession(snapshot, id) ?? null;
    },
  };
  return store;
}
