import { readdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { comparableProjectPath } from "../comparable-path";
import type { SessionHeader } from "../types";
import { readSessionHeaderSync } from "./session-files";

export interface NativeSessionLink {
  file: string;
  header: SessionHeader;
}

type DirectoryHeaders = Map<string, NativeSessionLink[] | null>;

function directoryHeaders(directory: string, cache: DirectoryHeaders): NativeSessionLink[] | null {
  if (cache.has(directory)) return cache.get(directory)!;
  let entries: NativeSessionLink[] | null;
  try {
    entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .flatMap((entry) => {
        const file = join(directory, entry.name);
        const header = readSessionHeaderSync(file);
        return header ? [{ file, header }] : [];
      });
  } catch {
    entries = null;
  }
  cache.set(directory, entries);
  return entries;
}

function readLineage(file: string, header: SessionHeader | null, cache: DirectoryHeaders): NativeSessionLink[] | null {
  if (!file || !isAbsolute(file) || !header) return null;
  const cwd = comparableProjectPath(header.cwd);
  const entries: NativeSessionLink[] = [];
  const seen = new Set<string>();
  while (header) {
    if (seen.has(header.id) || entries.length >= 512 || comparableProjectPath(header.cwd) !== cwd) return null;
    seen.add(header.id);
    entries.push({ file, header });
    if (header.continuationOf === undefined) return entries;
    if (typeof header.continuationOf !== "string" || !header.continuationOf || typeof header.parentSession !== "string" || !header.parentSession) return null;
    let parent: NativeSessionLink | null;
    if (isAbsolute(header.parentSession)) {
      const source = readSessionHeaderSync(header.parentSession);
      parent = source ? { file: header.parentSession, header: source } : null;
    } else {
      if (header.parentSession !== header.continuationOf) return null;
      const matches = directoryHeaders(dirname(file), cache)?.filter((candidate) => candidate.header.id === header!.continuationOf);
      parent = matches?.length === 1 ? matches[0] : null;
    }
    if (!parent || parent.header.id !== header.continuationOf) return null;
    file = parent.file;
    header = parent.header;
  }
  return null;
}

export function nativeSessionLineage(file: string, header = readSessionHeaderSync(file)): NativeSessionLink[] | null {
  return readLineage(file, header, new Map());
}

function sameRoot(left: NativeSessionLink | undefined, right: NativeSessionLink | undefined): boolean {
  return Boolean(left && right && left.header.id === right.header.id && comparableProjectPath(left.file) === comparableProjectPath(right.file));
}

export function sameNativeConversation(left: string, right: string, leftHeader?: SessionHeader): boolean {
  const cache: DirectoryHeaders = new Map();
  return sameRoot(readLineage(left, leftHeader ?? readSessionHeaderSync(left), cache)?.at(-1), readLineage(right, readSessionHeaderSync(right), cache)?.at(-1));
}

export function nativeSessionFamily(file: string): string[] {
  const cache: DirectoryHeaders = new Map();
  const root = readLineage(file, readSessionHeaderSync(file), cache)?.at(-1);
  if (!root) throw new Error("The native session continuation chain is invalid or unavailable");
  const candidates = directoryHeaders(dirname(root.file), cache);
  if (!candidates) throw new Error("The native session directory is unavailable");
  return candidates.filter((candidate) => sameRoot(readLineage(candidate.file, candidate.header, cache)?.at(-1), root)).map((candidate) => candidate.file);
}
