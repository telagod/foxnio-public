import { storageRequest, storageRoots } from "./storage/client";
import { StorageError, type DataSnapshot, type StorageResults, type StorageRoots } from "./storage/protocol";
import { startSessionFileWatcher } from "./session-watcher";

interface IndexState {
  roots: StorageRoots;
  ready: boolean;
  stopped: boolean;
  full: boolean;
  force: boolean;
  paths: Set<string>;
  pending?: Promise<void>;
  timer?: NodeJS.Timeout;
  retryMs: number;
  reconcile?: NodeJS.Timeout;
  unwatch?: () => void;
  starting?: Promise<() => void>;
}
declare global {
  var __foxSessionIndex: IndexState | undefined;
  var __foxSessionIndexDirtyBeforeStart: boolean | undefined;
}

function state(): IndexState {
  let current = globalThis.__foxSessionIndex;
  if (!current || current.stopped) {
    const roots = storageRoots();
    current = {
      roots, ready: false, stopped: false, full: true,
      force: globalThis.__foxSessionIndexDirtyBeforeStart === true, paths: new Set(), retryMs: 1000,
    };
    globalThis.__foxSessionIndexDirtyBeforeStart = undefined;
    globalThis.__foxSessionIndex = current;
  }
  return current;
}
function halt(current: IndexState): void {
  current.stopped = true;
  clearTimeout(current.timer);
  clearInterval(current.reconcile);
  current.unwatch?.();
  current.timer = undefined;
  current.reconcile = undefined;
  current.unwatch = undefined;
}
function schedule(current: IndexState, delay = 0): void {
  if (current.stopped || current.timer || current.pending || (!current.ready && !current.starting) || (!current.full && current.paths.size === 0)) return;
  current.timer = setTimeout(() => {
    current.timer = undefined;
    void drain(current).catch(error => {
      console.error("[session-index] Native reconciliation failed:", error);
    });
  }, delay);
  current.timer.unref?.();
}
async function drain(current: IndexState): Promise<void> {
  if (current.pending) return current.pending;
  if (current.timer) { clearTimeout(current.timer); current.timer = undefined; }
  const work = async (): Promise<void> => {
    while (!current.stopped && (current.full || current.paths.size > 0)) {
      const paths = current.full ? undefined : [...current.paths];
      const force = current.force;
      current.full = false;
      current.force = false;
      current.paths.clear();
      let scanToken: string | undefined;
      try {
        do {
          const batch = await storageRequest({ operation: "index.scan", ...(scanToken ? { scanToken } : { paths, force }) }, current.roots);
          scanToken = batch.nextScanToken;
          // A completed scan can be incomplete because a native source is temporarily unreadable.
          // The committed health exposes this; periodic reconciliation retries it without spinning.
        } while (scanToken && !current.stopped);
        current.retryMs = 1000;
      } catch (error) {
        current.full = true;
        current.force ||= force;
        current.retryMs = Math.min(30_000, current.retryMs * 2);
        throw error;
      }
    }
    if (!current.stopped) current.ready = true;
  };
  const pending = work().finally(() => {
    if (current.pending === pending) current.pending = undefined;
    if (current.full || current.paths.size) schedule(current, current.retryMs);
  });
  current.pending = pending;
  return pending;
}

export async function ensureSessionIndex({ force = false }: { force?: boolean } = {}): Promise<void> {
  const current = state();
  if (force) { current.full = true; current.force = true; }
  await drain(current);
}

/** RPC-frame safe: only records dirtiness; native reads execute on the storage worker. */
export function invalidateSessionIndex(paths?: readonly string[]): void {
  const current = globalThis.__foxSessionIndex;
  if (!current || current.stopped) {
    globalThis.__foxSessionIndexDirtyBeforeStart = true;
    return;
  }
  current.force = true;
  if (!paths) current.full = true;
  else for (const path of paths) current.paths.add(path);
  schedule(current);
}

export async function readSessionIndex(ids?: readonly string[]): Promise<StorageResults["index.get"]> {
  const current = state();
  if (!current.ready) await drain(current);
  else schedule(current);
  return storageRequest({ operation: "index.get", ...(ids ? { ids: [...new Set(ids)] } : {}) }, current.roots);
}

export async function startSessionIndex(): Promise<() => void> {
  const current = state();
  if (current.starting) return current.starting;
  current.starting = (async () => {
    // Subscribe before the first inventory so writes during startup cannot fall in a gap.
    await storageRequest({ operation: "head" }, current.roots);
    if (current.stopped) return () => {};
    current.unwatch ??= startSessionFileWatcher(current.roots.sessionsDir);
    await drain(current);
    if (!current.stopped && !current.reconcile) {
      current.reconcile = setInterval(() => {
        current.full = true;
        schedule(current);
      }, 60_000);
      current.reconcile.unref?.();
    }
    return () => { halt(current); };
  })().catch(error => {
    current.starting = undefined;
    current.unwatch?.();
    current.unwatch = undefined;
    throw error;
  });
  return current.starting;
}

export async function stopSessionIndex(): Promise<void> {
  const current = globalThis.__foxSessionIndex;
  if (!current) return;
  halt(current);
  await current.pending?.catch(() => {});
  if (globalThis.__foxSessionIndex === current) globalThis.__foxSessionIndex = undefined;
}

/** Publish only a complete set of pages pinned to the same SQLite read revision. */
export async function readDurableSnapshot(): Promise<DataSnapshot> {
  const current = state();
  if (!current.ready) await drain(current);
  else schedule(current);
  const first = await storageRequest({ operation: "snapshot.open" }, current.roots);
  try {
    const sessions = [...first.data.sessions];
    let next = first.next;
    while (next) {
      const page = await storageRequest({ operation: "snapshot.page", token: first.token }, current.roots);
      if (page.cursor.generation !== first.cursor.generation || page.cursor.revision !== first.cursor.revision) {
        throw new StorageError("reset_required", "Snapshot pages have inconsistent revisions");
      }
      sessions.push(...page.sessions);
      next = page.next;
    }
    return {
      cursor: first.cursor, complete: first.complete, staleSources: first.staleSources, warnings: first.warnings,
      data: { ...first.data, sessions },
    };
  } finally {
    await storageRequest({ operation: "snapshot.close", token: first.token }, current.roots);
  }
}
