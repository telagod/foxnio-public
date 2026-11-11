"use client";

import { EVENT_STREAM_CLOSED, openEventStream, reconnectDelayMs } from "./event-stream";
import type { EventStream, EventStreamChannel } from "./event-stream";
import type { DataChange, DataCursor, DataSnapshot, DataTopic } from "./storage/protocol";
import { isRecord } from "./type-guards";

export interface DataStoreState {
  snapshot: DataSnapshot | null;
  status: "loading" | "ready" | "error";
  error: string | null;
}
export interface DataStore {
  retain(): void;
  release(): void;
  getSnapshot(): DataStoreState;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  subscribeTopics(topics: readonly DataTopic[], listener: () => void): () => void;
}
export interface DataStoreDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  openStream: (channel: EventStreamChannel) => EventStream;
  timers: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(timer: unknown): void };
  env: {
    isOnline(): boolean;
    onOnline(fn: () => void): () => void;
    onOffline(fn: () => void): () => void;
    onVisible(fn: () => void): () => void;
  };
}
const TOPICS: Record<DataTopic, true> = { sessions: true, projects: true, pins: true, "notification-history": true, "fox-pointer": true, "fox-observation": true, "fox-display": true, "operator-settings": true };
const INITIAL: DataStoreState = { snapshot: null, status: "loading", error: null };
function isDataCursor(value: unknown): value is DataCursor {
  return isRecord(value) && typeof value.generation === "string" && value.generation.length > 0 && value.generation.length <= 256
    && typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0;
}
function sameCursor(a: DataCursor, b: DataCursor): boolean {
  return a.generation === b.generation && a.revision === b.revision;
}
function parseSnapshot(value: unknown): DataSnapshot & { token: string; next: boolean } {
  if (!isRecord(value) || !isDataCursor(value.cursor) || typeof value.token !== "string" || !value.token || typeof value.next !== "boolean"
    || typeof value.complete !== "boolean" || !Array.isArray(value.staleSources) || !value.staleSources.every((item) => typeof item === "string")
    || !Array.isArray(value.warnings) || !value.warnings.every((item) => typeof item === "string") || !isRecord(value.data)
    || !Array.isArray(value.data.sessions) || !Array.isArray(value.data.projects) || !Array.isArray(value.data.pins)
    || !Array.isArray(value.data.notifications) || !isRecord(value.data.foxPointer) || !isRecord(value.data.foxObservation)
    || typeof value.data.foxWorkspace !== "string") throw new Error("Invalid durable snapshot");
  return value as unknown as DataSnapshot & { token: string; next: boolean };
}
function browserEnvironment(): DataStoreDeps["env"] {
  const listen = (host: EventTarget | undefined, event: string, fn: () => void) => {
    host?.addEventListener(event, fn);
    return () => host?.removeEventListener(event, fn);
  };
  return {
    isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
    onOnline: (fn) => listen(typeof window === "undefined" ? undefined : window, "online", fn),
    onOffline: (fn) => listen(typeof window === "undefined" ? undefined : window, "offline", fn),
    onVisible: (fn) => listen(typeof document === "undefined" ? undefined : document, "visibilitychange", () => { if (document.visibilityState === "visible") fn(); }),
  };
}

/** One durable clock. Live RPC state deliberately never enters this cache. */
export function createDataStore(overrides: Partial<DataStoreDeps> = {}): DataStore {
  const deps: DataStoreDeps = {
    fetch: overrides.fetch ?? ((url, init) => fetch(url, init)), openStream: overrides.openStream ?? openEventStream,
    timers: overrides.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout) },
    env: overrides.env ?? browserEnvironment(),
  };
  let state = INITIAL, retains = 0, epoch = 0;
  let head: DataCursor | null = null;
  // A server-rejected cursor loses ordering authority, not its last visible data.
  let authoritativeResnapshot = false;
  const retiredGenerations = new Set<string>();
  const listeners = new Set<() => void>();
  const topicListeners = new Set<{ topics: ReadonlySet<DataTopic>; listener: () => void }>();
  const cleanups: Array<() => void> = [];
  let stream: EventStream | null = null, reconnect: unknown, retry: unknown;
  let failures = 0, streamFailures = 0, requested = false;
  let active: Promise<void> | null = null, controller: AbortController | null = null;

  function publish(next: DataStoreState): void {
    if (state.snapshot === next.snapshot && state.status === next.status && state.error === next.error) return;
    state = next;
    for (const listener of listeners) listener();
  }
  function clearRetry(): void { if (retry !== undefined) deps.timers.clearTimeout(retry); retry = undefined; }
  function scheduleRetry(): void {
    if (retains === 0 || !deps.env.isOnline() || retry !== undefined) return;
    retry = deps.timers.setTimeout(() => { retry = undefined; void refresh(); }, reconnectDelayMs(failures++));
  }
  async function json(url: string, signal: AbortSignal): Promise<unknown> {
    const response = await deps.fetch(url, { cache: "no-store", signal });
    const body: unknown = await response.json();
    if (!response.ok) throw Object.assign(new Error(isRecord(body) && typeof body.error === "string" ? body.error : `HTTP ${response.status}`), { code: isRecord(body) ? body.code : undefined, status: response.status });
    return body;
  }
  async function changes(applied: DataCursor, signal: AbortSignal): Promise<{ topics: Set<DataTopic>; through: DataCursor } | null> {
    let cursor = applied, through: DataCursor | undefined;
    const topics = new Set<DataTopic>();
    for (;;) {
      const query = new URLSearchParams({ cursor: JSON.stringify(cursor) });
      if (through) query.set("through", JSON.stringify(through));
      const result = await json(`/api/data/changes?${query}`, signal);
      if (!isRecord(result) || !isDataCursor(result.cursor) || !isDataCursor(result.through) || !Array.isArray(result.changes) || typeof result.hasMore !== "boolean"
        || result.cursor.generation !== cursor.generation || result.through.generation !== cursor.generation
        || result.cursor.revision < cursor.revision || result.cursor.revision > result.through.revision
        || (through && !sameCursor(result.through, through))) throw new Error("Invalid durable changes");
      for (const item of result.changes as DataChange[]) {
        if (!isRecord(item) || !Number.isSafeInteger(item.revision) || item.revision <= cursor.revision || item.revision > result.cursor.revision
          || !Object.hasOwn(TOPICS, item.topic) || !Array.isArray(item.keys) || !item.keys.every((key) => typeof key === "string")) throw new Error("Invalid durable change");
        if (item.reset) return null;
        topics.add(item.topic);
      }
      if (!result.hasMore) return { topics, through: result.through };
      if (result.cursor.revision <= cursor.revision) throw new Error("Durable changes did not advance");
      cursor = result.cursor;
      through = result.through;
    }
  }
  async function readSnapshot(signal: AbortSignal): Promise<DataSnapshot> {
    let token: string | null = null;
    try {
      const raw = await json("/api/data/snapshot", signal);
      if (isRecord(raw) && typeof raw.token === "string") token = raw.token;
      const first = parseSnapshot(raw);
      let next = first.next;
      const sessions = [...first.data.sessions];
      while (next) {
        const page = await json(`/api/data/snapshot?token=${encodeURIComponent(first.token)}`, signal);
        if (!isRecord(page) || !isDataCursor(page.cursor) || !sameCursor(page.cursor, first.cursor)
          || !Array.isArray(page.sessions) || typeof page.next !== "boolean") throw new Error("Snapshot page revision mismatch");
        sessions.push(...page.sessions);
        next = page.next;
      }
      return { cursor: first.cursor, complete: first.complete, staleSources: first.staleSources, warnings: first.warnings, data: { ...first.data, sessions } };
    } finally {
      if (token) await deps.fetch(`/api/data/snapshot?token=${encodeURIComponent(token)}`, { method: "DELETE", keepalive: true, signal: AbortSignal.timeout(5_000) }).catch(() => {});
    }
  }
  function refresh(trailing = true): Promise<void> {
    clearRetry();
    if (active) { requested ||= trailing; return active; }
    requested = true;
    if (!deps.env.isOnline()) return Promise.resolve();
    let immediateCatchups = 0;
    let startedIn = epoch;
    const task = Promise.resolve().then(async () => {
      if (startedIn !== epoch) return;
      do {
        const headAtStart = head;
        requested = false;
        const applied = state.snapshot?.cursor;
        const ac = new AbortController(); controller = ac;
        const deadline = deps.timers.setTimeout(() => ac.abort(new Error("Durable data request timed out")), 15_000);
        try {
          let delta: { topics: Set<DataTopic>; through: DataCursor } | null = null;
          if (!authoritativeResnapshot && applied && (!head || head.generation === applied.generation)) {
            try { delta = await changes(applied, ac.signal); }
            catch (error) {
              if (startedIn !== epoch) return;
              if (!isRecord(error) || error.code !== "reset_required" || error.status !== 409) throw error;
              // Only an explicit HTTP cursor rejection authorizes revision rollback.
              // Retire the old stream: queued pre-restore hints cannot re-establish
              // the rejected high-water mark during or after this replacement.
              authoritativeResnapshot = true;
              startedIn = ++epoch;
              head = null;
              const retired = stream;
              stream = null;
              retired?.close();
              if (reconnect !== undefined) deps.timers.clearTimeout(reconnect);
              reconnect = undefined;
            }
          }
          if (startedIn !== epoch) return;
          const resetting = authoritativeResnapshot;
          const next = await readSnapshot(ac.signal);
          if (startedIn !== epoch) return;
          if (ac.signal.aborted) throw ac.signal.reason;
          const wrongGeneration = head && next.cursor.generation !== head.generation;
          const behind = head && next.cursor.generation === head.generation && next.cursor.revision < head.revision;
          if (!resetting && (retiredGenerations.has(next.cursor.generation) || behind || (wrongGeneration && head !== headAtStart))) {
            if (head !== headAtStart && immediateCatchups++ === 0) { requested = true; continue; }
            throw new Error("Durable snapshot is behind the announced head");
          }
          if (wrongGeneration && head) retiredGenerations.add(head.generation);
          if (!resetting && applied && sameCursor(applied, next.cursor) && state.snapshot) {
            const recovered = state.status !== "ready";
            publish({ ...state, status: "ready", error: null });
            if (recovered) for (const subscription of topicListeners) subscription.listener();
          } else if (resetting || !applied || applied.generation !== next.cursor.generation || next.cursor.revision >= applied.revision) {
            head = next.cursor;
            if (resetting) retiredGenerations.delete(next.cursor.generation);
            if (resetting && applied && applied.generation !== next.cursor.generation) retiredGenerations.add(applied.generation);
            authoritativeResnapshot = false;
            publish({ snapshot: next, status: "ready", error: null });
            const changed = delta && sameCursor(delta.through, next.cursor) ? delta.topics : null;
            for (const subscription of topicListeners) if (!changed || [...subscription.topics].some((topic) => changed.has(topic))) subscription.listener();
          }
          failures = 0;
          clearRetry();
          if (resetting && retains > 0 && !stream) connect();
        } catch (error) {
          if (startedIn !== epoch) return;
          publish({ ...state, status: "error", error: error instanceof Error ? error.message : String(error) });
          if (!authoritativeResnapshot && head !== headAtStart && immediateCatchups++ === 0) { requested = true; continue; }
          requested = false;
          scheduleRetry();
          return;
        } finally {
          deps.timers.clearTimeout(deadline);
          if (controller === ac) controller = null;
        }
      } while (requested && startedIn === epoch && deps.env.isOnline());
    }).finally(() => { if (active === task) active = null; });
    active = task;
    return task;
  }
  function receive(raw: string): void {
    let frame: unknown;
    try { frame = JSON.parse(raw); } catch { return; }
    if (!isRecord(frame)) return;
    if (frame.type === "data-unavailable") {
      publish({ ...state, status: "error", error: typeof frame.message === "string" ? frame.message : "storage_unavailable" });
      scheduleRetry(); return;
    }
    if (frame.type !== "data-head" || !isDataCursor(frame.cursor) || retiredGenerations.has(frame.cursor.generation)) return;
    const next = frame.cursor;
    if (head?.generation === next.generation && head.revision > next.revision) return;
    if (head && sameCursor(head, next) && (active || retry !== undefined || state.status === "ready")) return;
    if (head && head.generation !== next.generation) retiredGenerations.add(head.generation);
    head = next;
    if (!state.snapshot || !sameCursor(state.snapshot.cursor, next) || state.status === "error") void refresh(false);
  }
  function connect(): void {
    reconnect = undefined;
    if (!retains) return;
    try {
      const opened = deps.openStream({ kind: "data" }); stream = opened;
      opened.onopen = () => { if (stream !== opened) return; streamFailures = 0; void refresh(); };
      opened.onmessage = (event) => { if (stream === opened) receive(event.data); };
      opened.onerror = () => {
        if (stream !== opened) return;
        publish({ ...state, status: "error", error: "Durable data stream disconnected" });
        if (opened.readyState !== EVENT_STREAM_CLOSED) return;
        stream = null;
        reconnect = deps.timers.setTimeout(connect, reconnectDelayMs(streamFailures++));
      };
    } catch (error) {
      publish({ ...state, status: "error", error: error instanceof Error ? error.message : String(error) });
      scheduleRetry();
      reconnect = deps.timers.setTimeout(connect, reconnectDelayMs(streamFailures++));
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    subscribeTopics(topics, listener) { const entry = { topics: new Set(topics), listener }; topicListeners.add(entry); return () => { topicListeners.delete(entry); }; },
    refresh,
    retain() {
      if (++retains !== 1) return;
      cleanups.push(deps.env.onOnline(() => { void refresh(); }), deps.env.onVisible(() => { void refresh(); }), deps.env.onOffline(clearRetry));
      if (authoritativeResnapshot) void refresh();
      else connect();
    },
    release() {
      if (!retains || --retains) return;
      epoch++; requested = false; active = null;
      controller?.abort(); controller = null;
      clearRetry();
      if (reconnect !== undefined) deps.timers.clearTimeout(reconnect); reconnect = undefined;
      stream?.close(); stream = null;
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}
let singleton: DataStore | undefined;
export function getDataStore(): DataStore { return singleton ??= createDataStore(); }
/** Topic callbacks run only after a complete replacement has committed locally. */
export function subscribeDataTopics(topics: readonly DataTopic[], listener: () => void): () => void {
  const store = getDataStore();
  const unsubscribe = store.subscribeTopics(topics, listener);
  store.retain();
  return () => { unsubscribe(); store.release(); };
}
