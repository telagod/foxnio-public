import { existsSync } from "fs";
import { normalize as normalizePath } from "path";
import { getAgentDir } from "./omp/paths";
import {
  invalidateAllSessionScanCaches,
  invalidateSessionFileListCache,
  invalidateSessionScanCache,
  listAllSessionInfos,
  readSessionHeaderSync,
  scanSessionInfo,
  type OmpSessionInfo,
  type ResolveBlobOptions,
} from "./omp/session-files";
import type {
  SessionHeader,
  SessionInfo,
} from "./types";
import { requestSessionHistory, invalidateSessionHistory } from "./session-history-queue";
export { SessionFileTooLargeError, SessionHistoryWorkerError } from "./session-history-errors";
export { buildSessionContext, getTodoPhasesFromEntries, entryToUiMessage } from "./session-context";
import { projectIdentityKey, sessionPathKey } from "./paths";
import { resolveProject, type ProjectInfo } from "./worktree";
import type { SessionHistoryCursor } from "./session-sync";

export { getAgentDir };

/** How a session header's `parentSession` is turned into a parent session id. */
interface ParentIndex {
  idForPath(path: string): string | undefined;
  hasId(id: string): boolean;
}

/**
 * `header.parentSession` has two forms in omp: a session FILE PATH (branch /
 * createBranchedSession, the RPC path omp-web drives) and a bare SESSION ID
 * (SessionManager.fork, reached from the TUI /fork, `omp --fork` and /tan).
 * Resolve the path form first, then fall back to an id match, so TUI-forked
 * sessions are not rendered as unrelated roots.
 */
function matchParentSessionId(parentSession: string, parents: ParentIndex): string | undefined {
  return parents.idForPath(parentSession) ?? (parents.hasId(parentSession) ? parentSession : undefined);
}

/** The one place an on-disk scan becomes a list entry, shared by the full list and the by-id lookup. */
function toSessionInfo(s: OmpSessionInfo, project: ProjectInfo | undefined, parents: ParentIndex): SessionInfo {
  return {
    path: s.path,
    id: s.id,
    cwd: s.cwd,
    // omp renamed the display field to `title`; the internal shape keeps `name`.
    name: s.title,
    created: s.created instanceof Date && !Number.isNaN(s.created.getTime())
      ? s.created.toISOString()
      : s.modified.toISOString(),
    modified: s.modified.toISOString(),
    ...(s.lastMessageAt ? { lastMessageAt: s.lastMessageAt.toISOString() } : {}),
    messageCount: s.messageCount,
    firstMessage: s.firstMessage || "(no messages)",
    parentSessionId: s.parentSessionPath ? matchParentSessionId(s.parentSessionPath, parents) : undefined,
    projectRoot: project?.projectRoot ?? s.cwd,
    projectKey: projectIdentityKey(project?.projectRoot ?? s.cwd),
    ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
  };
}

/** Resolve each unique cwd to its project root (main repo shared by all
 *  worktrees). resolveProject caches per-cwd, so this is cheap after warmup.
 *  Bound concurrency so 100+ unique cwds don't spawn 100 parallel git processes. */
async function resolveProjectsByCwd(ompSessions: readonly OmpSessionInfo[]): Promise<Map<string, ProjectInfo>> {
  const uniqueCwds = [...new Set(ompSessions.map((s) => s.cwd).filter(Boolean))];
  const projectByCwd = new Map<string, ProjectInfo>();
  const CONCURRENCY = 6;
  for (let i = 0; i < uniqueCwds.length; i += CONCURRENCY) {
    const chunk = uniqueCwds.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (cwd) => {
      projectByCwd.set(cwd, await resolveProject(cwd));
    }));
  }
  return projectByCwd;
}

async function loadAllSessions(): Promise<SessionInfo[]> {
  const ompSessions: OmpSessionInfo[] = await listAllSessionInfos();
  const pathToId = new Map<string, string>();
  const knownIds = new Set<string>();
  for (const s of ompSessions) {
    pathToId.set(sessionPathKey(s.path), s.id);
    knownIds.add(s.id);
  }
  const parents: ParentIndex = {
    idForPath: (path) => pathToId.get(sessionPathKey(path)),
    hasId: (id) => knownIds.has(id),
  };

  const projectByCwd = await resolveProjectsByCwd(ompSessions);
  return ompSessions.map((s) => {
    cacheSessionPath(s.id, s.path);
    return toSessionInfo(s, s.cwd ? projectByCwd.get(s.cwd) : undefined, parents);
  });
}

/** Requested ids, split into the sessions that exist (list order: newest first) and the ones with no file. */
export interface SessionsByIds {
  sessions: SessionInfo[];
  missing: string[];
}

/**
 * The list entries of just these sessions, without walking the sessions tree.
 *
 * Cheap path: every id resolves through the session path cache (filled by the
 * last full list and by live sessions), the file is scanned with the same
 * scanner as the list and projects come from the per-cwd project cache. A
 * cached path whose file is gone is a definitive "missing".
 *
 * Falls back to the normal list (cached, coalesced; `listAllSessions`) and
 * filters it, so the answer is the list's own objects, when an id cannot be
 * located cheaply: an id the path cache has never seen (a new session), a file
 * whose header id differs from the cached one, or a session with a parent link
 * the caches cannot resolve (the list is the authority on orphans).
 */
export async function listSessionsByIds(ids: readonly string[]): Promise<SessionsByIds> {
  const wanted = new Set(ids);
  const fromList = async (): Promise<SessionsByIds> => {
    const sessions = (await listAllSessions()).filter((s) => wanted.has(s.id));
    const present = new Set(sessions.map((s) => s.id));
    return { sessions, missing: [...wanted].filter((id) => !present.has(id)) };
  };

  const pathCache = getPathCache();
  const found: OmpSessionInfo[] = [];
  const missing: string[] = [];
  for (const id of wanted) {
    const cached = pathCache.get(id);
    if (!cached) return fromList();
    if (!existsSync(cached)) {
      invalidateSessionPathCache(id);
      missing.push(id);
      continue;
    }
    const info = scanSessionInfo(cached);
    if (!info) {
      missing.push(id);
      continue;
    }
    if (info.id !== id) return fromList();
    found.push(info);
  }

  const hasId = (id: string): boolean => {
    const path = pathCache.get(id);
    return path !== undefined && existsSync(path);
  };
  const parents: ParentIndex = {
    idForPath: (path) => {
      const id = getPathToIdCache().get(sessionPathKey(path));
      return id !== undefined && hasId(id) ? id : undefined;
    },
    hasId,
  };
  if (found.some((s) => s.parentSessionPath && matchParentSessionId(s.parentSessionPath, parents) === undefined)) {
    return fromList();
  }

  found.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  const projectByCwd = await resolveProjectsByCwd(found);
  return {
    sessions: found.map((s) => toSessionInfo(s, s.cwd ? projectByCwd.get(s.cwd) : undefined, parents)),
    missing,
  };
}

export async function listAllSessions(): Promise<SessionInfo[]> {
  const generation = globalThis.__piSessionListGeneration ?? 0;

  // Return cached result if still fresh (avoids re-scanning session files
  // and re-spawning git processes on every page load).
  if (globalThis.__piSessionListCache && Date.now() - globalThis.__piSessionListCache.ts < SESSION_LIST_CACHE_TTL_MS) {
    return globalThis.__piSessionListCache.data;
  }

  // Coalescing dedup: concurrent callers share the same in-flight promise
  // only while it belongs to the current cache generation.
  if (globalThis.__piSessionListPromise && globalThis.__piSessionListPromiseGeneration === generation) {
    return globalThis.__piSessionListPromise;
  }

  // Flipped once the watchdog below retires this scan: a hung load that
  // resolves after the slot moved on must not overwrite fresher cache data.
  let retired = false;
  const loadPromise = loadAllSessions().then((data) => {
    // An invalidation may happen while the scan is in flight. Do not let that
    // older result repopulate the cache after a session mutation.
    if ((globalThis.__piSessionListGeneration ?? 0) === generation && !retired) {
      globalThis.__piSessionListCache = { data, ts: Date.now() };
    }
    return data;
  });
  const trackedPromise = loadPromise.finally(() => {
    if (globalThis.__piSessionListPromise === trackedPromise) {
      globalThis.__piSessionListPromise = undefined;
      globalThis.__piSessionListPromiseGeneration = undefined;
    }
  });
  // A load that never settles (a stuck sync syscall, a hung git spawn that
  // slipped past its timeout) must not be handed to every future caller
  // forever — the coalescing slot would pin the wedge until process restart.
  // Drop the slot after a generous deadline; the cache stays unset, so the
  // next request starts a fresh scan.
  const watchdog = setTimeout(() => {
    if (globalThis.__piSessionListPromise === trackedPromise) {
      globalThis.__piSessionListPromise = undefined;
      globalThis.__piSessionListPromiseGeneration = undefined;
      retired = true;
    }
  }, SESSION_LIST_LOAD_DEADLINE_MS);
  watchdog.unref?.();

  globalThis.__piSessionListPromise = trackedPromise;
  globalThis.__piSessionListPromiseGeneration = generation;
  watchdog.unref?.();

  globalThis.__piSessionListPromise = trackedPromise;
  globalThis.__piSessionListPromiseGeneration = generation;
  return trackedPromise;
}

// ============================================================================
// Session path caches, stored in globalThis for hot-reload safety.
// ============================================================================
declare global {
  var __piSessionPathCache: Map<string, string> | undefined;
  var __piPathToSessionIdCache: Map<string, string> | undefined;
  var __piSessionListPromise: Promise<SessionInfo[]> | undefined;
  var __piSessionListPromiseGeneration: number | undefined;
  var __piSessionListGeneration: number | undefined;
  var __piSessionListCache: { data: SessionInfo[]; ts: number } | undefined;
}

const SESSION_LIST_CACHE_TTL_MS = 30_000;
/** Beyond this, an unsettled in-flight list load stops being coalesced. */
const SESSION_LIST_LOAD_DEADLINE_MS = 60_000;

/** Invalidate the session LIST metadata (30s TTL result + generation gate)
 * and the directory-walk cache, but leave per-session parse caches intact.
 * Use this when a session changed but you know which one: call
 * invalidateSessionEntriesCache(path) for the specific file instead of paying
 * for a full parse-cache flush. */
export function invalidateSessionListMeta(): void {
  globalThis.__piSessionListGeneration = (globalThis.__piSessionListGeneration ?? 0) + 1;
  globalThis.__piSessionListCache = undefined;
  // The session-file walk cache keys on the sessions-root mtime, which does
  // not change when a file is added inside an existing project subdirectory
  // (Windows/NTFS). Clear it too so new sessions appear immediately.
  invalidateSessionFileListCache();
}

export function invalidateSessionListCache(): void {
  invalidateSessionListMeta();
  // Drop cached entry parses so a mutation preserving size+mtime (rare) can
  // never serve stale entries; the (size, mtimeMs) key already invalidates
  // the common case, this closes the remaining window.
  invalidateSessionHistory();
  // Unknown-source changes (full-flush fallback) have no known path to target
  // with invalidateSessionEntriesCache: clear every per-file SCAN memo too, or
  // an unknown same-size + same-mtime rewrite would keep serving the OLD list
  // summary (stale title/parent) from __ompSessionScanCache.
  invalidateAllSessionScanCaches();
}

/** Invalidate session-list metadata plus ONLY the given file's parse caches
 * when the path is known; without a path, fall back to the full flush (list
 * + every session's parse caches). This is the shared entry point for code
 * that edits a session and knows which file it touched — a busy session must
 * not force unrelated open sessions to re-parse their transcripts. */
export function invalidateSessionCaches(filePath?: string): void {
  if (filePath) {
    invalidateSessionListMeta();
    invalidateSessionEntriesCache(filePath);
  } else {
    invalidateSessionListCache();
  }
}

/** Invalidate ONLY the per-session caches for one session file (full-entry
 * parse + list scan window). Callers that know exactly which session changed
 * (live RPC events carrying the session file path, the file watcher with a
 * concrete filename) use this instead of invalidateSessionListCache() so
 * unrelated sessions keep their parsed-entry cache — a single busy session no
 * longer forces every other open session to re-parse multi-MB transcripts.
 * The key is normalized with sessionPathKey so Windows case/spacing variants
 * still hit the same entry. */
export function invalidateSessionEntriesCache(filePath: string): void {
  invalidateSessionHistory(filePath);
  invalidateSessionScanCache(filePath);
}

function getPathCache(): Map<string, string> {
  if (!globalThis.__piSessionPathCache) globalThis.__piSessionPathCache = new Map();
  return globalThis.__piSessionPathCache;
}

function getPathToIdCache(): Map<string, string> {
  if (!globalThis.__piPathToSessionIdCache) globalThis.__piPathToSessionIdCache = new Map();
  return globalThis.__piPathToSessionIdCache;
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached) {
    if (existsSync(cached)) return cached;
    // A deleted session must never resolve: callers spawn omp with --resume
    // against the path, and omp silently creates a NEW session when the file
    // is gone. Drop the dead entry directly; the list cache stays valid, so
    // repeated 404 polls for the same id do not force a full rescan each time.
    // (listAllSessions would drop it anyway on the next real list mutation.)
    invalidateSessionPathCache(sessionId);
  }

  // Cache miss: scan all sessions to populate cache, then retry
  await listAllSessions();
  const resolved = getPathCache().get(sessionId);
  if (!resolved) return null;
  if (!existsSync(resolved)) {
    invalidateSessionPathCache(sessionId);
    return null;
  }
  return resolved;
}

export async function resolveSessionIdByPath(filePath: string): Promise<string | undefined> {
  const pathKey = sessionPathKey(filePath);
  const cached = getPathToIdCache().get(pathKey);
  if (cached) return cached;

  await listAllSessions();
  return getPathToIdCache().get(pathKey);
}

/**
 * Resolve a `header.parentSession` value (either a session file path or a bare
 * session id — see matchParentSessionId) to the parent's session id.
 */
export async function resolveParentSessionId(parentSession: string): Promise<string | undefined> {
  if (!parentSession) return undefined;
  const byPath = await resolveSessionIdByPath(parentSession);
  if (byPath) return byPath;
  // Id form: only accept it when a session file with that id still exists.
  return (await resolveSessionPath(parentSession)) ? parentSession : undefined;
}

export function cacheSessionPath(sessionId: string, filePath: string): void {
  const normalizedPath = normalizePath(filePath);
  const pathKey = sessionPathKey(normalizedPath);
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const previousPath = pathCache.get(sessionId);
  const previousPathKey = previousPath ? sessionPathKey(previousPath) : undefined;
  const previousSessionId = reverseCache.get(pathKey);
  const previousOwnerPath = previousSessionId ? pathCache.get(previousSessionId) : undefined;
  if (previousPathKey && previousPathKey !== pathKey && reverseCache.get(previousPathKey) === sessionId) {
    reverseCache.delete(previousPathKey);
  }
  if (
    previousSessionId &&
    previousSessionId !== sessionId &&
    previousOwnerPath &&
    sessionPathKey(previousOwnerPath) === pathKey
  ) {
    pathCache.delete(previousSessionId);
  }
  pathCache.set(sessionId, normalizedPath);
  reverseCache.set(pathKey, sessionId);
}

export function invalidateSessionPathCache(sessionId: string): void {
  const pathCache = getPathCache();
  const reverseCache = getPathToIdCache();
  const filePath = pathCache.get(sessionId);
  pathCache.delete(sessionId);
  const pathKey = filePath ? sessionPathKey(filePath) : undefined;
  if (pathKey && reverseCache.get(pathKey) === sessionId) {
    reverseCache.delete(pathKey);
  }
}

/** Bounded, title-slot-aware header read (never loads message bodies). */
export function readSessionHeader(filePath: string): SessionHeader | null {
  return readSessionHeaderSync(filePath);
}


/** All materializing reads execute on the bounded history worker. The main
 * thread retains no raw/index cache and never falls back to synchronous work. */
export function getSessionEntries(filePath: string) {
  return requestSessionHistory({ operation: "entries", filePath });
}

export function getSessionEntriesForDisplayAsync(filePath: string, options: ResolveBlobOptions = {}) {
  return requestSessionHistory({ operation: "displayEntries", filePath, options });
}

export function getSessionContextBoundary(filePath: string) {
  return requestSessionHistory({ operation: "boundary", filePath });
}

export function getSessionHistoryPage(filePath: string, cursor: SessionHistoryCursor | null, limit: number, leafId?: string,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean; includePreCompaction?: boolean } = {}) {
  return requestSessionHistory({ operation: "page", filePath, cursor, limit, leafId, options });
}

export function getSessionDisplay(filePath: string, options: { deferThinking?: boolean; deferToolResultImages?: boolean } = {}) {
  return requestSessionHistory({ operation: "display", filePath, options });
}

export function getSessionContextForDisplay(filePath: string, leafId?: string,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean; includePreCompaction?: boolean } = {}) {
  return requestSessionHistory({ operation: "context", filePath, leafId, options });
}

/** Validate malformed-header files off-thread as well, including the 1 GiB gate. */
export function getSessionLoadError(filePath: string) {
  return requestSessionHistory({ operation: "loadError", filePath });
}


