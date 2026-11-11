import { createHash, randomUUID } from "crypto";
import { opendirSync, statSync, type Dir, type Stats } from "fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "path";
import { readSessionHeaderSync, scanSessionInfo, type OmpSessionInfo } from "../omp/session-files";
import { projectIdentityKey, sessionPathKey } from "../paths";
import { resolveProjectWithRegistry, type ProjectInfo } from "../project-resolution";
import type { SessionInfo } from "../types";
import { StorageError, type DataHealth, type IndexedSource, type IndexSource, type IndexScanRequest, type NativeScanResult, type StorageRoots } from "./protocol";

type Source = IndexSource;
type SourceVersion = Pick<Source, "path" | "stamp">;
type Candidate = { session: SessionInfo; parent?: string; physical: string; stamp: string };
type Directory = { path: string; directory: Dir; version: string };
interface Scan {
  token: string;
  root: string;
  full: boolean;
  force: boolean;
  initial: Map<string, SourceVersion>;
  observed: Map<string, string | null>;
  files: string[];
  seen: Set<string>;
  stale: Set<string>;
  warnings: Set<string>;
  rootDirectory?: Directory;
  projectDirectory?: Directory;
  inventoryDone: boolean;
  inventoryFailed: boolean;
  offset: number;
  candidates: Map<string, Candidate>;
  projects: Map<string, Promise<ProjectInfo>>;
  phase: "inventory" | "scan" | "links" | "remove";
  links?: string[];
  parentPaths?: Map<string, string>;
  parentIds?: Set<string>;
  removals?: SourceVersion[];
  touchedAt: number;
}

const BATCH_SIZE = 64;
const scans = new Map<string, Scan>();
const MAX_SCANS = 4;
const IDLE_MS = 120_000;

function physicalVersion(stat: Stats): string {
  return `1:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}
function sourceVersion(physical: string, session: SessionInfo, parent?: string): string {
  const value = [session.path, session.id, session.cwd, session.name, session.created, session.modified,
    session.lastMessageAt, session.messageCount, session.firstMessage, session.parentSessionId,
    session.projectRoot, session.projectKey, session.worktreeBranch, parent];
  return `${physical}|${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "source_unreadable";
}
function closeDirectory(directory?: Directory): void {
  try { directory?.directory.closeSync(); } catch { /* Already closed on failure. */ }
}
function dispose(scan: Scan): void {
  closeDirectory(scan.rootDirectory);
  closeDirectory(scan.projectDirectory);
  scans.delete(scan.token);
}
function sourcePath(path: string, root: string): boolean {
  const rel = relative(root, path);
  return !isAbsolute(rel) && !rel.startsWith(`..${sep}`) && rel !== ".." && rel.split(sep).length === 2 && extname(path) === ".jsonl";
}
function openDirectory(path: string): Directory {
  const stat = statSync(path);
  if (!stat.isDirectory()) throw Object.assign(new Error("Not a directory"), { code: "ENOTDIR" });
  return { path, directory: opendirSync(path), version: physicalVersion(stat) };
}
function finishDirectory(scan: Scan, directory: Directory): void {
  closeDirectory(directory);
  try {
    if (physicalVersion(statSync(directory.path)) !== directory.version) {
      scan.inventoryFailed = true;
      scan.stale.add(directory.path);
      scan.warnings.add(`Directory changed during inventory: ${directory.path}`);
    }
  } catch (error) { failDirectory(scan, directory.path, error); }
}
function failDirectory(scan: Scan, path: string, error: unknown): void {
  scan.inventoryFailed = true;
  scan.stale.add(path);
  scan.warnings.add(`${errorCode(error)}: ${path}`);
}

/** Enumerate at most 64 directory entries per job, never an unbounded readdir. */
function inventoryBatch(scan: Scan): void {
  for (let count = 0; count < BATCH_SIZE && !scan.inventoryDone; count++) {
    const current = scan.projectDirectory ?? scan.rootDirectory;
    if (!current) { scan.inventoryDone = true; break; }
    try {
      const entry = current.directory.readSync();
      if (!entry) {
        finishDirectory(scan, current);
        if (scan.projectDirectory) scan.projectDirectory = undefined;
        else { scan.rootDirectory = undefined; scan.inventoryDone = true; }
        continue;
      }
      if (scan.projectDirectory) {
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const path = join(current.path, entry.name);
          scan.files.push(path);
          scan.seen.add(sessionPathKey(path));
        }
      } else if (entry.isDirectory()) {
        const path = join(current.path, entry.name);
        try { scan.projectDirectory = openDirectory(path); }
        catch (error) { failDirectory(scan, path, error); }
      }
    } catch (error) {
      failDirectory(scan, current.path, error);
      closeDirectory(current);
      if (scan.projectDirectory) scan.projectDirectory = undefined;
      else { scan.rootDirectory = undefined; scan.inventoryDone = true; }
    }
  }
  if (scan.inventoryDone) scan.phase = "scan";
}

function toSessionInfo(info: OmpSessionInfo, project?: ProjectInfo): SessionInfo {
  return {
    path: info.path, id: info.id, cwd: info.cwd,
    ...(info.title !== undefined ? { name: info.title } : {}),
    created: Number.isNaN(info.created.getTime()) ? info.modified.toISOString() : info.created.toISOString(),
    modified: info.modified.toISOString(),
    ...(info.lastMessageAt ? { lastMessageAt: info.lastMessageAt.toISOString() } : {}),
    messageCount: info.messageCount,
    firstMessage: info.firstMessage || "(no messages)",
    projectRoot: project?.projectRoot ?? info.cwd,
    projectKey: projectIdentityKey(project?.projectRoot ?? info.cwd),
    ...(project?.isWorktree && project.branch ? { worktreeBranch: project.branch } : {}),
  };
}

function startScan(request: IndexScanRequest, roots: StorageRoots, sources: Source[], health: DataHealth): Scan {
  const root = resolve(roots.sessionsDir);
  // A new reconciliation supersedes an abandoned/conflicted run for this worker root.
  for (const active of scans.values()) if (active.root === root || Date.now() - active.touchedAt > IDLE_MS) dispose(active);
  if (scans.size >= MAX_SCANS) throw new StorageError("storage_busy", "Native inventory capacity is exhausted");
  const initial = new Map(sources.map(({ path, stamp }) => [sessionPathKey(path), { path, stamp }]));
  const full = request.paths === undefined;
  const scan: Scan = {
    token: randomUUID(), root, full, force: request.force === true, initial,
    observed: new Map(sources.map(source => [source.path, source.stamp])),
    files: full ? [] : [...new Set(request.paths!.map(path => resolve(path)))].filter(path => sourcePath(path, root)),
    seen: new Set(), stale: new Set([...(full ? [] : health.staleSources), ...sources.filter(source => source.error).map(source => source.path)]),
    warnings: new Set(full ? [] : health.warnings), inventoryDone: !full,
    inventoryFailed: !full && !health.complete && health.staleSources.length === 0, offset: 0,
    candidates: new Map(), projects: new Map(), phase: full ? "inventory" : "scan", touchedAt: Date.now(),
  };
  if (full) {
    try { scan.rootDirectory = openDirectory(root); }
    catch (error) {
      if (errorCode(error) !== "ENOENT" || sources.length !== 0) failDirectory(scan, root, error);
      scan.inventoryDone = true;
      scan.phase = "scan";
    }
  }
  scans.set(scan.token, scan);
  return scan;
}

/** Worker-only ingestion. SQL and compare-and-set commits belong to the engine. */
export async function scanNativeIndexBatch(
  request: IndexScanRequest,
  roots: StorageRoots,
  registeredProjects: readonly { path: string }[],
  sources: Source[],
  health: DataHealth = { complete: true, staleSources: [], warnings: [] },
): Promise<NativeScanResult> {
  const scan = request.scanToken ? scans.get(request.scanToken) : startScan(request, roots, sources, health);
  if (!scan || scan.root !== resolve(roots.sessionsDir) || Date.now() - scan.touchedAt > IDLE_MS) {
    if (scan) dispose(scan);
    throw new StorageError("reset_required", "Native inventory expired; restart reconciliation");
  }
  scan.touchedAt = Date.now();
  const updates: IndexedSource[] = [];
  const expectedSources: Record<string, string | null> = {};
  const current = new Map(sources.map(source => [sessionPathKey(source.path), source]));

  if (scan.phase === "inventory") {
    inventoryBatch(scan);
  } else if (scan.phase === "scan") {
    const end = Math.min(scan.files.length, scan.offset + BATCH_SIZE);
    const started = Date.now();
    const scanFile = async (path: string): Promise<void> => {
      const key = sessionPathKey(path);
      const previous = current.get(key);
      let physical = previous?.stamp.split("|")[0] ?? "unavailable";
      expectedSources[path] = previous?.stamp ?? null;
      try {
        const before = statSync(path);
        if (!before.isFile()) throw Object.assign(new Error("Not a session file"), { code: "source_not_file" });
        physical = physicalVersion(before);
        const header = readSessionHeaderSync(path);
        if (!header || typeof header.id !== "string" || !header.id) throw Object.assign(new Error("Malformed session header"), { code: "source_malformed" });
        let session: SessionInfo;
        if (!scan.force && !previous?.error && previous?.payload && previous.stamp.split("|")[0] === physical && previous.payload.id === header.id) {
          session = { ...previous.payload };
        } else {
          const info = scanSessionInfo(path, true, before);
          if (!info || info.id !== header.id) throw Object.assign(new Error("Malformed session metadata"), { code: "source_malformed" });
          session = toSessionInfo(info);
          // Keep the last relationship until the bounded link phase has a full identity set.
          if (previous?.payload?.parentSessionId) session.parentSessionId = previous.payload.parentSessionId;
        }
        if (!scan.projects.has(session.cwd)) scan.projects.set(session.cwd, resolveProjectWithRegistry(session.cwd, registeredProjects));
        const project = await scan.projects.get(session.cwd)!;
        session.projectRoot = project.projectRoot;
        session.projectKey = projectIdentityKey(project.projectRoot);
        delete session.worktreeBranch;
        if (project.isWorktree && project.branch) session.worktreeBranch = project.branch;
        if (physicalVersion(statSync(path)) !== physical) throw Object.assign(new Error("Source changed during scan"), { code: "source_changed" });
        const stamp = sourceVersion(physical, session, header.parentSession);
        scan.observed.set(path, stamp);
        scan.candidates.set(key, { session, parent: header.parentSession, physical, stamp });
        scan.stale.delete(path);
        if (previous?.stamp !== stamp || previous.error) updates.push({ path, stamp, session });
      } catch (error) {
        scan.stale.add(path);
        // Error versions also distinguish failure from an equal-stamp recovery.
        const code = errorCode(error);
        const stamp = `${physical}|error:${code}`;
        scan.observed.set(path, stamp);
        if (previous?.stamp !== stamp || previous.error !== code) updates.push({ path, stamp, error: code });
      }
    };
    while (scan.offset < end) {
      const stop = Math.min(end, scan.offset + 6);
      const pending: Promise<void>[] = [];
      for (; scan.offset < stop; scan.offset++) pending.push(scanFile(scan.files[scan.offset]));
      await Promise.all(pending);
      if (Date.now() - started >= 250) break;
    }
    if (scan.offset === scan.files.length) {
      scan.phase = "links";
      scan.offset = 0;
      scan.links = [...scan.candidates.keys()];
      const parentSources = [...current.values()].filter(source => source.payload && (!scan.full || scan.inventoryFailed || scan.seen.has(sessionPathKey(source.path))));
      scan.parentPaths = new Map(parentSources.map(source => [sessionPathKey(source.path), source.payload!.id]));
      for (const [key, candidate] of scan.candidates) scan.parentPaths.set(key, candidate.session.id);
      scan.parentIds = new Set(scan.parentPaths.values());
    }
  } else if (scan.phase === "links") {
    const end = Math.min(scan.links!.length, scan.offset + BATCH_SIZE);
    for (; scan.offset < end; scan.offset++) {
      const candidate = scan.candidates.get(scan.links![scan.offset])!;
      const { session, parent, physical, stamp } = candidate;
      const parentId = parent ? scan.parentPaths!.get(sessionPathKey(parent)) ?? (scan.parentIds!.has(parent) ? parent : undefined) : undefined;
      if (session.parentSessionId === parentId) continue;
      const next = { ...session };
      if (parentId) next.parentSessionId = parentId;
      else delete next.parentSessionId;
      expectedSources[session.path] = stamp;
      const nextStamp = sourceVersion(physical, next, parent);
      scan.observed.set(session.path, nextStamp);
      updates.push({ path: session.path, stamp: nextStamp, session: next });
    }
  }

  let removedPaths: string[] | undefined;
  if (scan.phase === "links" && scan.offset === scan.links!.length) {
    scan.removals = scan.full && !scan.inventoryFailed
      ? [...scan.initial].filter(([key]) => !scan.seen.has(key)).map(([, source]) => source)
      : [];
    scan.phase = "remove";
    scan.offset = 0;
  }
  if (scan.phase === "remove" && updates.length === 0) {
    removedPaths = [];
    const end = Math.min(scan.removals!.length, scan.offset + BATCH_SIZE);
    for (; scan.offset < end; scan.offset++) {
      const source = scan.removals![scan.offset];
      removedPaths.push(source.path);
      scan.stale.delete(source.path);
      scan.observed.set(source.path, null);
      expectedSources[source.path] = source.stamp;
    }
  }
  const done = scan.phase === "remove" && scan.offset === scan.removals!.length;
  if (done) {
    for (const [path, stamp] of scan.observed) {
      if (!Object.hasOwn(expectedSources, path)) expectedSources[path] = stamp;
    }
  }
  const result: NativeScanResult = {
    updates, expectedSources,
    ...(removedPaths?.length ? { removedPaths } : {}),
    ...(!done ? { nextScanToken: scan.token } : {}),
    complete: done && !scan.inventoryFailed && scan.stale.size === 0,
    staleSources: [...scan.stale].sort(), warnings: [...scan.warnings].sort(),
  };
  if (done) dispose(scan);
  return result;
}
