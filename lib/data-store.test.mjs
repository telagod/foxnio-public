import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createDataStore } = await jiti.import("./data-store.ts");
const cursor = (revision, generation = "one") => ({ generation, revision });
const snapshot = (revision, generation = "one", sessions = []) => ({
  cursor: cursor(revision, generation), complete: true, staleSources: [], warnings: [],
  data: { sessions, projects: [], pins: [], notifications: [], foxWorkspace: "/fox", foxPointer: { sessionId: null, resetAt: null }, foxObservation: { version: 1, seeded: false, seen: {}, daily: {} } },
});
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const settle = () => new Promise((resolve) => setImmediate(resolve));
function harness() {
  let current = snapshot(1), nextOpen = null, nextPage = null, failure = false, pruned = false, online = true;
  const calls = [], streams = [], jobs = new Map(), observers = {};
  let timerId = 0;
  const store = createDataStore({
    fetch: async (path, init = {}) => {
      const url = new URL(path, "http://test"); calls.push({ url, init });
      if (init.method === "DELETE") return response({ ok: true });
      if (failure) return response({ code: "storage_unavailable", error: "offline" }, 503);
      if (url.pathname.endsWith("changes")) {
        if (pruned) { pruned = false; return response({ code: "reset_required" }, 409); }
        const before = JSON.parse(url.searchParams.get("cursor"));
        if (before.generation !== current.cursor.generation || before.revision > current.cursor.revision) return response({ code: "reset_required" }, 409);
        return response({ cursor: current.cursor, through: current.cursor, changes: before.revision === current.cursor.revision && before.generation === current.cursor.generation ? [] : [{ revision: current.cursor.revision, topic: "sessions", keys: [] }], hasMore: false });
      }
      if (url.searchParams.has("token")) return nextPage.promise;
      if (nextOpen) { const pending = nextOpen; nextOpen = null; return pending.promise; }
      return response({ ...current, token: "reader", next: false });
    },
    openStream: () => { const stream = { onopen: null, onmessage: null, onerror: null, readyState: 1, close() { this.closed = true; } }; streams.push(stream); return stream; },
    timers: { setTimeout(fn, ms) { const id = ++timerId; jobs.set(id, { fn, ms }); return id; }, clearTimeout(id) { jobs.delete(id); } },
    env: { isOnline: () => online, onOnline(fn) { observers.online = fn; return () => {}; }, onOffline(fn) { observers.offline = fn; return () => {}; }, onVisible(fn) { observers.visible = fn; return () => {}; } },
  });
  return {
    store, calls, jobs, streams, set(value) { current = value; }, fail(value) { failure = value; }, prune() { pruned = true; },
    holdOpen() { return nextOpen = deferred(); }, holdPage() { return nextPage = deferred(); },
    head(revision, generation = "one") { streams.at(-1).onmessage({ data: JSON.stringify({ type: "data-head", cursor: cursor(revision, generation) }) }); },
    async start() { store.retain(); streams.at(-1).onopen(); await settle(); },
    async retry() { const job = [...jobs.entries()].find(([, value]) => value.ms <= 30_000); assert.ok(job); jobs.delete(job[0]); job[1].fn(); await settle(); },
    offline() { online = false; observers.offline(); }, async online() { online = true; observers.online(); await settle(); },
  };
}

test("subscribes before fetching and closes the snapshot-subscribe gap without publishing stale data", async () => {
  const h = harness(); const pending = h.holdOpen();
  h.store.retain(); assert.equal(h.calls.length, 0);
  h.streams[0].onopen(); await settle();
  h.set(snapshot(2)); h.head(2);
  pending.resolve(response({ ...snapshot(1), token: "old", next: false }));
  await settle();
  assert.deepEqual(h.store.getSnapshot().snapshot.cursor, cursor(2));
  assert.equal(h.jobs.size, 0, "caught-up data has no polling/retry timer"); h.store.release();
});

test("pages publish atomically and every reader closes on failure or completion", async () => {
  const h = harness(); await h.start();
  const first = h.holdOpen(), page = h.holdPage();
  h.set(snapshot(2)); h.head(2); await settle();
  first.resolve(response({ ...snapshot(2, "one", [{ id: "first" }]), token: "paged", next: true })); await settle();
  assert.equal(h.store.getSnapshot().snapshot.cursor.revision, 1);
  page.resolve(response({ cursor: cursor(3), sessions: [{ id: "second" }], next: false })); await settle();
  assert.equal(h.store.getSnapshot().snapshot.cursor.revision, 1, "mixed revisions must not replace visible data");
  assert.equal(h.store.getSnapshot().status, "error");
  assert.ok(h.calls.some(({ url, init }) => init.method === "DELETE" && url.searchParams.get("token") === "paged"));
  h.store.release(); assert.equal(h.jobs.size, 0);
});

test("a generation reset fences delayed HTTP and late old-generation SSE hints", async () => {
  const h = harness(); await h.start(); const held = h.holdOpen();
  h.set(snapshot(2)); h.head(2); await settle();
  h.set(snapshot(0, "rebuilt")); h.head(0, "rebuilt");
  held.resolve(response({ ...snapshot(2), token: "old", next: false })); await settle();
  assert.deepEqual(h.store.getSnapshot().snapshot.cursor, cursor(0, "rebuilt"));
  h.head(100, "one"); await settle();
  assert.deepEqual(h.store.getSnapshot().snapshot.cursor, cursor(0, "rebuilt")); h.store.release();
});

test("known head failures retain old data, retry with bounded backoff, and suspend offline", async () => {
  const h = harness(); await h.start(); const previous = h.store.getSnapshot().snapshot;
  h.fail(true); h.head(2); await settle();
  assert.equal(h.store.getSnapshot().snapshot, previous); assert.equal(h.store.getSnapshot().status, "error");
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    assert.deepEqual([...h.jobs.values()].map((job) => job.ms), [delay]); await h.retry();
  }
  h.offline(); assert.equal(h.jobs.size, 0);
  h.set(snapshot(2)); h.fail(false); await h.online();
  assert.equal(h.store.getSnapshot().snapshot.cursor.revision, 2); assert.equal(h.jobs.size, 0); h.store.release();
});

test("pruned changes reset via a complete snapshot and overlapping refreshes coalesce", async () => {
  const h = harness(); await h.start(); h.prune(); h.set(snapshot(8));
  await h.store.refresh(); assert.equal(h.store.getSnapshot().snapshot.cursor.revision, 8);
  const pending = h.holdOpen(); const before = h.calls.length;
  const one = h.store.refresh(); await settle();
  const two = h.store.refresh(); const three = h.store.refresh();
  pending.resolve(response({ ...snapshot(8), token: "held", next: false })); await Promise.all([one, two, three]);
  assert.ok(h.calls.length - before <= 6, "one in-flight and one trailing snapshot, not one per caller"); h.store.release();
});

test("unavailable SSE keeps the subscription and reconnect refreshes missed data", async () => {
  const h = harness(); await h.start();
  h.streams[0].onmessage({ data: JSON.stringify({ type: "data-unavailable", code: "storage_busy", message: "busy" }) });
  assert.equal(h.store.getSnapshot().status, "error"); assert.equal(h.streams[0].closed, undefined);
  h.set(snapshot(4)); h.streams[0].onopen(); await settle();
  assert.equal(h.store.getSnapshot().snapshot.cursor.revision, 4); h.store.release();
});

test("release cancels a pending reader and a late response cannot replace a newer lifecycle", async () => {
  const h = harness(); await h.start(); const held = h.holdOpen();
  void h.store.refresh(); await settle(); h.store.release();
  h.set(snapshot(3)); await h.start();
  held.resolve(response({ ...snapshot(2), token: "released", next: false })); await settle();
  assert.equal(h.store.getSnapshot().snapshot.cursor.revision, 3);
  assert.ok(h.calls.some(({ url, init }) => init.method === "DELETE" && url.searchParams.get("token") === "released")); h.store.release();
});

test("a successful multipage snapshot replaces all domains together only after the last page", async () => {
  const h = harness(); await h.start(); const previous = h.store.getSnapshot().snapshot;
  const opened = h.holdOpen(), page = h.holdPage(); h.set(snapshot(2)); h.head(2); await settle();
  const replacement = snapshot(2, "one", [{ id: "first" }]); replacement.data.pins = [{ id: "first", at: 1 }];
  opened.resolve(response({ ...replacement, token: "pages", next: true })); await settle();
  assert.equal(h.store.getSnapshot().snapshot, previous);
  page.resolve(response({ cursor: cursor(2), sessions: [{ id: "second" }], next: false })); await settle();
  assert.deepEqual(h.store.getSnapshot().snapshot.data.sessions.map((session) => session.id), ["first", "second"]);
  assert.deepEqual(h.store.getSnapshot().snapshot.data.pins, [{ id: "first", at: 1 }]);
  assert.equal(h.jobs.size, 0); h.store.release();
});

test("initial snapshot failure is retried without needing a second SSE head", async () => {
  const h = harness(); h.fail(true); await h.start();
  assert.equal(h.store.getSnapshot().snapshot, null); assert.equal(h.store.getSnapshot().status, "error");
  h.fail(false); await h.retry();
  assert.equal(h.store.getSnapshot().snapshot.cursor.revision, 1); assert.equal(h.jobs.size, 0); h.store.release();
});

test("old same-generation heads are ignored and an HTTP-discovered generation resets the cursor", async () => {
  const h = harness(); await h.start(); const before = h.calls.length;
  h.head(0); await settle(); assert.equal(h.calls.length, before);
  h.set(snapshot(0, "restored")); h.prune(); await h.store.refresh();
  assert.deepEqual(h.store.getSnapshot().snapshot.cursor, cursor(0, "restored")); h.store.release();
});

test("change pages keep their upper bound and topic callbacks see only a complete snapshot", async () => {
  let state = snapshot(1), stream, paging = false;
  const seen = [], queries = [];
  const store = createDataStore({
    openStream: () => stream = { readyState: 1, close() {}, onopen: null, onmessage: null, onerror: null },
    fetch: async (path, init = {}) => {
      const url = new URL(path, "http://test");
      if (init.method === "DELETE") return response({ ok: true });
      if (url.pathname.endsWith("changes")) {
        const before = JSON.parse(url.searchParams.get("cursor"));
        queries.push({ before, through: JSON.parse(url.searchParams.get("through") ?? "null") });
        if (paging && before.revision === 1) {
          state = snapshot(600); state.data.projects = [{ path: "/new", hidden: false, addedAt: "2026-01-01" }];
          return response({ cursor: cursor(257), through: cursor(500), changes: [{ revision: 257, topic: "sessions", keys: ["a"] }], hasMore: true });
        }
        if (paging && before.revision === 257) return response({ cursor: cursor(500), through: cursor(500), changes: [{ revision: 500, topic: "pins", keys: ["a"] }], hasMore: false });
        return response({ cursor: state.cursor, through: state.cursor, changes: [], hasMore: false });
      }
      return response({ ...state, token: "reader", next: false });
    },
  });
  store.retain(); stream.onopen(); await settle();
  const stop = store.subscribeTopics(["projects"], () => seen.push(store.getSnapshot().snapshot.data.projects.map((project) => project.path)));
  paging = true; await store.refresh();
  assert.deepEqual(queries[1].through, cursor(500));
  assert.deepEqual(seen, [["/new"]], "snapshot advanced past the changes fence, so otherwise unmentioned topics must also invalidate");
  assert.equal(store.getSnapshot().snapshot.cursor.revision, 600); stop(); store.release();
});

test("an explicit future-cursor reset atomically replaces a restored lower revision and fences old SSE", async () => {
  const h = harness(); h.set(snapshot(20, "one", [{ id: "before-restore" }])); await h.start();
  const oldStream = h.streams[0], oldFrame = oldStream.onmessage;
  const replacement = h.holdOpen(); h.set(snapshot(4, "one", [{ id: "restored" }]));
  const loading = h.store.refresh(); await settle();
  assert.equal(oldStream.closed, true, "a rejected cursor retires its SSE subscription before resnapshotting");
  assert.equal(h.store.getSnapshot().snapshot.data.sessions[0].id, "before-restore", "last good data stays visible until every replacement page is ready");
  oldFrame({ data: JSON.stringify({ type: "data-head", cursor: cursor(25) }) });
  replacement.resolve(response({ ...snapshot(4, "one", [{ id: "restored" }]), token: "restored", next: false }));
  await loading;
  assert.deepEqual(h.store.getSnapshot().snapshot.cursor, cursor(4));
  assert.equal(h.store.getSnapshot().status, "ready");
  assert.equal(h.store.getSnapshot().snapshot.data.sessions[0].id, "restored");
  assert.equal(h.streams.length, 2, "the restored cursor gets a fresh subscription");
  oldFrame({ data: JSON.stringify({ type: "data-head", cursor: cursor(30) }) }); await settle();
  assert.deepEqual(h.store.getSnapshot().snapshot.cursor, cursor(4));
  h.set(snapshot(5)); h.head(5); await settle();
  assert.deepEqual(h.store.getSnapshot().snapshot.cursor, cursor(5));
  const reads = h.calls.length; h.head(3); await settle();
  assert.equal(h.calls.length, reads, "a lower SSE hint alone never authorizes rollback");
  assert.equal(h.jobs.size, 0); h.store.release();
});

test("a delayed pre-restore HTTP response cannot overwrite a lower authoritative replacement", async () => {
  const h = harness(); h.set(snapshot(20)); await h.start();
  const delayed = h.holdOpen(); const old = h.store.refresh(); await settle();
  const oldFrame = h.streams[0].onmessage;
  h.store.release(); h.set(snapshot(4)); await h.start();
  assert.deepEqual(h.store.getSnapshot().snapshot.cursor, cursor(4));
  delayed.resolve(response({ ...snapshot(21), token: "late-before-restore", next: false }));
  oldFrame({ data: JSON.stringify({ type: "data-head", cursor: cursor(22) }) });
  await old; await settle();
  assert.deepEqual(h.store.getSnapshot().snapshot.cursor, cursor(4));
  assert.ok(h.calls.some(({ url, init }) => init.method === "DELETE" && url.searchParams.get("token") === "late-before-restore"));
  assert.equal(h.jobs.size, 0); h.store.release();
});

test("a failed authoritative replacement retains old data and retries the reset without the rejected cursor", async () => {
  const h = harness(); h.set(snapshot(20)); await h.start();
  const held = h.holdOpen(); h.set(snapshot(4)); const request = h.store.refresh(); await settle();
  held.resolve(response({ code: "storage_busy", error: "Reader busy" }, 503)); await request;
  assert.deepEqual(h.store.getSnapshot().snapshot.cursor, cursor(20));
  assert.equal(h.store.getSnapshot().status, "error");
  const changes = h.calls.filter(({ url }) => url.pathname.endsWith("changes")).length;
  await h.retry();
  assert.deepEqual(h.store.getSnapshot().snapshot.cursor, cursor(4));
  assert.equal(h.calls.filter(({ url }) => url.pathname.endsWith("changes")).length, changes);
  assert.equal(h.jobs.size, 0); h.store.release();
});

test("a lower HTTP snapshot without explicit cursor rejection cannot roll back visible data", async () => {
  const h = harness(); h.set(snapshot(20)); await h.start();
  const held = h.holdOpen(); const read = h.store.refresh(); await settle();
  h.head(4);
  held.resolve(response({ ...snapshot(4), token: "stale-http", next: false })); await read;
  assert.deepEqual(h.store.getSnapshot().snapshot.cursor, cursor(20));
  assert.equal(h.store.getSnapshot().status, "error");
  assert.equal(h.streams[0].closed, undefined, "only a server reset retires the live subscription");
  h.store.release();
});
