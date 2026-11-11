import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createSessionStore, computeRecentlyCompleted, selectSession, selectWithCache, shallowEqualSet, UNREAD_SESSIONS_STORAGE_KEY } = await jiti.import("./session-store.ts");
const { createDataStore } = await jiti.import("./data-store.ts");
const { subscribeSessionsChanged } = await jiti.import("./session-change-bus.ts");
const session = (id, extra = {}) => ({ id, path: `/sessions/${id}.jsonl`, cwd: "/work/a", projectRoot: "/work/a", created: "2026-01-01T00:00:00Z", modified: "2026-01-02T00:00:00Z", firstMessage: "hello", messageCount: 2, ...extra });
const settle = () => new Promise((resolve) => setImmediate(resolve));
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function harness() {
  const server = { revision: 1, sessions: [session("a"), session("b")], projects: [], pins: [], fail: false };
  const calls = [], streams = [], jobs = new Map(), data = new Map();
  let sequence = 0, write = null;
  const storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: (key) => data.delete(key) };
  const timers = { setTimeout(fn, ms) { const id = ++sequence; jobs.set(id, { fn, ms }); return id; }, clearTimeout(id) { jobs.delete(id); } };
  const openStream = (channel) => { const stream = { channel, onopen: null, onmessage: null, onerror: null, readyState: 1, close() { this.closed = true; }, send(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); } }; streams.push(stream); return stream; };
  const fetch = async (path, init = {}) => {
    const url = new URL(path, "http://test"); calls.push([init.method ?? "GET", url.pathname]);
    if (url.pathname === "/api/session-ui") {
      assert.equal(init.method, "PATCH");
      if (write) return write(JSON.parse(init.body));
      const body = JSON.parse(init.body);
      server.pins = server.pins.filter((entry) => !body.unpin?.includes(entry.id));
      for (const id of body.pin ?? []) server.pins.unshift({ id, at: 1 });
      server.revision++; return response({ pinned: server.pins });
    }
    assert.ok(url.pathname.startsWith("/api/data/"), "no legacy persistent GET");
    if (init.method === "DELETE") return response({ ok: true });
    if (server.fail) return response({ error: "storage offline", code: "storage_unavailable" }, 503);
    const cursor = { generation: "one", revision: server.revision };
    if (url.pathname.endsWith("changes")) return response({ cursor, through: cursor, changes: [], hasMore: false });
    return response({ token: "reader", next: false, cursor, complete: true, staleSources: [], warnings: [], data: { sessions: server.sessions, projects: server.projects, pins: server.pins, notifications: [], foxPointer: { sessionId: null, resetAt: null }, foxObservation: {}, foxWorkspace: "/custom/fox" } });
  };
  const durable = createDataStore({ fetch, openStream, timers, env: { isOnline: () => true, onOnline: () => () => {}, onOffline: () => () => {}, onVisible: () => () => {} } });
  const store = createSessionStore({ dataStore: durable, fetch, openStream, timers, storage, now: () => 1000, env: { onVisibilityChange: () => () => {}, onOnline: () => () => {}, onPageHide: () => () => {} } });
  return { server, store, calls, jobs, data, streams, durable,
    async start() { store.retain(); streams.forEach((stream) => stream.onopen?.()); await settle(); },
    async changed() { server.revision++; streams.find((stream) => stream.channel.kind === "data").send({ type: "data-head", cursor: { generation: "one", revision: server.revision } }); await settle(); },
    running(ids, extra = {}) { streams.find((stream) => stream.channel.kind === "running").send({ type: "running", runningSessionIds: ids, runningSessions: ids.map((id) => ({ id, cwd: "/work/a" })), ...extra }); },
    write(fn) { write = fn; },
  };
}

test("sessions, discovered projects and pins share one durable snapshot; FOX and hidden projects stay excluded", async () => {
  const h = harness();
  h.server.projects = [{ path: "/work/hidden", hidden: true, addedAt: "2026-01-01" }, { path: "/empty", hidden: false, addedAt: "2026-01-02", alias: "Empty" }];
  h.server.sessions.push(session("hidden", { cwd: "/work/hidden", projectRoot: "/work/hidden" }), session("fox", { cwd: "/custom/fox", projectRoot: "/custom/fox" }));
  h.server.pins = [{ id: "a", at: 1 }];
  await h.start();
  const state = h.store.getSnapshot();
  assert.equal(state.sessionsStatus, "ready"); assert.equal(state.sessions.length, 4);
  assert.deepEqual(state.projects.map((project) => project.path), ["/empty", "/work/a"]);
  assert.deepEqual(state.pinnedSessionIds, ["a"]); assert.deepEqual([...state.running], []);
  h.store.release();
});

test("durable updates retain unchanged object identities and never overwrite live running state", async () => {
  const h = harness(); await h.start(); const before = h.store.getSnapshot();
  h.running(["b"]); h.server.sessions = [session("a"), session("b", { name: "renamed" })]; await h.changed();
  const next = h.store.getSnapshot(); assert.equal(next.sessions[0], before.sessions[0]); assert.equal(next.sessions[1].name, "renamed");
  assert.deepEqual([...next.running], ["b"]); assert.equal(next.runningCwd.get("b"), "/work/a");
  h.server.fail = true; await h.store.refresh(); assert.equal(h.store.getSnapshot().sessions, next.sessions); assert.equal(h.store.getSnapshot().sessionsStatus, "error"); h.store.release();
});

test("live-only frames update unread/recent/exited state without duplicate durable fetches", async () => {
  const h = harness(); await h.start(); const before = h.calls.length;
  h.store.setViewedSession("b"); h.running(["a", "b"]); h.running([], { exitedSessions: [{ id: "a", cwd: "/work/a", at: 1, code: 1, signal: null, detail: "boom" }] }); await settle();
  let state = h.store.getSnapshot(); assert.deepEqual([...state.unread], ["a"]); assert.ok(state.recentlyCompleted.has("a")); assert.ok(state.exited.has("a")); assert.equal(h.calls.length, before);
  h.running(["a"]); state = h.store.getSnapshot(); assert.equal(state.unread.has("a"), false); assert.equal(state.recentlyCompleted.has("a"), false);
  h.running([]); h.store.release(); assert.deepEqual(JSON.parse(h.data.get(UNREAD_SESSIONS_STORAGE_KEY)), ["a"]);
});

test("session file hints still heal transcript readers without fetching legacy session deltas", async () => {
  const h = harness(); await h.start(); const seen = [], stop = subscribeSessionsChanged((ids) => seen.push(ids)); const before = h.calls.length;
  h.streams.find((stream) => stream.channel.kind === "running").send({ type: "sessions-changed", sessionIds: ["a"], refreshSessionList: true });
  await settle(); assert.deepEqual(seen, [["a"]]); assert.equal(h.calls.length, before); stop(); h.store.release();
});

test("optimistic sessions stay separate and removed rows lose pins and navigation state", async () => {
  const h = harness(); h.server.pins = [{ id: "a", at: 1 }]; await h.start();
  h.store.applyOptimisticSession(session("draft", { path: "", cwd: "/new" }));
  assert.equal(h.store.getSession("draft"), undefined); assert.equal(h.store.getSnapshot().runningCwd.get("draft"), "/new");
  h.store.clearOptimisticSession("other"); assert.equal(h.store.getSnapshot().optimisticSession.id, "draft");
  h.running(["a"]); h.running([]); h.server.sessions = h.server.sessions.filter((item) => item.id !== "a"); h.server.revision++;
  h.store.removeSession("a"); await settle();
  assert.equal(h.store.getSession("a"), undefined); assert.equal(h.store.getSnapshot().unread.has("a"), false); assert.deepEqual(h.store.getSnapshot().pinnedSessionIds, []); h.store.release();
});

test("pin mutations are optimistic, serialized and roll back only the failed operation", async () => {
  const h = harness(); await h.start(); const first = deferred(); let writes = 0;
  h.write(async () => {
    writes++; if (writes === 1) return first.promise;
    h.server.pins = [{ id: "b", at: 2 }]; h.server.revision++;
    return response({ pinned: h.server.pins });
  });
  const a = h.store.pin("a"), b = h.store.pin("b");
  assert.deepEqual(h.store.getSnapshot().pinnedSessionIds, ["b", "a"]); await settle(); assert.equal(writes, 1);
  first.resolve(response({}, 503)); assert.equal(await a, false); assert.equal(await b, true);
  assert.deepEqual(h.store.getSnapshot().pinnedSessionIds, ["b"]); h.store.release();
});

test("a durable snapshot cannot erase a pin while its command is pending", async () => {
  const h = harness(); await h.start(); const pending = deferred(); h.write(() => pending.promise);
  const result = h.store.pin("a"); await h.changed(); assert.deepEqual(h.store.getSnapshot().pinnedSessionIds, ["a"]);
  h.server.pins = [{ id: "a", at: 2 }]; h.server.revision++; pending.resolve(response({ pinned: h.server.pins })); await result;
  await settle();
  assert.deepEqual(h.store.getSnapshot().pinnedSessionIds, ["a"]); h.store.release();
});

test("lookup refreshes a missing session once; refcounts close both streams on the last release", async () => {
  const h = harness(); await h.start(); h.store.retain();
  const before = h.calls.length; assert.equal((await h.store.ensureSession("a")).id, "a"); assert.equal(h.calls.length, before);
  h.server.sessions.push(session("c")); h.server.revision++;
  assert.equal((await h.store.ensureSession("c")).id, "c");
  h.store.release(); assert.ok(h.streams.every((stream) => !stream.closed)); h.store.release(); assert.ok(h.streams.every((stream) => stream.closed)); assert.equal(h.jobs.size, 0);
});

test("recent completion ranking excludes active/empty sessions and respects the limit", () => {
  const sessions = [session("a"), session("b", { modified: "2026-01-03T00:00:00Z" }), session("empty", { messageCount: 0, firstMessage: "(no messages)" })];
  assert.deepEqual([...computeRecentlyCompleted([], sessions, new Set(["a"]), 1)], ["b"]);
  assert.equal(shallowEqualSet(new Set(["a", "b"]), new Set(["b", "a"])), true);
  assert.equal(selectSession({ sessions }, "a"), sessions[0]);
  const cache = { current: null }, select = (state) => [state.sessions.length], equal = (a, b) => a[0] === b[0];
  const first = selectWithCache(cache, { sessions }, select, equal); assert.equal(selectWithCache(cache, { sessions: [...sessions] }, select, equal), first);
});
