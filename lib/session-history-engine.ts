// Imported only by the history worker in production. Tests exercise the same
// synchronous engine directly to observe file reads and cache eviction.
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync, type Stats } from "fs";
import { buildSessionTree, containsBlobRef, loadSessionFile, MAX_SESSION_LOAD_BYTES, resolveBlobRefsInEntries, type ResolveBlobOptions } from "./omp/session-files";
import type { SessionContext, SessionEntry } from "./types";
import { isRecord } from "./type-guards";
import { sessionPathKey } from "./paths";
import { selectHistoryRange, type SessionHistoryCursor, type SessionHistoryPage } from "./session-sync";
import { buildSessionContext, compactionUiMessage, entryToUiMessage, selectSessionContext } from "./session-context";
import { SessionFileTooLargeError } from "./session-history-errors";
import { projectTreeForResponse } from "./session-tree-projection";

function historyPathKey(filePath: string): string {
  try { return sessionPathKey(realpathSync.native(filePath)); }
  catch { return sessionPathKey(filePath); }
}

export function invalidateSessionEntriesCache(filePath?: string): void {
  if (!filePath) {
    globalThis.__ompSessionEntriesCache?.clear();
    globalThis.__ompSessionHistoryIndexes?.clear();
    return;
  }
  const pathKey = historyPathKey(filePath);
  globalThis.__ompSessionEntriesCache?.delete(pathKey);
  for (const [key, index] of globalThis.__ompSessionHistoryIndexes ?? []) {
    if (index.pathKey === pathKey) globalThis.__ompSessionHistoryIndexes?.delete(key);
  }
}

export function getSessionDisplay(filePath: string, options: { deferThinking?: boolean; deferToolResultImages?: boolean } = {}) {
  const entries = getSessionEntriesForDisplay(filePath, { skipToolResultImages: options.deferToolResultImages });
  const leafId = entries.at(-1)?.id ?? null;
  return { leafId, tree: projectTreeForResponse(buildSessionTree(entries)), context: buildSessionContext(entries, leafId, options) };
}

export function getSessionContextForDisplay(filePath: string, leafId?: string, options: { deferThinking?: boolean; deferToolResultImages?: boolean; includePreCompaction?: boolean } = {}) {
  return buildSessionContext(getSessionEntriesForDisplay(filePath, { skipToolResultImages: options.deferToolResultImages }), leafId, options);
}

/** Full-file entry parse memoized on (path, size, mtimeMs). Read-only scans
 * (subagent history, file-reference checks, thinking routes) re-parse MB-scale
 * session files on every 15s reconcile poll and again at run end; the memo
 * turns each UNCHANGED file's parse into a single stat — the same convention
 * as scanSessionInfoCached. Stored on globalThis for hot-reload safety and
 * LRU-bounded. Entries are SHARED across cache hits: callers must treat them
 * as immutable (all current callers only read). */
interface SessionEntriesCacheEntry {
  size: number;
  mtimeMs: number;
  entries: SessionEntry[];
}

declare global {
  var __ompSessionEntriesCache: Map<string, SessionEntriesCacheEntry> | undefined;
}

const MAX_SESSION_ENTRIES_CACHE_ENTRIES = 32;
/** Byte cap on CACHED FILE SIZES (parsed JS expands several-fold). Without it,
 *  32 cached near-1GiB transcripts could pin tens of GB of heap. */
const MAX_SESSION_ENTRIES_CACHE_BYTES = 256 * 1024 * 1024;

function getSessionEntriesCache(): Map<string, SessionEntriesCacheEntry> {
  if (!globalThis.__ompSessionEntriesCache) globalThis.__ompSessionEntriesCache = new Map();
  return globalThis.__ompSessionEntriesCache;
}

function loadSessionEntriesCached(filePath: string): SessionEntry[] {
  let size: number;
  let mtimeMs: number;
  try {
    const stat = statSync(filePath);
    size = stat.size;
    mtimeMs = stat.mtimeMs;
  } catch {
    // Missing/unreadable file — mirror loadSessionFile's lenient empty result.
    return loadSessionFile(filePath).entries;
  }
  const cache = getSessionEntriesCache();
  const key = historyPathKey(filePath);
  const cached = cache.get(key);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.entries;
  }
  const entries = loadSessionFile(filePath).entries;
  // A single file larger than the WHOLE cache budget would pin the entire
  // budget for itself (the old `cache.size > 1` guard never evicted it) and
  // starve every other session's cached parse. Skip the cache for such
  // giants: they re-parse per request, which is bounded work (the read is
  // chunked; parse is O(entries)) and far cheaper than evicting all peers.
  // The per-request parse cost is the accepted trade-off for staying within
  // the memory budget — the alternative (caching) makes concurrent large
  // sessions OOM the server.
  if (size > MAX_SESSION_ENTRIES_CACHE_BYTES) {
    // The file outgrew the budget: any cached entry for this path is stale
    // (keyed on the OLD smaller size) and would keep burning eviction budget
    // until LRU got to it — drop it now.
    cache.delete(key);
    return entries;
  }
  cache.set(key, { size, mtimeMs, entries });
  // Two bounds: entry count and total cached file bytes (parsed JS expands
  // several-fold). Total-bytes eviction keeps the cache within budget.
  let totalBytes = 0;
  for (const entry of cache.values()) totalBytes += entry.size;
  while (cache.size > 1 && (cache.size > MAX_SESSION_ENTRIES_CACHE_ENTRIES || totalBytes > MAX_SESSION_ENTRIES_CACHE_BYTES)) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    totalBytes -= cache.get(oldestKey)?.size ?? 0;
    cache.delete(oldestKey);
  }
  return entries;
}

/** Session entries without blob resolution (fine for reference/thinking scans). */
export function getSessionEntries(filePath: string): SessionEntry[] {
  return loadSessionEntriesCached(filePath);
}

/** Surface loadSessionFile's `too_large` marker (loadSessionEntriesCached
 * drops it by returning only `.entries`) without paying for a fresh parse:
 * the size check is a stat, and the cached read below serves everything
 * else. Header reads are bounded and succeed on giant files, so this check is
 * what tells a 413 (file too large) from a 404 (missing/malformed). */
function loadEntriesOrThrowTooLarge(filePath: string): SessionEntry[] {
  try {
    if (statSync(filePath).size > MAX_SESSION_LOAD_BYTES) {
      // The cached entry (keyed on the old, smaller size) can never match
      // again — drop it instead of letting it linger until LRU eviction.
      getSessionEntriesCache().delete(historyPathKey(filePath));
      throw new SessionFileTooLargeError(filePath);
    }
  } catch (error) {
    if (error instanceof SessionFileTooLargeError) throw error;
    // Missing/unreadable — mirror loadSessionFile's lenient empty result;
    // loadSessionEntriesCached handles the same case identically.
  }
  return loadSessionEntriesCached(filePath);
}
/**
 * Display-path entry read for the session/context routes: reuses the memoized
 * (size, mtimeMs) parse cache WITHOUT blob resolution for entries that don't
 * reference blobs, and deep-copies ONLY the entries that do before resolving
 * their blob refs. The cache stays clean (shared objects are never mutated),
 * and the expensive deep copy is paid only for blob-bearing entries — the
 * common image-free session clones nothing (the array is shallow-copied).
 * Throws SessionFileTooLargeError when the file exceeds the load ceiling.
 */
export function getSessionEntriesForDisplay(filePath: string, options: ResolveBlobOptions = {}): SessionEntry[] {
  const entries = loadEntriesOrThrowTooLarge(filePath);
  return toDisplayEntries(entries, options);
}

/** Blob-resolution transform shared by the sync and deduplicated display
 * reads. */
function toDisplayEntries(entries: SessionEntry[], options: ResolveBlobOptions): SessionEntry[] {
  if (entries.length === 0) return entries;
  // Blob-bearing entries are deep-copied so resolution never mutates the
  // shared cache object; blob-free entries are shared as-is.
  const out: SessionEntry[] = new Array(entries.length);
  let copiedAny = false;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (
      options.skipToolResultImages &&
      entry.type === "message" &&
      ((entry.message as { role?: string } | null | undefined)?.role === "toolResult")
    ) {
      // Caller turns these images into media URLs — share the entry without blob work.
      out[i] = entry;
      continue;
    }
    if (!containsBlobRef(entry)) {
      out[i] = entry;
      continue;
    }
    // Blob-bearing entries are deep-copied so resolution never mutates the
    // shared cache object.
    out[i] = structuredClone(entry) as SessionEntry;
    copiedAny = true;
  }
  if (copiedAny) {
    resolveBlobRefsInEntries(out, options);
  }
  return out;
}
interface HistoryEntryRange {
  id: string;
  offset: number;
  length: number;
  firstKeptEntryId?: string;
  legacyCustom?: boolean;
}

interface SessionHistoryIndex {
  pathKey: string;
  version: string;
  bytes: number;
  rows: HistoryEntryRange[];
  entryIds: string[];
  positions: Map<string, number>;
  compactionId: string | null;
  metadata: Omit<SessionContext, "messages" | "entryIds">;
  leafId: string | null;
  tipId: string | null;
}

declare global {
  var __ompSessionHistoryIndexes: Map<string, SessionHistoryIndex> | undefined;
}

// Independent of the 256 MiB RAW parse cache: only offsets, IDs and selected
// branch metadata live here, never transcript bodies or compaction summaries.
// Charge UTF-16 strings plus per-row/map overhead; both LRU bounds apply.
const MAX_HISTORY_INDEX_BYTES = 32 * 1024 * 1024;
const MAX_HISTORY_INDEXES = 32;

function historyFileVersion(stat: Stats): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/** The shared loader still owns title slots, lenient parsing and migrations.
 * Discard bodies before retaining each entry; keep only selection inputs. */
function historyEntryMetadata(entry: SessionEntry): SessionEntry {
  const compact: Record<string, unknown> = {
    type: entry.type, id: entry.id, parentId: entry.parentId, timestamp: entry.timestamp,
  };
  if (entry.type === "message" && isRecord(entry.message)) {
    const message = entry.message;
    compact.message = {
      role: message.role, provider: message.provider, model: message.model,
      ...(message.role === "toolResult" && message.toolName === "todo" ? {
        toolName: message.toolName, isError: message.isError,
        details: isRecord(message.details) ? { phases: message.details.phases } : undefined,
      } : {}),
    };
  } else if (entry.type === "model_change") {
    Object.assign(compact, { model: entry.model, role: entry.role, provider: entry.provider, modelId: entry.modelId });
  } else if (entry.type === "thinking_level_change") {
    compact.thinkingLevel = entry.thinkingLevel;
  } else if (entry.type === "compaction") {
    compact.firstKeptEntryId = entry.firstKeptEntryId;
    compact.firstKeptEntryIndex = (entry as unknown as Record<string, unknown>).firstKeptEntryIndex;
  } else if (entry.type === "branch_summary") {
    compact.summary = entry.summary ? "present" : "";
  } else if (entry.type === "custom" && entry.customType === "user_todo_edit") {
    compact.customType = entry.customType;
    compact.data = isRecord(entry.data) ? { phases: entry.data.phases } : undefined;
  }
  return compact as unknown as SessionEntry;
}

function buildHistoryIndex(
  filePath: string, version: string, leafId?: string, includePreCompaction?: boolean,
): SessionHistoryIndex {
  const ranges = new WeakMap<SessionEntry, { offset: number; length: number }>();
  const loaded = loadSessionFile(filePath, {
    projectEntry(entry, offset, length) {
      const compact = historyEntryMetadata(entry);
      ranges.set(compact, { offset, length });
      return compact;
    },
  });
  if (loaded.error === "too_large") throw new SessionFileTooLargeError(filePath);
  const { selected, compactionId, ...metadata } = selectSessionContext(loaded.entries, leafId, { includePreCompaction });
  const rows = selected.map((entry): HistoryEntryRange => ({
    id: entry.id,
    ...ranges.get(entry)!,
    ...(entry.type === "compaction" ? { firstKeptEntryId: entry.firstKeptEntryId } : {}),
    ...(entry.type === "message" && entry.message.role === "custom" ? { legacyCustom: true } : {}),
  }));
  const tipId = loaded.entries.at(-1)?.id ?? null;
  // Detach metadata strings from the parser's JSON source: an ID represented
  // by a sliced V8 string must not pin a multi-megabyte message body.
  const serialized = JSON.stringify({
    rows, compactionId, metadata, tipId,
    leafId: leafId && loaded.entries.some((entry) => entry.id === leafId) ? leafId : tipId,
  });
  const detached = JSON.parse(serialized) as Pick<SessionHistoryIndex, "rows" | "compactionId" | "metadata" | "tipId" | "leafId">;
  const entryIds = detached.rows.map((row) => row.id);
  const positions = new Map(entryIds.map((id, position) => [id, position]));
  const bytes = 256 + serialized.length * 2 + rows.length * 192;
  return { ...detached, pathKey: historyPathKey(filePath), version, bytes, entryIds, positions };
}

/** Rebuild on any file-version change: growth alone cannot prove that old
 * offsets survived a prefix rewrite. Both readers share the same bounded LRU. */
function getSessionHistoryIndex(filePath: string, leafId?: string, includePreCompaction = false) {
  const cache = globalThis.__ompSessionHistoryIndexes ??= new Map();
  const pathKey = historyPathKey(filePath);
  const key = JSON.stringify([pathKey, leafId ?? null, includePreCompaction]);
  let stat: Stats | undefined;
  try { stat = statSync(filePath); } catch { /* Missing/unreadable: retain the lenient empty result. */ }
  if (stat && stat.size > MAX_SESSION_LOAD_BYTES) {
    invalidateSessionEntriesCache(filePath);
    throw new SessionFileTooLargeError(filePath);
  }
  const version = stat ? historyFileVersion(stat) : "";
  for (const [cachedKey, cached] of cache) {
    if (cached.pathKey === pathKey && cached.version !== version) cache.delete(cachedKey);
  }
  let index = cache.get(key);
  if (!index) {
    index = buildHistoryIndex(filePath, version, leafId, includePreCompaction);
    if (stat && historyFileVersion(statSync(filePath)) !== version) throw new Error("Session changed while indexing history");
    // An unusually metadata-heavy file still opens, but cannot evict every
    // peer or retain more than the entire index budget by itself.
    if (stat && index.bytes <= MAX_HISTORY_INDEX_BYTES) cache.set(key, index);
  } else {
    cache.delete(key);
    cache.set(key, index);
  }
  let totalBytes = 0;
  for (const cached of cache.values()) totalBytes += cached.bytes;
  while (cache.size > MAX_HISTORY_INDEXES || totalBytes > MAX_HISTORY_INDEX_BYTES) {
    const oldest = cache.keys().next().value!;
    totalBytes -= cache.get(oldest)!.bytes;
    cache.delete(oldest);
  }
  return { index, cache, key };
}

/** Current active context IDs only; no body seeks or blob hydration. The
 * returned IDs are cached and immutable, like getSessionEntries results. */
export function getSessionContextBoundary(filePath: string): { entryIds: string[] } {
  const { index } = getSessionHistoryIndex(filePath);
  return { entryIds: index.entryIds };
}

/** Seek only page bodies. A file changed during indexing/reading must not
 * advance the browser cursor using offsets from a different file version. */
export function getSessionHistoryPage(
  filePath: string,
  cursor: SessionHistoryCursor | null,
  limit: number,
  leafId?: string,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean; includePreCompaction?: boolean } = {},
): { history: SessionHistoryPage; leafId: string | null; tipId: string | null } {
  const { index, cache, key } = getSessionHistoryIndex(filePath, leafId, !!options.includePreCompaction);
  const version = index.version;

  const { start, end, ...page } = selectHistoryRange(index.entryIds, cursor, limit, index.positions);
  const rawEntries: SessionEntry[] = [];
  if (start < end) {
    const fd = openSync(filePath, "r");
    try {
      if (historyFileVersion(fstatSync(fd)) !== version) throw new Error("Session changed before reading history");
      for (let i = start; i < end; i++) {
        const row = index.rows[i];
        const buffer = Buffer.allocUnsafe(row.length);
        let read = 0;
        while (read < buffer.length) {
          const count = readSync(fd, buffer, read, buffer.length - read, row.offset + read);
          if (count === 0) throw new Error("Session truncated while reading history");
          read += count;
        }
        const entry = JSON.parse(buffer.toString("utf8").trim()) as SessionEntry;
        // Reuse IDs/compaction links assigned by v1 migration; v2 renamed the
        // hookMessage role. No migrated body is retained between requests.
        entry.id = row.id;
        if (entry.type === "compaction") entry.firstKeptEntryId = row.firstKeptEntryId!;
        if (entry.type === "message" && row.legacyCustom) {
          const message = entry.message as unknown as Record<string, unknown>;
          if (message.role === "hookMessage") message.role = "custom";
        }
        rawEntries.push(entry);
      }
      if (historyFileVersion(fstatSync(fd)) !== version || historyFileVersion(statSync(filePath)) !== version) {
        throw new Error("Session changed while reading history");
      }
    } catch (error) {
      cache.delete(key);
      throw error;
    } finally {
      closeSync(fd);
    }
  }
  const entries = toDisplayEntries(rawEntries, { skipToolResultImages: options.deferToolResultImages });
  const history: SessionHistoryPage = {
    ...page,
    context: {
      ...index.metadata,
      entryIds: index.entryIds.slice(start, end),
      messages: entries.map((entry) => entry.type === "compaction"
        ? compactionUiMessage(entry, entry.id === index.compactionId)
        : entryToUiMessage(entry, options)!),
    },
  };
  return { history, leafId: index.leafId, tipId: index.tipId };
}
