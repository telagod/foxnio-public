import { promises as fs } from "fs";
import { scanJsonlLines } from "./jsonl-lines";
import { listAllSessions } from "./session-reader";
import {
  compileSearchQuery,
  CONTENT_WEIGHT,
  FIRST_MESSAGE_WEIGHT,
  scoreSearchFields,
  searchField,
  TITLE_WEIGHT,
  type SearchField,
} from "./session-search";
export const MAX_CONTENT_CACHE_ENTRIES = 200;
/** Memory budget of the cache: characters of text plus unique words across all entries. */
export const MAX_CONTENT_CACHE_CHARS = 32 * 1024 * 1024;
/** Searchable text kept per transcript; later messages are not indexed (the scan stops there). */
export const MAX_TRANSCRIPT_CHARS = 2 * 1024 * 1024;
/**
 * A user/assistant line longer than this is not indexed (a pasted file or log
 * dump), so one such line cannot balloon the scan's memory. Longer lines are
 * skipped without being decoded.
 */
export const MAX_MESSAGE_LINE_BYTES = 1024 * 1024;

interface ContentCacheEntry {
  version: string;
  /** Size of the resolved field (see `fieldChars`); 0 while the file is still being read. */
  chars: number;
  field: Promise<SearchField>;
}

declare global {
  var __ompSessionContentSearchCache: Map<string, ContentCacheEntry> | undefined;
}

const PARSE_CONCURRENCY = 4;

const TYPE_MESSAGE = Buffer.from('"type":"message"');
const ROLE_USER = Buffer.from('"role":"user"');
const ROLE_ASSISTANT = Buffer.from('"role":"assistant"');
// The role sits within the first 400 UTF-16 units of a line (3 UTF-8 bytes per unit at most).
const HEAD_UNITS = 400;
const HEAD_BYTES = HEAD_UNITS * 3;

/** Bytes of `buffer[0, length)` (valid UTF-8) that decode to its first `units` UTF-16 code units. */
function utf8PrefixBytes(buffer: Buffer, length: number, units: number): number {
  let remaining = units;
  for (let i = 0; i < length; i++) {
    const byte = buffer[i];
    if ((byte & 0xc0) === 0x80) continue; // continuation byte of the current character
    if (remaining <= 0) return i;
    remaining -= byte >= 0xf0 ? 2 : 1; // four-byte characters are surrogate pairs
  }
  return length;
}

/** True when the line start shows a user or assistant message; tool results (often MBs) never get parsed. */
function isUserOrAssistantMessage(buffer: Buffer, length: number): boolean {
  const head = buffer.subarray(0, utf8PrefixBytes(buffer, length, HEAD_UNITS));
  return head.includes(TYPE_MESSAGE) && (head.includes(ROLE_USER) || head.includes(ROLE_ASSISTANT));
}

/**
 * User and assistant text only (tool output and thinking would drown real
 * matches), joined by "\n" and cut at `MAX_TRANSCRIPT_CHARS`.
 */
export async function extractTranscriptText(filePath: string): Promise<string> {
  const parts: string[] = [];
  let length = 0; // length of parts.join("\n")
  /** Returns false once the character budget is spent. */
  const append = (text: string): boolean => {
    const separator = parts.length > 0 ? 1 : 0;
    const room = MAX_TRANSCRIPT_CHARS - length - separator;
    if (room <= 0) return false;
    parts.push(text.length > room ? text.slice(0, room) : text);
    length += separator + Math.min(text.length, room);
    return text.length <= room;
  };
  await scanJsonlLines(filePath, {
    headBytes: HEAD_BYTES,
    maxLineBytes: MAX_MESSAGE_LINE_BYTES,
    accept: isUserOrAssistantMessage,
    onLine(line) {
      let content: unknown;
      try {
        content = JSON.parse(line)?.message?.content;
      } catch {
        return true;
      }
      if (typeof content === "string") return append(content);
      if (Array.isArray(content)) {
        for (const block of content) if (block?.type === "text" && typeof block.text === "string" && !append(block.text)) return false;
      }
      return true;
    },
  });
  return parts.join("\n");
}

/** Cache cost of a field: its text plus the characters of its unique words. */
function fieldChars(field: SearchField): number {
  let chars = field.text.length;
  for (const word of field.words) chars += word.length;
  return chars;
}

/** Evicts the least recently used entries until both the entry count and the character budget hold; the newest entry always stays. */
function trimCache(cache: Map<string, ContentCacheEntry>): void {
  let chars = 0;
  for (const entry of cache.values()) chars += entry.chars;
  for (const [key, entry] of cache) {
    if (cache.size <= 1 || (cache.size <= MAX_CONTENT_CACHE_ENTRIES && chars <= MAX_CONTENT_CACHE_CHARS)) break;
    cache.delete(key);
    chars -= entry.chars;
  }
}

function touchCacheEntry(cache: Map<string, ContentCacheEntry>, key: string, entry: ContentCacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
  trimCache(cache);
}

// shortcut: holds the extracted text of recent sessions in memory (bounded by
// MAX_CONTENT_CACHE_ENTRIES and MAX_CONTENT_CACHE_CHARS) and re-reads a whole
// file when it changes; move to an on-disk index if installs outgrow that.
export async function transcriptField(filePath: string, cache: Map<string, ContentCacheEntry>): Promise<SearchField | null> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    cache.delete(filePath);
    return null;
  }
  const version = `${stat.size}:${stat.mtimeMs}`;
  const cached = cache.get(filePath);
  if (cached?.version === version) {
    touchCacheEntry(cache, filePath, cached);
    return cached.field.catch(() => null);
  }
  const entry: ContentCacheEntry = {
    version,
    chars: 0,
    field: extractTranscriptText(filePath).then((text) => searchField(text, CONTENT_WEIGHT)),
  };
  touchCacheEntry(cache, filePath, entry);
  entry.field.then(
    (field) => {
      entry.chars = fieldChars(field);
      trimCache(cache);
    },
    // A failed read must not stay cached.
    () => { if (cache.get(filePath) === entry) cache.delete(filePath); },
  );
  return entry.field.catch(() => null);
}

/**
 * Yields matching session ids with their scores (titles outrank transcript
 * matches), one batch per group of scanned files, so callers can stream hits.
 * Every group yields, even with no hits: a caller stopping the iteration
 * (`return()` waits for the pending `next()`) then stops after that group.
 */
export async function* searchSessions(rawQuery: string): AsyncGenerator<Record<string, number>> {
  const query = compileSearchQuery(rawQuery);
  if (!query) return;
  const sessions = await listAllSessions();
  const cache = (globalThis.__ompSessionContentSearchCache ??= new Map());
  const listed = new Set(sessions.map((s) => s.path));
  for (const path of cache.keys()) if (!listed.has(path)) cache.delete(path);

  for (let i = 0; i < sessions.length; i += PARSE_CONCURRENCY) {
    const scores: Record<string, number> = {};
    await Promise.all(sessions.slice(i, i + PARSE_CONCURRENCY).map(async (session) => {
      const fields = [searchField(session.name ?? "", TITLE_WEIGHT), searchField(session.firstMessage, FIRST_MESSAGE_WEIGHT)];
      const content = await transcriptField(session.path, cache);
      if (content) fields.push(content);
      const score = scoreSearchFields(fields, query);
      if (score !== null) scores[session.id] = score;
    }));
    yield scores;
  }
}
