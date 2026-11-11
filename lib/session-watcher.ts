import { watch, type FSWatcher } from "fs";
import { join, relative, sep } from "path";
import { invalidateSessionHistory } from "./session-history-queue";
import { ensureSessionIndex, invalidateSessionIndex, readSessionIndex } from "./session-index";
import { sessionPathKey } from "./paths";

type Listener = (sessionIds: string[]) => void;
interface WatchState {
  root: string;
  watcher?: FSWatcher;
  pendingPaths: Set<string>;
  pendingUnknown: boolean;
  flushTimer?: NodeJS.Timeout;
  retryTimer?: NodeJS.Timeout;
  closed: boolean;
}
declare global {
  var __foxSessionFileWatch: WatchState | undefined;
  var __foxSessionFileListeners: Set<Listener> | undefined;
}
const DEBOUNCE_MS = 250;
const RETRY_MS = 5000;
function listeners(): Set<Listener> {
  return globalThis.__foxSessionFileListeners ??= new Set();
}
function notify(ids: string[]): void {
  if (!ids.length) return;
  for (const listener of listeners()) {
    try { listener(ids); } catch { /* A subscriber cannot stop ingestion. */ }
  }
}
function flush(state: WatchState): void {
  state.flushTimer = undefined;
  if (state.closed) return;
  const paths = [...state.pendingPaths];
  const unknown = state.pendingUnknown;
  state.pendingPaths.clear();
  state.pendingUnknown = false;
  if (!paths.length && !unknown) return;
  if (unknown) {
    invalidateSessionHistory();
    invalidateSessionIndex();
    void ensureSessionIndex().then(() => readSessionIndex()).then(result => notify(result.sessions.map(session => session.id))).catch(reportError);
  } else {
    const changed = new Set(paths.map(path => sessionPathKey(path)));
    for (const path of paths) invalidateSessionHistory(path);
    invalidateSessionIndex(paths);
    void ensureSessionIndex().then(() => readSessionIndex()).then(result => {
      notify(result.sessions.filter(session => changed.has(sessionPathKey(session.path))).map(session => session.id));
    }).catch(reportError);
  }
}
function reportError(error: unknown): void {
  console.error("[session-watcher] Native session refresh failed:", error);
}
function scheduleRetry(state: WatchState): void {
  if (state.closed || state.retryTimer) return;
  state.retryTimer = setTimeout(() => { state.retryTimer = undefined; attach(state); }, RETRY_MS);
  state.retryTimer.unref?.();
}
function queueFlush(state: WatchState): void {
  if (!state.flushTimer) {
    state.flushTimer = setTimeout(() => flush(state), DEBOUNCE_MS);
    state.flushTimer.unref?.();
  }
}
function attach(state: WatchState): void {
  if (state.closed || state.watcher) return;
  try {
    state.watcher = watch(state.root, { recursive: true, persistent: false }, (event, filename) => {
      if (!filename) state.pendingUnknown = true;
      else {
        const path = join(state.root, filename.toString());
        const parts = relative(state.root, path).split(sep);
        if (parts.length === 2 && parts[1].endsWith(".jsonl")) state.pendingPaths.add(path);
        else if (parts.length === 1 && event === "rename") state.pendingUnknown = true;
        else return; // Native artifact transcripts are not session inventory.
        if (event === "rename") state.pendingUnknown = true; // Only inventory can prove deletion.
      }
      queueFlush(state);
    });
    state.watcher.on("error", () => {
      state.watcher?.close();
      state.watcher = undefined;
      state.pendingUnknown = true;
      queueFlush(state);
      scheduleRetry(state);
    });
  } catch { scheduleRetry(state); }
}

/** Owned by server startup, not by browser subscription reference counts. */
export function startSessionFileWatcher(root: string): () => void {
  const previous = globalThis.__foxSessionFileWatch;
  if (previous && !previous.closed && previous.root === root) return () => stop(previous);
  if (previous) stop(previous);
  const state: WatchState = { root, pendingPaths: new Set(), pendingUnknown: false, closed: false };
  globalThis.__foxSessionFileWatch = state;
  attach(state);
  return () => stop(state);
}
function stop(state: WatchState): void {
  state.closed = true;
  clearTimeout(state.flushTimer);
  clearTimeout(state.retryTimer);
  state.watcher?.close();
  state.pendingPaths.clear();
  if (globalThis.__foxSessionFileWatch === state) globalThis.__foxSessionFileWatch = undefined;
}
export function subscribeSessionFileChanges(listener: Listener): () => void {
  listeners().add(listener);
  return () => { listeners().delete(listener); };
}
