import { realpathSync, statSync } from "fs";
import { isAbsolute, normalize as normalizePath, relative, sep } from "path";
import { getAgentDir, getSessionsDir } from "./omp/paths";
import { readSessionHeaderSync, type ResolveBlobOptions } from "./omp/session-files";
import type {
  SessionHeader,
  SessionInfo,
} from "./types";
import { requestSessionHistory, invalidateSessionHistory } from "./session-history-queue";
export { SessionFileTooLargeError, SessionHistoryWorkerError } from "./session-history-errors";
export { buildSessionContext, getTodoPhasesFromEntries, entryToUiMessage } from "./session-context";
import { sessionPathKey } from "./paths";
import { invalidateSessionIndex, readSessionIndex } from "./session-index";
import type { SessionHistoryCursor } from "./session-sync";

export { getAgentDir };

/** The persistent projection is display-only; native resolution below validates every candidate. */

/** Requested ids, split into the sessions that exist (list order: newest first) and the ones with no file. */
export interface SessionsByIds {
  sessions: SessionInfo[];
  missing: string[];
}

export async function listSessionsByIds(ids: readonly string[]): Promise<SessionsByIds> {
  const { sessions, missing } = await readSessionIndex(ids);
  for (const session of sessions) cacheSessionPath(session.id, session.path);
  return { sessions, missing };
}

export async function listAllSessions(): Promise<SessionInfo[]> {
  const { sessions } = await readSessionIndex();
  for (const session of sessions) cacheSessionPath(session.id, session.path);
  return sessions;
}

// ============================================================================
// Session path caches, stored in globalThis for hot-reload safety.
// ============================================================================
declare global {
  var __piSessionPathCache: Map<string, string> | undefined;
  var __piPathToSessionIdCache: Map<string, string> | undefined;
}

/** Unknown-source changes require full native inventory reconciliation. */
export function invalidateSessionListMeta(): void {
  invalidateSessionIndex();
}

export function invalidateSessionListCache(): void {
  invalidateSessionIndex();
  invalidateSessionHistory();
}

export function invalidateSessionCaches(filePath?: string): void {
  if (filePath) invalidateSessionEntriesCache(filePath);
  else invalidateSessionListCache();
}

/** Native metadata and transcript caches share one targeted invalidation boundary. */
export function invalidateSessionEntriesCache(filePath: string): void {
  invalidateSessionHistory(filePath);
  invalidateSessionIndex([filePath]);
}

function getPathCache(): Map<string, string> {
  if (!globalThis.__piSessionPathCache) globalThis.__piSessionPathCache = new Map();
  return globalThis.__piSessionPathCache;
}

function getPathToIdCache(): Map<string, string> {
  if (!globalThis.__piPathToSessionIdCache) globalThis.__piPathToSessionIdCache = new Map();
  return globalThis.__piPathToSessionIdCache;
}

/** Projection paths cannot extend the native active-session root. Resolve both
 * sides through the filesystem so symlink escapes never gain authority. */
function nativeCandidatePath(filePath: string): string | null {
  try {
    const root = realpathSync.native(getSessionsDir());
    const candidate = realpathSync.native(filePath);
    const rel = relative(root, candidate);
    if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`) || !candidate.endsWith(".jsonl")) return null;
    return statSync(candidate).isFile() ? candidate : null;
  } catch { return null; }
}

export async function resolveSessionPath(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  if (cached) {
    const native = nativeCandidatePath(cached);
    if (native && readSessionHeaderSync(native)?.id === sessionId) return native;
    invalidateSessionPathCache(sessionId);
  }
  const { sessions } = await readSessionIndex([sessionId]);
  const candidate = sessions.find(session => session.id === sessionId)?.path;
  // Cached/indexed rows locate candidates only: a deleted or replaced file must
  // never become an omp --resume invocation that silently creates a session.
  const native = candidate ? nativeCandidatePath(candidate) : null;
  if (!native || readSessionHeaderSync(native)?.id !== sessionId) return null;
  cacheSessionPath(sessionId, native);
  return native;
}

/** Read-only history diagnostics may inspect an existing malformed candidate.
 * NEVER use this locator for resume, mutations, permissions, or grants. A
 * readable different native identity is rejected even for diagnostic reads. */
export async function resolveSessionCandidate(sessionId: string): Promise<string | null> {
  const cached = getPathCache().get(sessionId);
  const candidate = cached ?? (await readSessionIndex([sessionId])).sessions.find(session => session.id === sessionId)?.path;
  const native = candidate ? nativeCandidatePath(candidate) : null;
  if (!native) return null;
  const header = readSessionHeaderSync(native);
  if (header?.id && header.id !== sessionId) return null;
  return native;
}

export async function resolveSessionIdByPath(filePath: string): Promise<string | undefined> {
  const native = nativeCandidatePath(filePath);
  const header = native ? readSessionHeaderSync(native) : null;
  if (!header || typeof header.id !== "string" || !header.id) {
    const cached = getPathToIdCache().get(sessionPathKey(filePath));
    if (cached) invalidateSessionPathCache(cached);
    return undefined;
  }
  cacheSessionPath(header.id, filePath);
  return header.id;
}

/** Resolve native parent references (a file path or a bare session id). */
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


