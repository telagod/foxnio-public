import { open, readdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

/** Strict authority reader. Display/history readers intentionally tolerate damaged
 * lines; permission recovery must not silently skip a revoke or admission. Uses
 * bounded asynchronous reads so a large journal cannot monopolize the host. */
type Entry = Record<string, unknown>;
type Header = Entry & { id: string; cwd: string };
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_FAMILY_BYTES = 256 * 1024 * 1024;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_SIBLINGS = 4096;
const MAX_FAMILY = 512;

function record(value: unknown): value is Entry {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function parse(line: string): Entry {
  const value: unknown = JSON.parse(line);
  if (!record(value) || typeof value.type !== "string") throw new Error("Malformed native goal journal entry");
  return value;
}
async function readHeader(file: string): Promise<Header> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const lines = buffer.toString("utf8", 0, bytesRead).split("\n");
    for (let i = 0; i < Math.min(2, lines.length - 1); i++) {
      const value = parse(lines[i]);
      if (value.type === "session" && typeof value.id === "string" && value.id && typeof value.cwd === "string" && isAbsolute(value.cwd)) return value as Header;
      if (i !== 0 || value.type !== "title") break;
    }
    throw new Error(`Native goal journal header is invalid: ${file}`);
  } finally { await handle.close(); }
}
async function readEntries(file: string): Promise<Entry[]> {
  const before = await stat(file);
  if (!before.isFile() || before.size > MAX_FILE_BYTES) throw new Error("Native goal journal exceeds the safe read limit");
  const handle = await open(file, "r");
  const entries: Entry[] = [];
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let pending = Buffer.alloc(0);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (!bytesRead) throw new Error("Native goal journal changed during reading");
      offset += bytesRead;
      const buffer = pending.length ? Buffer.concat([pending, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
      let start = 0;
      for (let end = buffer.indexOf(10); end !== -1; end = buffer.indexOf(10, start)) {
        if (end - start > MAX_LINE_BYTES) throw new Error("Native goal journal line exceeds the safe read limit");
        const entry = parse(buffer.toString("utf8", start, end));
        if (entry.type !== "session" && entry.type !== "title") {
          if (typeof entry.id !== "string" || !entry.id) throw new Error("Native goal journal entry has no identity");
          entries.push(entry);
        }
        start = end + 1;
      }
      if (buffer.length - start > MAX_LINE_BYTES) throw new Error("Native goal journal line exceeds the safe read limit");
      pending = Buffer.from(buffer.subarray(start));
    }
    if (pending.length) throw new Error("Native goal journal has an incomplete final record");
    const after = await handle.stat();
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("Native goal journal changed during reading");
    return entries;
  } finally { await handle.close(); }
}

export async function readFoxGoalJournal(file: string): Promise<{
  entries: Entry[]; currentEntries: Entry[]; files: string[]; sessionId: string; sessionIds: string[];
  ignoredEntryIds: string[]; inheritedGoalIds: string[];
}> {
  if (!isAbsolute(file)) throw new Error("Native goal journal requires an absolute session file");
  const currentFile = await realpath(file);
  const directory = dirname(currentFile);
  const names = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.name.endsWith(".jsonl"));
  if (names.length > MAX_SIBLINGS) throw new Error("Native goal session family cannot be completely verified within safe limits");
  const headers = new Map<string, { file: string; header: Header }>();
  for (const name of names) {
    if (!name.isFile()) throw new Error("Native goal session family contains an unverified file link");
    const path = join(directory, name.name);
    const header = await readHeader(path);
    if (headers.has(header.id)) throw new Error("Native goal session family has ambiguous session identity");
    headers.set(header.id, { file: path, header });
  }
  const current = [...headers.values()].find((entry) => entry.file === currentFile);
  if (!current) throw new Error("Native goal session is missing from its family");
  function root(value: typeof current): string {
    const seen = new Set<string>();
    while (value) {
      const { header } = value;
      if (seen.has(header.id) || seen.size >= MAX_FAMILY) throw new Error("Native goal continuation chain is cyclic or oversized");
      seen.add(header.id);
      if (header.continuationOf === undefined) return header.id;
      if (typeof header.continuationOf !== "string" || !header.continuationOf || typeof header.parentSession !== "string") throw new Error("Native goal continuation metadata is incomplete");
      const parent = headers.get(header.continuationOf);
      if (!parent || parent.header.cwd !== header.cwd || (header.parentSession !== parent.header.id && header.parentSession !== parent.file)) throw new Error("Native goal continuation parent cannot be verified");
      value = parent;
    }
    throw new Error("Native goal continuation root is missing");
  }
  const rootId = root(current);
  const family = [...headers.values()].filter((entry) => entry.header.cwd === current.header.cwd && root(entry) === rootId);
  if (family.length > MAX_FAMILY) throw new Error("Native goal session family exceeds the safe read limit");
  let bytes = 0;
  const entries: Entry[] = [];
  let currentEntries: Entry[] = [];
  const versions = new Map<string, string>();
  const loaded = new Map<string, Entry[]>();
  const version = (value: { ino: number; size: number; mtimeMs: number; ctimeMs: number }) => `${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
  for (const item of family) {
    const before = await stat(item.file);
    bytes += before.size;
    versions.set(item.file, version(before));
    if (bytes > MAX_FAMILY_BYTES) throw new Error("Native goal session family exceeds the safe read limit");
    const values = await readEntries(item.file);
    loaded.set(item.file, values);
    for (const entry of values) entries.push(entry);
    if (item.file === currentFile) currentEntries = values;
  }
  const ignored = new Set<string>();
  const inheritedGoals = new Set<string>();
  const familyRoot = headers.get(rootId)!;
  const parentRef = familyRoot.header.parentSession;
  if (typeof parentRef === "string") {
    const source = headers.get(parentRef) ?? [...headers.values()].find((entry) => entry.file === parentRef);
    if (source && source.header.cwd === familyRoot.header.cwd && source.header.id !== rootId) {
      const before = await stat(source.file);
      bytes += before.size;
      if (bytes > MAX_FAMILY_BYTES) throw new Error("Native fork ancestry exceeds the safe read limit");
      versions.set(source.file, version(before));
      const original = await readEntries(source.file);
      const originals = new Map(original.map((entry) => [entry.id, entry]));
      const rootEntries = loaded.get(familyRoot.file)!;
      let ownEntriesStarted = false;
      for (const entry of rootEntries) {
        const inherited = originals.get(entry.id);
        if (!inherited) { ownEntriesStarted = true; continue; }
        // Native fork copies the selected branch and drops activeLeafId, but
        // may not rewrite any authority-bearing entry or append a copy later.
        const sourceValue = { ...inherited };
        delete sourceValue.activeLeafId;
        if (ownEntriesStarted || entry.activeLeafId !== undefined || !isDeepStrictEqual(entry, sourceValue)) {
          throw new Error("Native fork copied prefix cannot be verified");
        }
        const type = String(entry.customType ?? "");
        const authority = entry.type === "mode_change" || type === "goal-completed"
          || type.startsWith("fox-goal") || type.startsWith("fox-worker-report");
        if (!authority) continue;
        ignored.add(String(entry.id));
        if (entry.type === "mode_change" && record(entry.data) && record(entry.data.goal) && typeof entry.data.goal.id === "string") {
          inheritedGoals.add(entry.data.goal.id);
        }
      }
      // Continuation copies of this fork may only carry the exact same
      // inherited records; do not let an altered copy evade namespace checks.
      for (const entry of entries) {
        if (!ignored.has(String(entry.id))) continue;
        const inherited = originals.get(entry.id)!;
        const sourceValue = { ...inherited };
        delete sourceValue.activeLeafId;
        if (!isDeepStrictEqual(entry, sourceValue)) throw new Error("Native fork authority differs across continuation copies");
      }
      if (versions.get(source.file) !== version(await stat(source.file)) || !isDeepStrictEqual(await readHeader(source.file), source.header)) {
        throw new Error("Native fork parent changed during reading");
      }
    }
  }
  for (const item of family) {
    if (versions.get(item.file) !== version(await stat(item.file)) || JSON.stringify(await readHeader(item.file)) !== JSON.stringify(item.header)) {
      throw new Error("Native goal session family changed during reading");
    }
  }
  const afterNames = (await readdir(directory)).filter((name) => name.endsWith(".jsonl")).sort();
  if (JSON.stringify(afterNames) !== JSON.stringify(names.map((entry) => entry.name).sort())) throw new Error("Native goal session family changed during reading");
  // Stable equal-timestamp ordering preserves each file's append order.
  entries.sort((a, b) => (Date.parse(String(a.timestamp)) || 0) - (Date.parse(String(b.timestamp)) || 0));
  return {
    entries: ignored.size ? entries.filter((entry) => !ignored.has(String(entry.id))) : entries,
    currentEntries, files: family.map((entry) => entry.file), sessionId: current.header.id,
    sessionIds: family.map((entry) => entry.header.id), ignoredEntryIds: [...ignored], inheritedGoalIds: [...inheritedGoals],
  };
}
