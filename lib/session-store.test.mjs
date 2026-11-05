import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const {
  createSessionStore,
  computeRecentlyCompleted,
  selectSession,
  selectWithCache,
  shallowEqualSet,
  REQUEST_TIMEOUT_MS,
  FULL_REFRESH_MIN_INTERVAL_MS,
  DELTA_MIN_INTERVAL_MS,
  MAX_DELTA_IDS,
  mergeSessionDelta,
  PERSIST_DEBOUNCE_MS,
  UNREAD_SESSIONS_STORAGE_KEY,
} = await jiti.import("./session-store.ts");
const { RECENT_RUNS_STORAGE_KEY } = await jiti.import("./recent-runs.ts");
const { subscribeSessionsChanged } = await jiti.import("./session-change-bus.ts");

// ---------------------------------------------------------------------------
// Harness: fake fetch with a tiny server, fake event stream, timers, storage.
// ---------------------------------------------------------------------------

const flush = () => new Promise((resolve) => setImmediate(resolve));
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [A, B, C, D, E] = [id(1), id(2), id(3), id(4), id(5)];
const P1 = id(101);
const P2 = id(102);
const P3 = id(103);
const P4 = id(104);
const P5 = id(105);
const P6 = id(106);

const session = (sessionId, extra = {}) => ({
  id: sessionId,
  path: `/sessions/${sessionId}.jsonl`,
  cwd: "/work/a",
  created: "2026-01-01T00:00:00.000Z",
  modified: "2026-01-02T00:00:00.000Z",
  messageCount: 2,
  firstMessage: "hello",
  projectRoot: "/work/a",
  ...extra,
});

const response = (body, { status = 200, etag = null } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (name) => (name.toLowerCase() === "etag" ? etag : null) },
  json: async () => body,
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

class FakeTimers {
  now = 0;
  #seq = 0;
  #items = new Map();
  setTimeout(callback, ms) {
    const handle = ++this.#seq;
    this.#items.set(handle, { at: this.now + ms, callback });
    return handle;
  }
  clearTimeout(handle) {
    this.#items.delete(handle);
  }
  get pending() {
    return this.#items.size;
  }
  async advance(ms) {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.#items].filter(([, item]) => item.at <= target).sort((x, y) => x[1].at - y[1].at || x[0] - y[0])[0];
      if (!due) break;
      this.#items.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
      await flush();
    }
    this.now = target;
    await flush();
  }
}

class FakeStorage {
  data = new Map();
  writes = [];
  getItem(key) {
    return this.data.get(key) ?? null;
  }
  setItem(key, value) {
    this.writes.push(key);
    this.data.set(key, String(value));
  }
  removeItem(key) {
    this.writes.push(key);
    this.data.delete(key);
  }
  json(key) {
    const raw = this.data.get(key);
    return raw === undefined ? undefined : JSON.parse(raw);
  }
}

class FakeStream {
  readyState = 0;
  closed = false;
  onopen = null;
  onmessage = null;
  onerror = null;
  constructor(channel) {
    this.channel = channel;
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send(frame) {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }
  /** A failed connection: CONNECTING means it retries by itself, CLOSED is fatal. */
  fail(readyState = 0) {
    this.readyState = readyState;
    this.onerror?.();
  }
}

function harness({ storage = new FakeStorage(), recentRunsLimit, streamFailures = 0 } = {}) {
  const timers = new FakeTimers();
  const calls = [];
  const streams = [];
  const env = { visibility: new Set(), online: new Set(), pagehide: new Set() };
  const server = { version: 1, sessions: [session(A), session(B)], running: [], projects: [{ path: "/work/a" }], pinned: [] };
  const listen = (set) => (callback) => {
    set.add(callback);
    return () => set.delete(callback);
  };
  const routes = {
    "GET /api/sessions": (call) => {
      const running = { runningSessionIds: server.running.map((entry) => entry.id), runningSessions: server.running };
      if (call.ids) {
        const sessions = server.sessions.filter((entry) => call.ids.includes(entry.id));
        const missing = call.ids.filter((requested) => !sessions.some((entry) => entry.id === requested));
        return response({ sessions, missing, ...running, partial: true });
      }
      const etag = `"v${server.version}"`;
      if (call.headers["If-None-Match"] === etag) return response(null, { status: 304, etag });
      return response({ sessions: server.sessions, ...running }, { etag });
    },
    "GET /api/projects": () => response({ projects: server.projects }),
    "GET /api/session-ui": () => response({ pinned: server.pinned.map((pinned) => ({ id: pinned, at: 1 })) }),
    "PATCH /api/session-ui": (call) => {
      server.pinned = server.pinned.filter((pinned) => !(call.body.unpin ?? []).includes(pinned));
      for (const pinned of call.body.pin ?? []) if (!server.pinned.includes(pinned)) server.pinned.unshift(pinned);
      return response({ pinned: server.pinned.map((pinned) => ({ id: pinned, at: 1 })) });
    },
  };
  const fetchFake = (url, init = {}) => {
    const [path, query = ""] = url.split("?");
    const ids = new URLSearchParams(query).get("ids");
    const call = {
      url: path,
      ids: ids === null ? null : ids.split(","),
      method: init.method ?? "GET",
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : undefined,
      signal: init.signal,
    };
    calls.push(call);
    return new Promise((resolve, reject) => {
      const abort = () => reject(call.signal.reason);
      if (call.signal?.aborted) return abort();
      call.signal?.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(() => routes[`${call.method} ${path}`](call)).then(resolve, reject);
    });
  };
  let streamsToFail = streamFailures;
  const store = createSessionStore({
    fetch: fetchFake,
    openStream: (channel) => {
      if (streamsToFail > 0) {
        streamsToFail -= 1;
        throw new Error("no worker");
      }
      const stream = new FakeStream(channel);
      streams.push(stream);
      return stream;
    },
    storage,
    timers,
    now: () => 1_000_000 + timers.now,
    env: { onVisibilityChange: listen(env.visibility), onOnline: listen(env.online), onPageHide: listen(env.pagehide) },
    ...(recentRunsLimit ? { recentRunsLimit } : {}),
  });
  const count = (method, url) => calls.filter((call) => call.method === method && call.url === url && !call.ids).length;
  const h = {
    store,
    timers,
    calls,
    streams,
    env,
    server,
    routes,
    storage,
    snap: () => store.getSnapshot(),
    stream: () => streams.at(-1),
    sessionFetches: () => count("GET", "/api/sessions"),
    fullCalls: () => calls.filter((call) => call.url === "/api/sessions" && !call.ids),
    deltaCalls: () => calls.filter((call) => call.url === "/api/sessions" && call.ids),
    projectFetches: () => count("GET", "/api/projects"),
    pinFetches: () => count("GET", "/api/session-ui"),
    patches: () => calls.filter((call) => call.method === "PATCH").map((call) => call.body),
    notifications: 0,
    /** Retain and let the first loads settle. */
    async start() {
      store.retain();
      await flush();
      return h;
    },
    /** Change the server's session list so the next fetch carries a new body. */
    setServer(patch) {
      Object.assign(server, patch);
      server.version += 1;
    },
    /** Add or replace a session on the server, keeping its list newest first. */
    upsert(entry) {
      server.sessions = [...server.sessions.filter((existing) => existing.id !== entry.id), entry].sort((x, y) => Date.parse(y.modified) - Date.parse(x.modified));
      server.version += 1;
    },
    /** Delete a session on the server. */
    drop(sessionId) {
      server.sessions = server.sessions.filter((existing) => existing.id !== sessionId);
      server.version += 1;
    },
    /** Let both rate limits run out, so the next automatic request is a leading edge. */
    async quiet() {
      await timers.advance(FULL_REFRESH_MIN_INTERVAL_MS);
    },
    /** Deliver a `running` frame and let the reaction settle. */
    async frame(ids, extra = {}) {
      h.stream().send({ type: "running", runningSessionIds: ids, runningSessions: ids.map((sid) => ({ id: sid, cwd: "/work/a" })), exitedSessions: [], ...extra });
      await flush();
    },
  };
  store.subscribe(() => { h.notifications += 1; });
  return h;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

test("a new store is the server snapshot until retained, then loads sessions, projects and pins once", async () => {
  const h = harness();
  h.server.pinned = [P2, P1];
  h.server.running = [{ id: A, cwd: "/work/a" }];
  assert.equal(h.snap(), h.store.getServerSnapshot());
  assert.equal(h.snap().sessionsStatus, "loading");
  assert.equal(h.calls.length, 0);

  await h.start();
  const snap = h.snap();
  assert.equal(snap.sessionsStatus, "ready");
  assert.equal(snap.sessionsError, null);
  assert.equal(snap.projectsStatus, "ready");
  assert.deepEqual(snap.sessions.map((entry) => entry.id), [A, B]);
  assert.deepEqual(snap.projects, [{ path: "/work/a" }]);
  assert.deepEqual([...snap.running], [A]);
  assert.deepEqual([...snap.runningCwd], [[A, "/work/a"]]);
  assert.deepEqual(snap.pinnedSessionIds, [P2, P1]);
  assert.deepEqual(h.calls.map((call) => `${call.method} ${call.url}`).sort(), ["GET /api/projects", "GET /api/session-ui", "GET /api/sessions"]);
  assert.deepEqual(h.streams.map((stream) => stream.channel), [{ kind: "running" }]);
  assert.equal(h.store.getSnapshot(), snap, "reading does not create new snapshots");
});

test("unchanged answers keep the snapshot: a 304, an equal body and a forced reload notify nobody", async () => {
  const h = await harness().start();
  const first = h.snap();
  const notified = h.notifications;

  await h.store.refresh();
  assert.equal(h.calls.filter((call) => call.url === "/api/sessions").at(-1).headers["If-None-Match"], '"v1"');
  assert.equal(h.snap(), first);

  await h.store.refresh({ force: true });
  const forced = h.calls.filter((call) => call.url === "/api/sessions").at(-1);
  assert.equal("If-None-Match" in forced.headers, false);
  assert.equal(h.snap(), first, "a full body equal to the held data changes nothing");

  h.setServer({ sessions: h.server.sessions.map((entry) => ({ ...entry })) });
  await h.store.refresh();
  assert.equal(h.snap(), first);
  assert.equal(h.notifications, notified);
});

test("a changed list shares the objects of unchanged sessions", async () => {
  const h = await harness().start();
  const [a, b] = h.snap().sessions;
  h.setServer({ sessions: [session(A), session(B, { name: "renamed" }), session(C)] });
  await h.store.refresh();
  const next = h.snap().sessions;
  assert.equal(next[0], a);
  assert.notEqual(next[1], b);
  assert.equal(next[1].name, "renamed");
  assert.deepEqual(next.map((entry) => entry.id), [A, B, C]);
  assert.equal(selectSession(h.snap(), C), next[2]);
  assert.equal(selectSession(h.snap(), "missing"), undefined);
});

test("a refresh requested while one runs schedules exactly one follow-up, whatever the number of requests", async () => {
  const h = harness();
  const gate = deferred();
  const base = h.routes["GET /api/sessions"];
  let held = true;
  h.routes["GET /api/sessions"] = async (call) => {
    if (held) {
      held = false;
      await gate.promise;
    }
    return base(call);
  };
  h.store.retain();
  await flush();
  assert.equal(h.sessionFetches(), 1);

  let settled = 0;
  const waiting = [h.store.refresh(), h.store.refresh(), h.store.refresh({ force: true })].map((promise) => promise.then(() => { settled += 1; }));
  await flush();
  assert.equal(h.sessionFetches(), 1, "nothing starts while the first request runs");
  assert.equal(settled, 0);

  gate.resolve();
  await Promise.all(waiting);
  assert.equal(h.sessionFetches(), 2);
  assert.equal("If-None-Match" in h.calls.filter((call) => call.url === "/api/sessions")[1].headers, false, "a forced request among the merged ones skips the ETag");
  await h.timers.advance(5000);
  assert.equal(h.sessionFetches(), 2);
});

test("list failures keep the data and report the detail; the next answer recovers, a 304 included", async () => {
  const h = await harness().start();
  const loaded = h.snap().sessions;
  const base = h.routes["GET /api/sessions"];

  h.routes["GET /api/sessions"] = () => response({}, { status: 500 });
  await h.store.refresh();
  assert.equal(h.snap().sessionsStatus, "error");
  assert.equal(h.snap().sessionsError, "HTTP 500");
  assert.equal(h.snap().sessions, loaded);

  h.routes["GET /api/sessions"] = () => { throw new TypeError("Failed to fetch"); };
  await h.store.refresh();
  assert.equal(h.snap().sessionsError, "Failed to fetch");

  h.routes["GET /api/sessions"] = () => response({ nope: true }, { etag: '"x"' });
  await h.store.refresh();
  assert.equal(h.snap().sessionsError, "Invalid session list response");

  h.routes["GET /api/sessions"] = base;
  await h.store.refresh();
  assert.equal(h.snap().sessionsStatus, "ready");
  assert.equal(h.snap().sessionsError, null);
  assert.equal(h.snap().sessions, loaded);
});

test("a request that never answers fails after the deadline and the store recovers afterwards", async () => {
  const h = harness();
  const base = h.routes["GET /api/sessions"];
  h.routes["GET /api/sessions"] = () => new Promise(() => {});
  h.store.retain();
  await flush();
  await h.timers.advance(REQUEST_TIMEOUT_MS - 1);
  assert.equal(h.snap().sessionsStatus, "loading");
  await h.timers.advance(1);
  assert.equal(h.snap().sessionsStatus, "error");
  assert.match(h.snap().sessionsError, /timed out/i);

  h.routes["GET /api/sessions"] = base;
  await h.store.refresh();
  assert.equal(h.snap().sessionsStatus, "ready");
  assert.equal(h.snap().sessions.length, 2);
});

test("a malformed project list answer is an error that keeps the previous projects", async () => {
  const h = await harness().start();
  h.routes["GET /api/projects"] = () => response({}, { status: 503 });
  await h.store.refresh({ projects: true, sessions: false });
  assert.equal(h.snap().projectsStatus, "error");
  assert.equal(h.snap().projectsError, "HTTP 503");
  assert.deepEqual(h.snap().projects, [{ path: "/work/a" }]);

  h.routes["GET /api/projects"] = () => response({ projects: [{ path: "/work/a" }, { path: "/work/b" }, { alias: "no path" }, "junk"] });
  await h.store.refresh({ projects: true, sessions: false });
  assert.equal(h.snap().projectsStatus, "ready");
  assert.deepEqual(h.snap().projects.map((project) => project.path), ["/work/a", "/work/b"]);
});

test("projects are fetched on start and on request only, never by a session refresh", async () => {
  const h = await harness().start();
  assert.equal(h.projectFetches(), 1);
  await h.store.refresh();
  await h.store.refresh({ force: true });
  h.env.online.forEach((callback) => callback());
  await flush();
  assert.equal(h.projectFetches(), 1);

  const before = h.snap().projects;
  await h.store.refresh({ projects: true });
  assert.equal(h.projectFetches(), 2);
  assert.equal(h.snap().projects, before, "equal projects keep their identity");
});

// ---------------------------------------------------------------------------
// Event channel
// ---------------------------------------------------------------------------

test("the stream owns the running state once a frame arrived; a fetch only seeds it", async () => {
  const h = harness();
  h.server.running = [{ id: A, cwd: "/work/a" }];
  await h.start();
  assert.deepEqual([...h.snap().running], [A]);

  await h.frame([B], { runningSessions: [{ id: B, cwd: "/work/b" }] });
  assert.deepEqual([...h.snap().running], [B]);
  assert.deepEqual([...h.snap().runningCwd], [[B, "/work/b"]]);

  h.setServer({ running: [{ id: C, cwd: "/work/c" }] });
  await h.store.refresh();
  assert.deepEqual([...h.snap().running], [B], "a fetched snapshot never overrides the stream");

  h.stream().fail(0);
  await h.store.refresh();
  assert.deepEqual([...h.snap().running], [C], "after a stream error the fetched snapshot owns it again");
  assert.deepEqual([...h.snap().runningCwd], [[C, "/work/c"]]);

  await h.frame([D]);
  h.setServer({ running: [] });
  await h.store.refresh();
  assert.deepEqual([...h.snap().running], [D], "the next frame hands authority back to the stream");
});

test("a frame that equals the held state changes nothing and notifies nobody", async () => {
  const h = await harness().start();
  const exited = { id: E, cwd: "/work/a", at: 5, code: 1, signal: null, detail: "boom" };
  await h.frame([A, B], { exitedSessions: [exited] });
  const first = h.snap();
  const notified = h.notifications;
  assert.deepEqual([...first.exited.keys()], [E]);

  await h.frame([B, A], { exitedSessions: [{ ...exited }] });
  assert.equal(h.snap(), first);
  assert.equal(h.notifications, notified);

  await h.frame([A, B], { exitedSessions: [{ ...exited, detail: "other" }] });
  const changed = h.snap();
  assert.notEqual(changed, first);
  assert.equal(changed.running, first.running, "only the exited map changed");
  assert.equal(changed.runningCwd, first.runningCwd);
  assert.equal(changed.exited.get(E).detail, "other");
  assert.equal(h.notifications, notified + 1);
});

test("version counters count changes of their own data only", async () => {
  const h = await harness().start();
  const v0 = h.snap().version;
  await h.frame([A]);
  const v1 = h.snap().version;
  assert.equal(v1.running, v0.running + 1);
  assert.equal(v1.sessions, v0.sessions);
  assert.equal(v1.projects, v0.projects);

  h.setServer({ sessions: [session(A), session(B), session(C)] });
  await h.store.refresh();
  assert.equal(h.snap().version.sessions, v1.sessions + 1);
  assert.equal(h.snap().version.running, v1.running);

  await h.store.refresh({ projects: true, sessions: false });
  assert.equal(h.snap().version.projects, v1.projects, "equal projects are not a change");
});

test("malformed and unknown frames are ignored; partial frames are tolerated", async () => {
  const h = await harness().start();
  await h.frame([A]);
  const before = h.snap();
  for (const raw of ["{broken", "null", "[]", "7", JSON.stringify({ type: "unknown" }), JSON.stringify({ nothing: true })]) {
    h.stream().send(raw);
  }
  await flush();
  assert.equal(h.snap(), before);

  h.stream().send({ type: "running", runningSessionIds: [A, 7, null, B], runningSessions: [{ id: A }, { id: B, cwd: "/work/b" }, "x"], exitedSessions: [{ cwd: "no id" }] });
  await flush();
  assert.deepEqual([...h.snap().running], [A, B]);
  assert.deepEqual([...h.snap().runningCwd], [[A, "/work/a"], [B, "/work/b"]], "a frame entry without cwd keeps the cwd known from earlier");
  assert.equal(h.snap().exited.size, 0);
});

async function h_ready() {
  return harness().start();
}

const day = (n) => `2026-01-${String(n).padStart(2, "0")}T00:00:00.000Z`;
const at = (sessionId, n, extra = {}) => session(sessionId, { modified: day(n), ...extra });
const flagged = (h, extra = {}) => h.stream().send({ type: "running", runningSessionIds: [], refreshSessionList: true, ...extra });
const changed = (h, ...ids) => h.stream().send({ type: "sessions-changed", sessionIds: ids, refreshSessionList: true });
/** A harness whose server holds sessions with distinct modification times (newest first: A, B, D). */
async function h_dated() {
  const h = harness();
  h.setServer({ sessions: [at(A, 5), at(B, 4), at(D, 2)] });
  await h.start();
  await h.quiet();
  return h;
}

test("sessions-changed publishes the changed ids and asks for nothing unless the frame says so", async () => {
  const h = await h_ready();
  const seen = [];
  const unsubscribe = subscribeSessionsChanged((ids) => seen.push(ids));
  const base = h.sessionFetches();
  h.stream().send({ type: "sessions-changed", sessionIds: [A, B] });
  h.stream().send({ type: "sessions-changed", sessionIds: [] });
  h.stream().send({ type: "sessions-changed" });
  await h.timers.advance(60_000);
  unsubscribe();
  assert.deepEqual(seen, [[A, B]]);
  assert.equal(h.sessionFetches(), base);
  assert.equal(h.deltaCalls().length, 0);
});

// ---------------------------------------------------------------------------
// Full reloads: which triggers, and at what rate
// ---------------------------------------------------------------------------

test("automatic full reloads run at most once per interval: one at once, one trailing", async () => {
  const h = await h_ready();
  await h.quiet();
  const base = h.sessionFetches();

  flagged(h);
  await flush();
  assert.equal(h.sessionFetches(), base + 1, "leading edge");
  for (let n = 0; n < 10; n += 1) {
    flagged(h);
    await h.timers.advance(400);
  }
  assert.equal(h.sessionFetches(), base + 1, "four seconds in");
  await h.timers.advance(FULL_REFRESH_MIN_INTERVAL_MS - 4000 - 1);
  assert.equal(h.sessionFetches(), base + 1);
  await h.timers.advance(1);
  assert.equal(h.sessionFetches(), base + 2, "one trailing run for the whole burst");
  await h.timers.advance(60_000);
  assert.equal(h.sessionFetches(), base + 2);

  flagged(h);
  await flush();
  assert.equal(h.sessionFetches(), base + 3, "idle again: leading edge");
  assert.equal(h.deltaCalls().length, 0);
});

test("a running frame with refreshSessionList is one full reload, whatever else it changes", async () => {
  const h = await h_ready();
  await h.quiet();
  const base = h.sessionFetches();
  await h.frame([A], { refreshSessionList: true });
  assert.equal(h.sessionFetches(), base + 1);
  assert.equal(h.deltaCalls().length, 0, "the full reload covers the sessions that started");

  await h.frame([A]);
  await h.timers.advance(60_000);
  assert.equal(h.sessionFetches(), base + 1, "an unchanged running set asks for nothing");
  assert.equal(h.deltaCalls().length, 0);
});

test("explicit refresh is never rate limited, and it answers a pending trailing reload", async () => {
  const h = await h_ready();
  await h.quiet();
  const base = h.sessionFetches();
  flagged(h);
  await flush();
  flagged(h);
  await flush();
  assert.equal(h.sessionFetches(), base + 1);

  await h.store.refresh();
  await h.store.refresh({ force: true });
  assert.equal(h.sessionFetches(), base + 3, "no waiting for the interval");
  await h.timers.advance(60_000);
  assert.equal(h.sessionFetches(), base + 3, "the trailing reload was answered by the explicit ones");
});

test("a stream error, a reopened stream and coming back each reload through the same limit", async () => {
  const h = await h_ready();
  h.stream().open();
  await h.timers.advance(FULL_REFRESH_MIN_INTERVAL_MS * 2);
  const base = h.sessionFetches();
  h.stream().fail(0);
  assert.equal(h.streams.length, 1, "a CONNECTING stream reconnects itself");
  await h.timers.advance(FULL_REFRESH_MIN_INTERVAL_MS);
  assert.equal(h.sessionFetches(), base, "an error alone reloads nothing");
  h.stream().open();
  await flush();
  assert.equal(h.sessionFetches(), base + 1, "reopened after an error: reload at once");

  h.env.visibility.forEach((callback) => callback(true));
  h.env.online.forEach((callback) => callback());
  await flush();
  assert.equal(h.sessionFetches(), base + 1, "just reloaded: coming back waits for the trailing edge");
  await h.timers.advance(FULL_REFRESH_MIN_INTERVAL_MS);
  assert.equal(h.sessionFetches(), base + 2, "one trailing reload for both");
  assert.equal(h.deltaCalls().length, 0);
});

test("the first open of the stream does not reload", async () => {
  const h = await h_ready();
  await h.quiet();
  const base = h.sessionFetches();
  h.stream().open();
  await h.timers.advance(FULL_REFRESH_MIN_INTERVAL_MS * 2);
  assert.equal(h.sessionFetches(), base);
});

test("a closed stream is reopened with a growing delay and the list is reloaded to cover the gap", async () => {
  const h = await h_ready();
  h.stream().open();
  await h.quiet();
  const base = h.sessionFetches();

  h.stream().fail(2);
  await flush();
  assert.equal(h.sessionFetches(), base + 1, "the fetched list covers while the stream is down");
  assert.equal(h.streams.length, 1);
  await h.timers.advance(999);
  assert.equal(h.streams.length, 1);
  await h.timers.advance(1);
  assert.equal(h.streams.length, 2);

  h.stream().fail(2);
  await h.timers.advance(1999);
  assert.equal(h.streams.length, 2);
  await h.timers.advance(1);
  assert.equal(h.streams.length, 3, "the second failure waits twice as long");

  h.stream().open();
  await h.timers.advance(FULL_REFRESH_MIN_INTERVAL_MS);
  assert.equal(h.sessionFetches(), base + 2, "failures and the reopen share one trailing reload");
  h.stream().fail(2);
  await h.timers.advance(1000);
  assert.equal(h.streams.length, 4, "a successful open resets the delay");
});

// ---------------------------------------------------------------------------
// Delta updates
// ---------------------------------------------------------------------------

test("a burst of 100 sessions-changed frames over 20 s is a handful of delta requests and no full reload", async () => {
  const h = await h_ready();
  await h.quiet();
  const fulls = h.sessionFetches();
  const start = h.timers.now;
  for (let n = 0; n < 100; n += 1) {
    h.upsert(session(A, { modified: new Date(Date.UTC(2026, 0, 3, 0, 0, n)).toISOString(), messageCount: n + 2 }));
    changed(h, A);
    await h.timers.advance(200);
  }
  assert.equal(h.timers.now - start, 20_000);
  assert.ok(h.deltaCalls().length <= 14, `${h.deltaCalls().length} delta requests in 20 s`);
  assert.ok(h.deltaCalls().length >= 13);
  await h.timers.advance(DELTA_MIN_INTERVAL_MS);
  assert.ok(h.deltaCalls().length <= 15);
  assert.equal(h.sessionFetches(), fulls, "no full list was requested");
  assert.equal(h.snap().sessions.find((entry) => entry.id === A).messageCount, 101, "the last state arrived");
  assert.ok(h.deltaCalls().every((call) => call.ids.join() === A));
});

test("delta requests are throttled: one at once, the next not before the interval, ids unioned meanwhile", async () => {
  const h = await h_dated();
  changed(h, A);
  await flush();
  assert.deepEqual(h.deltaCalls().map((call) => call.ids), [[A]], "leading edge");

  changed(h, B);
  changed(h, D, B);
  changed(h, id(7));
  await h.timers.advance(DELTA_MIN_INTERVAL_MS - 1);
  assert.equal(h.deltaCalls().length, 1);
  await h.timers.advance(1);
  assert.deepEqual(h.deltaCalls().map((call) => call.ids), [[A], [B, D, id(7)]], "one trailing request with the union");

  await h.timers.advance(10 * DELTA_MIN_INTERVAL_MS);
  assert.equal(h.deltaCalls().length, 2, "nothing pending, nothing sent");
  changed(h, A);
  await flush();
  assert.equal(h.deltaCalls().length, 3, "idle for longer than the interval: leading edge again");
  assert.equal(h.sessionFetches(), 1);
});

test("never more than one delta request is in flight; what arrives meanwhile follows as one request", async () => {
  const h = await h_dated();
  const gate = deferred();
  const base = h.routes["GET /api/sessions"];
  let first = true;
  h.routes["GET /api/sessions"] = async (call) => {
    if (call.ids && first) {
      first = false;
      await gate.promise;
    }
    return base(call);
  };
  changed(h, A);
  await h.timers.advance(0);
  changed(h, B);
  await h.timers.advance(6_000);
  changed(h, D);
  await h.timers.advance(6_000);
  assert.equal(h.deltaCalls().length, 1, "the slow request blocks all others, however long it takes");

  gate.resolve();
  await flush();
  assert.deepEqual(h.deltaCalls().map((call) => call.ids), [[A], [B, D]]);
});

test("a new session is inserted in modification order; the other sessions keep their objects", async () => {
  const h = await h_dated();
  const [a, b, d] = h.snap().sessions;
  h.upsert(at(C, 3));
  changed(h, C);
  await flush();
  const { sessions } = h.snap();
  assert.deepEqual(sessions.map((entry) => entry.id), [A, B, C, D]);
  assert.ok(sessions[0] === a && sessions[1] === b && sessions[3] === d, "identity, not just equality");
  assert.equal(h.sessionFetches(), 1);
  assert.equal(selectSession(h.snap(), C), sessions[2]);
});

test("a changed session replaces its entry and moves where its new modification time puts it", async () => {
  const h = await h_dated();
  const [a, b, d] = h.snap().sessions;
  h.upsert(at(D, 9, { messageCount: 7 }));
  changed(h, D);
  await flush();
  const { sessions } = h.snap();
  assert.deepEqual(sessions.map((entry) => entry.id), [D, A, B]);
  assert.equal(sessions[0].messageCount, 7);
  assert.notEqual(sessions[0], d);
  assert.ok(sessions[1] === a && sessions[2] === b);

  h.upsert(at(D, 1, { messageCount: 8 }));
  await h.timers.advance(DELTA_MIN_INTERVAL_MS);
  changed(h, D);
  await flush();
  assert.deepEqual(h.snap().sessions.map((entry) => entry.id), [A, B, D], "it can also move down");
});

test("a deleted session disappears, together with its unread mark", async () => {
  const storage = new FakeStorage();
  storage.data.set(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([B, D]));
  const h = harness({ storage });
  h.setServer({ sessions: [at(A, 5), at(B, 4), at(D, 2)] });
  await h.start();
  await h.quiet();
  const [a, , d] = h.snap().sessions;
  assert.deepEqual([...h.snap().unread].sort(), [B, D].sort());

  h.drop(B);
  changed(h, B);
  await flush();
  const { sessions } = h.snap();
  assert.deepEqual(sessions.map((entry) => entry.id), [A, D]);
  assert.ok(sessions[0] === a && sessions[1] === d);
  assert.deepEqual([...h.snap().unread], [D]);
  assert.equal(h.sessionFetches(), 1, "a delta, not a reload");
});

test("a delta that changes nothing publishes nothing; ids the store does not hold and the server lacks are ignored", async () => {
  const h = await h_dated();
  const before = h.snap();
  const notified = h.notifications;
  changed(h, A, id(404));
  await flush();
  assert.equal(h.deltaCalls().length, 1);
  assert.equal(h.snap(), before);
  assert.equal(h.notifications, notified);
});

test("a delta answer seeds the running state only while the stream is not in charge", async () => {
  const h = await h_dated();
  h.server.running = [{ id: B, cwd: "/work/b" }];
  changed(h, A);
  await flush();
  assert.deepEqual([...h.snap().running], [B], "the stream has not spoken yet");

  await h.frame([D]);
  await h.timers.advance(DELTA_MIN_INTERVAL_MS);
  changed(h, A);
  await flush();
  assert.deepEqual([...h.snap().running], [D], "the stream owns it now");
});

test("a run starting or finishing reloads just that session, and not at all while the first list loads", async () => {
  const h = harness();
  const gate = deferred();
  const base = h.routes["GET /api/sessions"];
  h.routes["GET /api/sessions"] = async (call) => {
    if (!call.ids) await gate.promise;
    return base(call);
  };
  h.store.retain();
  await flush();
  await h.frame([A]);
  changed(h, B);
  assert.equal(h.deltaCalls().length, 0, "the pending first list includes these");
  gate.resolve();
  await h.timers.advance(10_000);
  assert.equal(h.sessionFetches(), 1);
  assert.equal(h.deltaCalls().length, 0);

  await h.frame([A, B]);
  assert.deepEqual(h.deltaCalls().map((call) => call.ids), [[B]]);
  await h.timers.advance(DELTA_MIN_INTERVAL_MS);
  await h.frame([]);
  assert.deepEqual(h.deltaCalls().map((call) => call.ids), [[B], [A, B]]);
  assert.equal(h.sessionFetches(), 1);
});

// ---------------------------------------------------------------------------
// Delta fallbacks to a full reload
// ---------------------------------------------------------------------------

test("more changed sessions than one request may carry is a full reload", async () => {
  const h = await h_dated();
  const base = h.sessionFetches();
  const many = Array.from({ length: MAX_DELTA_IDS + 1 }, (_, n) => id(1000 + n));
  h.stream().send({ type: "sessions-changed", sessionIds: many, refreshSessionList: true });
  await flush();
  assert.equal(h.deltaCalls().length, 0);
  assert.equal(h.sessionFetches(), base + 1);

  await h.quiet();
  const exactly = many.slice(0, MAX_DELTA_IDS);
  h.stream().send({ type: "sessions-changed", sessionIds: exactly, refreshSessionList: true });
  await flush();
  assert.deepEqual(h.deltaCalls().map((call) => call.ids.length), [MAX_DELTA_IDS]);
});

test("ids that pile up beyond the limit while waiting turn into one full reload", async () => {
  const h = await h_dated();
  changed(h, A);
  await flush();
  const base = h.sessionFetches();
  h.stream().send({ type: "sessions-changed", sessionIds: Array.from({ length: 60 }, (_, n) => id(2000 + n)), refreshSessionList: true });
  h.stream().send({ type: "sessions-changed", sessionIds: Array.from({ length: 60 }, (_, n) => id(3000 + n)), refreshSessionList: true });
  await h.timers.advance(FULL_REFRESH_MIN_INTERVAL_MS);
  assert.equal(h.deltaCalls().length, 1, "the waiting ids were dropped, not sent");
  assert.equal(h.sessionFetches(), base + 1);
});

test("frames the server cannot answer by id are full reloads: ids that are not session ids, or none at all", async () => {
  const h = await h_dated();
  const base = h.sessionFetches();
  h.stream().send({ type: "sessions-changed", sessionIds: ["legacy-id"], refreshSessionList: true });
  await flush();
  assert.equal(h.sessionFetches(), base + 1);
  await h.quiet();
  h.stream().send({ type: "sessions-changed", refreshSessionList: true });
  await flush();
  assert.equal(h.sessionFetches(), base + 2);
  assert.equal(h.deltaCalls().length, 0);
});

test("a failed delta falls back to a full reload", async () => {
  const h = await h_dated();
  const base = h.sessionFetches();
  const original = h.routes["GET /api/sessions"];
  h.routes["GET /api/sessions"] = (call) => (call.ids ? response({}, { status: 500 }) : original(call));
  changed(h, A);
  await flush();
  assert.equal(h.deltaCalls().length, 1);
  assert.equal(h.sessionFetches(), base + 1);
  assert.equal(h.snap().sessionsStatus, "ready", "the delta failure alone is not a list error");

  h.routes["GET /api/sessions"] = (call) => (call.ids ? response({ nope: true }) : original(call));
  await h.quiet();
  changed(h, A);
  await flush();
  assert.equal(h.sessionFetches(), base + 2, "an unusable answer too");
});

test("a new session in a workspace the store has not seen, or a removed parent, is followed by a full reload", async () => {
  const h = await h_dated();
  const base = h.sessionFetches();
  h.upsert(at(C, 6, { cwd: "/work/new", projectRoot: "/work/new" }));
  changed(h, C);
  await flush();
  assert.ok(h.snap().sessions.some((entry) => entry.id === C), "the delta is applied right away");
  assert.equal(h.sessionFetches(), base + 1);
  assert.equal(h.projectFetches(), 2, "and the project list is re-read");

  await h.quiet();
  h.upsert(at(E, 1, { parentSessionId: D }));
  changed(h, E);
  await flush();
  assert.equal(h.sessionFetches(), base + 1, "a new child of a known workspace needs nothing more");
  await h.timers.advance(DELTA_MIN_INTERVAL_MS);
  h.drop(D);
  changed(h, D);
  await flush();
  assert.ok(!h.snap().sessions.some((entry) => entry.id === D));
  assert.equal(h.sessionFetches(), base + 2, "the server re-links the children of a removed session");
});

test("deltas wait for a running full reload, and a full reload answers the deltas queued before it", async () => {
  const h = await h_dated();
  const gate = deferred();
  const base = h.routes["GET /api/sessions"];
  let hold = true;
  h.routes["GET /api/sessions"] = async (call) => {
    if (!call.ids && hold) {
      hold = false;
      await gate.promise;
    }
    return base(call);
  };
  const reload = h.store.refresh();
  await flush();
  changed(h, A);
  await h.timers.advance(10_000);
  assert.equal(h.deltaCalls().length, 0);
  gate.resolve();
  await reload;
  await flush();
  assert.deepEqual(h.deltaCalls().map((call) => call.ids), [[A]], "the delta follows the reload that was already running");

  changed(h, B);
  changed(h, D);
  await h.store.refresh();
  await h.timers.advance(60_000);
  assert.equal(h.deltaCalls().length, 1, "queued before a full reload started: covered by it");
});

test("when the first list never loaded, changes are full reloads, not deltas", async () => {
  const h = harness();
  h.routes["GET /api/sessions"] = () => response({}, { status: 500 });
  await h.start();
  assert.equal(h.snap().sessionsStatus, "error");
  const base = h.sessionFetches();
  h.stream().send({ type: "sessions-changed", sessionIds: [A], refreshSessionList: true });
  await h.timers.advance(FULL_REFRESH_MIN_INTERVAL_MS);
  assert.equal(h.deltaCalls().length, 0);
  assert.equal(h.sessionFetches(), base + 1);
});

test("stopping drops queued deltas and their timers", async () => {
  const h = await h_dated();
  changed(h, A);
  await flush();
  changed(h, B);
  assert.ok(h.timers.pending > 0);
  h.store.release();
  await flush();
  assert.equal(h.timers.pending, 0);
  await h.timers.advance(60_000);
  assert.equal(h.deltaCalls().length, 1);
});

test("mergeSessionDelta: insertion order, replacement, removal and identity", () => {
  const base = [at(A, 9), at(B, 7), at(C, 5), at(D, 3)];
  const ids = (list) => list.map((entry) => entry.id);
  const none = new Set();
  const fresh = (n, extra = {}) => at(E, n, extra);

  assert.deepEqual(ids(mergeSessionDelta(base, [fresh(10)], none)), [E, A, B, C, D], "newest goes first");
  assert.deepEqual(ids(mergeSessionDelta(base, [fresh(8)], none)), [A, E, B, C, D]);
  assert.deepEqual(ids(mergeSessionDelta(base, [fresh(1)], none)), [A, B, C, D, E], "oldest goes last");
  assert.deepEqual(ids(mergeSessionDelta(base, [fresh(7)], none)), [A, E, B, C, D], "a tie goes before the session it ties with");
  assert.deepEqual(ids(mergeSessionDelta([], [fresh(1)], none)), [E]);
  assert.deepEqual(ids(mergeSessionDelta(base, [at(C, 10)], none)), [C, A, B, D], "a replaced session moves");
  assert.deepEqual(ids(mergeSessionDelta(base, [at(A, 9, { name: "x" })], none)), [A, B, C, D], "or stays");
  assert.deepEqual(ids(mergeSessionDelta(base, [], new Set([B, id(99)]))), [A, C, D]);
  assert.deepEqual(ids(mergeSessionDelta(base, [fresh(6), at(D, 8)], new Set([A]))), [D, B, E, C]);
  assert.deepEqual(ids(mergeSessionDelta(base, [fresh(4), session(id(6), { modified: day(6) })], none)), [A, B, id(6), C, E, D], "several new sessions each find their place");
  assert.deepEqual(ids(mergeSessionDelta(base, [session(id(6), { modified: "not a date" })], none)), [A, B, C, D, id(6)], "an unparsable time sorts last");

  const merged = mergeSessionDelta(base, [fresh(6)], none);
  assert.ok(merged[0] === base[0] && merged[1] === base[1] && merged[3] === base[2] && merged[4] === base[3]);
  assert.deepEqual(ids(base), [A, B, C, D], "the input list is not modified");
});

test("a stream that cannot be opened is retried", async () => {
  const h = harness({ streamFailures: 1 });
  h.store.retain();
  await flush();
  assert.equal(h.streams.length, 0);
  await h.timers.advance(1000);
  assert.equal(h.streams.length, 1);
});

// ---------------------------------------------------------------------------
// Unread and recent runs
// ---------------------------------------------------------------------------

test("a session that finishes while another is viewed becomes unread and recently completed", async () => {
  const h = await h_ready();
  h.store.setViewedSession(B);
  await h.frame([A, B]);
  assert.equal(h.snap().unread.size, 0, "starting a run marks nothing");

  await h.frame([B]);
  assert.deepEqual([...h.snap().unread], [A]);
  assert.ok(h.snap().recentlyCompleted.has(A));

  await h.frame([]);
  assert.deepEqual([...h.snap().unread], [A], "the viewed session never becomes unread");

  h.store.setViewedSession(A);
  assert.equal(h.snap().unread.size, 0);
});

test("starting a run clears the unread mark, and a running session is not recently completed", async () => {
  const h = await h_ready();
  await h.frame([A]);
  await h.frame([]);
  assert.ok(h.snap().unread.has(A));
  assert.ok(h.snap().recentlyCompleted.has(A));

  await h.frame([A]);
  assert.equal(h.snap().unread.has(A), false);
  assert.equal(h.snap().recentlyCompleted.has(A), false);
});

test("unread marks of sessions that vanish from the list are dropped", async () => {
  const h = await h_ready();
  await h.frame([A, B]);
  await h.frame([]);
  assert.deepEqual([...h.snap().unread].sort(), [A, B].sort());

  h.setServer({ sessions: [session(B)] });
  await h.store.refresh();
  assert.deepEqual([...h.snap().unread], [B]);
});

test("unread and recent runs persist with a debounce, flush on pagehide and on release, and load on start", async () => {
  const storage = new FakeStorage();
  const h = harness({ storage });
  await h.start();
  const writesAfterStart = storage.writes.length;
  await h.frame([A]);
  await h.frame([]);
  await h.frame([B]);
  await h.frame([]);
  assert.equal(storage.writes.length, writesAfterStart, "nothing is written before the debounce elapses");

  await h.timers.advance(PERSIST_DEBOUNCE_MS);
  assert.deepEqual(storage.json(UNREAD_SESSIONS_STORAGE_KEY).sort(), [A, B].sort());
  assert.deepEqual(storage.json(RECENT_RUNS_STORAGE_KEY).map((run) => run.sessionId).sort(), [A, B].sort());
  assert.equal(storage.writes.filter((key) => key === UNREAD_SESSIONS_STORAGE_KEY).length, 1, "one write for the whole burst");

  await h.frame([A]);
  h.env.pagehide.forEach((callback) => callback());
  assert.deepEqual(storage.json(UNREAD_SESSIONS_STORAGE_KEY), [B], "pagehide writes right away");

  await h.frame([]);
  h.store.release();
  assert.deepEqual(storage.json(UNREAD_SESSIONS_STORAGE_KEY).sort(), [A, B].sort(), "release flushes");
  assert.equal(h.timers.pending, 0);

  const restored = harness({ storage });
  assert.equal(restored.snap().unread.size, 0, "nothing is read before the store starts");
  await restored.start();
  assert.deepEqual([...restored.snap().unread].sort(), [A, B].sort());
});

test("clearing the last unread mark removes the stored key; unusable storage is tolerated", async () => {
  const storage = new FakeStorage();
  const h = harness({ storage });
  await h.start();
  await h.frame([A]);
  await h.frame([]);
  await h.timers.advance(PERSIST_DEBOUNCE_MS);
  assert.ok(storage.data.has(UNREAD_SESSIONS_STORAGE_KEY));
  h.store.setViewedSession(A);
  await h.timers.advance(PERSIST_DEBOUNCE_MS);
  assert.equal(storage.data.has(UNREAD_SESSIONS_STORAGE_KEY), false);

  const broken = new FakeStorage();
  broken.getItem = () => { throw new Error("denied"); };
  broken.setItem = () => { throw new Error("quota"); };
  const tolerant = harness({ storage: broken });
  await tolerant.start();
  await tolerant.frame([A]);
  await tolerant.frame([]);
  await tolerant.timers.advance(PERSIST_DEBOUNCE_MS);
  assert.ok(tolerant.snap().unread.has(A));

  const none = harness({ storage: null });
  await none.start();
  await none.frame([A]);
  await none.frame([]);
  assert.ok(none.snap().unread.has(A));
});

test("garbage in storage is ignored", async () => {
  const storage = new FakeStorage();
  storage.data.set(UNREAD_SESSIONS_STORAGE_KEY, "{not json");
  storage.data.set(RECENT_RUNS_STORAGE_KEY, '{"also":"wrong"}');
  const h = await harness({ storage }).start();
  assert.equal(h.snap().unread.size, 0);
  storage.data.set(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([A, 3, null]));
  const again = await harness({ storage }).start();
  assert.deepEqual([...again.snap().unread], [A]);
});

test("the recent-runs limit bounds the recently completed set and is persisted trimmed", async () => {
  const storage = new FakeStorage();
  const h = harness({ storage, recentRunsLimit: 2 });
  h.setServer({
    sessions: [
      session(A, { modified: "2026-03-01T00:00:00.000Z" }),
      session(B, { modified: "2026-03-03T00:00:00.000Z" }),
      session(C, { modified: "2026-03-02T00:00:00.000Z" }),
      session(D, { modified: "2026-03-04T00:00:00.000Z", messageCount: 0, firstMessage: "(no messages)" }),
    ],
  });
  await h.start();
  assert.deepEqual([...h.snap().recentlyCompleted].sort(), [B, C].sort(), "newest two with content; the empty draft never counts");

  h.store.setRecentRunsLimit(3);
  assert.deepEqual([...h.snap().recentlyCompleted].sort(), [A, B, C].sort());
  h.store.setRecentRunsLimit(0);
  assert.equal(h.snap().recentlyCompleted.size, 1, "the limit is at least one");
  assert.deepEqual([...h.snap().recentlyCompleted], [B]);

  await h.timers.advance(PERSIST_DEBOUNCE_MS);
  assert.equal(storage.json(RECENT_RUNS_STORAGE_KEY).length <= 1, true);
});

test("computeRecentlyCompleted: ranking, exclusions and ties", () => {
  const at = (sid, modified, extra = {}) => session(sid, { modified, ...extra });
  const sessions = [
    at(A, "2026-01-01T00:00:00.000Z"),
    at(B, "2026-01-05T00:00:00.000Z"),
    at(C, "2026-01-03T00:00:00.000Z"),
    at(D, "2026-01-09T00:00:00.000Z", { messageCount: 0, firstMessage: "", name: undefined }),
    at(E, "not a date"),
  ];
  const t = (iso) => new Date(iso).getTime();
  const run = (runs, running, limit) => [...computeRecentlyCompleted(runs, sessions, new Set(running), limit)];

  assert.deepEqual(run([], [], 10), [B, C, A], "ordered by modification time; drafts and unparsable dates are out");
  assert.deepEqual(run([], [], 2), [B, C]);
  assert.deepEqual(run([], [B], 2), [C, A], "running sessions are excluded");
  assert.deepEqual(run([], [], 0), []);
  assert.deepEqual(run([{ sessionId: A, completedAt: t("2026-02-01T00:00:00.000Z") }], [], 1), [A], "a recorded run newer than the file wins");
  assert.deepEqual(run([{ sessionId: A, completedAt: t("2025-01-01T00:00:00.000Z") }], [], 1), [B], "a recorded run older than the file does not");
  assert.deepEqual(run([{ sessionId: D, completedAt: t("2026-02-01T00:00:00.000Z") }], [], 1), [D], "a recorded run counts even without content on disk");
  assert.deepEqual(run([{ sessionId: "gone", completedAt: t("2026-02-01T00:00:00.000Z") }], [], 1), ["gone"]);

  const tied = [at(A, "2026-01-01T00:00:00.000Z"), at(B, "2026-01-01T00:00:00.000Z"), at(C, "2026-01-01T00:00:00.000Z")];
  assert.deepEqual([...computeRecentlyCompleted([], tied, new Set(), 2)], [A, B], "ties keep list order");
});

// ---------------------------------------------------------------------------
// Optimistic session, removal, lookup
// ---------------------------------------------------------------------------

test("the optimistic session is kept apart from the list and contributes its cwd", async () => {
  const h = await h_ready();
  const draft = session(D, { cwd: "/work/new", path: "" });
  h.store.applyOptimisticSession(draft);
  assert.equal(h.snap().optimisticSession, draft);
  assert.equal(h.snap().runningCwd.get(D), "/work/new");
  assert.equal(h.snap().sessions.some((entry) => entry.id === D), false);
  assert.equal(h.store.getSession(D), undefined);

  const before = h.snap();
  h.store.clearOptimisticSession(C);
  assert.equal(h.snap(), before, "another id is not cleared");
  h.store.clearOptimisticSession(D);
  assert.equal(h.snap().optimisticSession, null);
  assert.equal(h.snap().runningCwd.has(D), false);

  h.store.applyOptimisticSession(draft);
  h.store.applyOptimisticSession(null);
  assert.equal(h.snap().optimisticSession, null);
});

test("a running session keeps the last cwd it was seen with until it is on disk", async () => {
  const h = await h_ready();
  await h.frame([D], { runningSessions: [{ id: D, cwd: "/work/d" }] });
  assert.equal(h.snap().runningCwd.get(D), "/work/d");
  await h.frame([D], { runningSessions: undefined });
  assert.equal(h.snap().runningCwd.get(D), "/work/d", "a frame without cwds keeps them");
  h.stream().send({ type: "running", runningSessionIds: [D] });
  await flush();
  assert.equal(h.snap().runningCwd.get(D), "/work/d");
});

test("removeSession drops the session everywhere and makes the next fetch unconditional", async () => {
  const h = await h_ready();
  h.store.applyOptimisticSession(session(A));
  await h.frame([A, B], { exitedSessions: [{ id: A, cwd: "/work/a", at: 1, code: 1, signal: null, detail: "" }] });
  await h.frame([]);
  assert.deepEqual([...h.snap().unread].sort(), [A, B].sort());

  h.store.removeSession(A);
  const snap = h.snap();
  assert.deepEqual(snap.sessions.map((entry) => entry.id), [B]);
  assert.deepEqual([...snap.unread], [B]);
  assert.equal(snap.exited.has(A), false);
  assert.equal(snap.optimisticSession, null);
  assert.equal(snap.recentlyCompleted.has(A), false);

  await h.store.refresh();
  assert.equal("If-None-Match" in h.calls.filter((call) => call.url === "/api/sessions").at(-1).headers, false);
  assert.deepEqual(h.snap().sessions.map((entry) => entry.id), [A, B], "the server's answer wins when it still lists the session");

  const count = h.notifications;
  h.store.removeSession("unknown");
  assert.equal(h.notifications, count);
});

test("removeSession unpins in the background and a failed unpin is not rolled back", async () => {
  const h = harness();
  h.server.pinned = [A, P1];
  await h.start();
  const base = h.routes["PATCH /api/session-ui"];
  h.routes["PATCH /api/session-ui"] = () => response({}, { status: 500 });
  h.store.removeSession(A);
  assert.deepEqual(h.snap().pinnedSessionIds, [P1]);
  await flush();
  assert.deepEqual(h.patches(), [{ unpin: [A] }]);
  assert.deepEqual(h.snap().pinnedSessionIds, [P1]);

  h.routes["PATCH /api/session-ui"] = base;
  h.store.removeSession(B);
  assert.equal(h.patches().length, 1, "an unpinned session sends nothing");
});

test("getSession and ensureSession: known sessions cost no request, unknown ones refresh once", async () => {
  const h = await h_ready();
  const base = h.sessionFetches();
  assert.equal(h.store.getSession(A), h.snap().sessions[0]);
  assert.equal(await h.store.ensureSession(A), h.snap().sessions[0]);
  assert.equal(h.sessionFetches(), base);

  assert.equal(await h.store.ensureSession(C), null);
  assert.equal(h.sessionFetches(), base + 1);

  h.setServer({ sessions: [...h.server.sessions, session(C)] });
  const found = await h.store.ensureSession(C);
  assert.equal(found.id, C);
  assert.equal(h.sessionFetches(), base + 2);
  assert.equal(found, h.store.getSession(C));
});

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

async function pinned() {
  const h = harness();
  h.server.pinned = [P2, P1];
  await h.start();
  return h;
}

test("pin is optimistic and adopts the server's list; unpin likewise", async () => {
  const h = await pinned();
  const done = h.store.pin(P3);
  assert.deepEqual(h.snap().pinnedSessionIds, [P3, P2, P1], "visible before the server answered");
  assert.equal(await done, true);
  assert.deepEqual(h.patches(), [{ pin: [P3] }]);
  assert.deepEqual(h.snap().pinnedSessionIds, [P3, P2, P1]);

  h.server.pinned = [P3, P2, P1, P6];
  assert.equal(await h.store.unpin(P2), true);
  assert.deepEqual(h.patches().at(-1), { unpin: [P2] });
  assert.deepEqual(h.snap().pinnedSessionIds, [P3, P1, P6], "the answer is authoritative");
});

test("no request when the pin is already in the wanted state", async () => {
  const h = await pinned();
  assert.equal(await h.store.pin(P1), true);
  assert.equal(await h.store.unpin(P5), true);
  assert.deepEqual(h.patches(), []);
});

test("a refused pin is rolled back and reported, and so is an unpin at its old position", async () => {
  const h = await pinned();
  const base = h.routes["PATCH /api/session-ui"];
  for (const failing of [() => response({}, { status: 500 }), () => { throw new TypeError("offline"); }]) {
    h.routes["PATCH /api/session-ui"] = failing;
    const pin = h.store.pin(P3);
    assert.deepEqual(h.snap().pinnedSessionIds, [P3, P2, P1]);
    assert.equal(await pin, false);
    assert.deepEqual(h.snap().pinnedSessionIds, [P2, P1]);

    const unpin = h.store.unpin(P2);
    assert.deepEqual(h.snap().pinnedSessionIds, [P1]);
    assert.equal(await unpin, false);
    assert.deepEqual(h.snap().pinnedSessionIds, [P2, P1]);
  }
  const unpinLast = h.store.unpin(P1);
  assert.equal(await unpinLast, false);
  assert.deepEqual(h.snap().pinnedSessionIds, [P2, P1], "the last position is restored too");
  h.routes["PATCH /api/session-ui"] = base;
});

test("pin writes reach the server one at a time, in order", async () => {
  const h = await pinned();
  const base = h.routes["PATCH /api/session-ui"];
  const gate = deferred();
  let first = true;
  h.routes["PATCH /api/session-ui"] = async (call) => {
    if (first) {
      first = false;
      await gate.promise;
    }
    return base(call);
  };
  const one = h.store.pin(P4);
  const two = h.store.pin(P5);
  await flush();
  assert.deepEqual(h.patches(), [{ pin: [P4] }], "the second write waits for the first");
  assert.deepEqual(h.snap().pinnedSessionIds, [P5, P4, P2, P1]);

  gate.resolve();
  assert.deepEqual(await Promise.all([one, two]), [true, true]);
  assert.deepEqual(h.patches(), [{ pin: [P4] }, { pin: [P5] }]);
  assert.deepEqual(h.snap().pinnedSessionIds, [P5, P4, P2, P1]);
});

test("a failed write does not undo a newer operation on the same session", async () => {
  const h = await pinned();
  const base = h.routes["PATCH /api/session-ui"];
  const gate = deferred();
  let first = true;
  h.routes["PATCH /api/session-ui"] = async (call) => {
    if (first) {
      first = false;
      await gate.promise;
      return response({}, { status: 500 });
    }
    return base(call);
  };
  const pin = h.store.pin(P4);
  const unpin = h.store.unpin(P4);
  assert.deepEqual(h.snap().pinnedSessionIds, [P2, P1]);
  gate.resolve();
  assert.deepEqual(await Promise.all([pin, unpin]), [false, true]);
  assert.deepEqual(h.snap().pinnedSessionIds, [P2, P1]);
});

test("a pin list fetched before a local change does not overwrite it", async () => {
  const h = await pinned();
  const gate = deferred();
  const base = h.routes["GET /api/session-ui"];
  h.routes["GET /api/session-ui"] = async (call) => {
    const answer = await base(call);
    await gate.promise;
    return answer;
  };
  const reload = h.store.refresh({ sessions: false, pins: true });
  await flush();
  assert.equal(await h.store.pin(P6), true);
  gate.resolve();
  await reload;
  assert.deepEqual(h.snap().pinnedSessionIds, [P6, P2, P1]);

  h.routes["GET /api/session-ui"] = () => response({}, { status: 500 });
  await h.store.refresh({ sessions: false, pins: true });
  assert.deepEqual(h.snap().pinnedSessionIds, [P6, P2, P1], "a failed reload keeps the list");
});

// ---------------------------------------------------------------------------
// Recovery and lifecycle
// ---------------------------------------------------------------------------

test("coming back to the tab or regaining the network reloads sessions and pins through the full-reload limit; hiding does not", async () => {
  const h = await h_ready();
  await h.quiet();
  const sessions = h.sessionFetches();
  const pins = h.pinFetches();

  h.env.visibility.forEach((callback) => callback(false));
  await flush();
  assert.equal(h.sessionFetches(), sessions);
  assert.equal(h.pinFetches(), pins);

  h.env.visibility.forEach((callback) => callback(true));
  await flush();
  assert.equal(h.sessionFetches(), sessions + 1);
  assert.equal(h.pinFetches(), pins + 1);

  h.env.online.forEach((callback) => callback());
  await flush();
  assert.equal(h.pinFetches(), pins + 2, "pins are small and always reloaded");
  assert.equal(h.sessionFetches(), sessions + 1, "the list was just reloaded");
  await h.timers.advance(FULL_REFRESH_MIN_INTERVAL_MS);
  assert.equal(h.sessionFetches(), sessions + 2);
});

test("hiding the tab flushes pending writes", async () => {
  const storage = new FakeStorage();
  const h = harness({ storage });
  await h.start();
  await h.frame([A]);
  await h.frame([]);
  assert.equal(storage.data.has(UNREAD_SESSIONS_STORAGE_KEY), false);
  h.env.visibility.forEach((callback) => callback(false));
  assert.deepEqual(storage.json(UNREAD_SESSIONS_STORAGE_KEY), [A]);
});

test("release stops everything: stream, listeners, timers and requests in flight", async () => {
  const h = harness();
  const gate = deferred();
  const base = h.routes["GET /api/sessions"];
  h.routes["GET /api/sessions"] = async (call) => {
    await gate.promise;
    return base(call);
  };
  h.store.retain();
  await flush();
  const stream = h.stream();
  const inFlight = h.calls.find((call) => call.url === "/api/sessions");
  stream.send({ type: "sessions-changed", refreshSessionList: true });
  const pendingRefresh = h.store.refresh();
  assert.ok(h.timers.pending > 0);

  h.store.release();
  await flush();
  assert.equal(stream.closed, true);
  assert.equal(inFlight.signal.aborted, true);
  assert.equal(h.timers.pending, 0);
  assert.deepEqual([h.env.visibility.size, h.env.online.size, h.env.pagehide.size], [0, 0, 0]);
  await pendingRefresh;

  gate.resolve();
  stream.send({ type: "running", runningSessionIds: [A] });
  await flush();
  assert.equal(h.snap().sessionsStatus, "loading", "a late answer is discarded");
  assert.equal(h.snap().running.size, 0, "a late frame is ignored");
  const calls = h.calls.length;
  await h.timers.advance(60_000);
  assert.equal(h.calls.length, calls, "nothing is requested after release");
  h.env.visibility.forEach((callback) => callback(true));
  assert.equal(h.calls.length, calls);
});

test("retain and release are reference counted; a new start reuses loaded projects and revalidates the list", async () => {
  const h = harness();
  h.store.retain();
  h.store.retain();
  await flush();
  assert.equal(h.streams.length, 1);
  assert.equal(h.sessionFetches(), 1);

  h.store.release();
  assert.equal(h.streams[0].closed, false);
  h.store.release();
  assert.equal(h.streams[0].closed, true);
  h.store.release();
  assert.equal(h.streams[0].closed, true, "releasing too often is harmless");

  const loaded = h.snap();
  h.store.retain();
  await flush();
  assert.equal(h.streams.length, 2);
  assert.equal(h.sessionFetches(), 2);
  assert.equal(h.calls.filter((call) => call.url === "/api/sessions").at(-1).headers["If-None-Match"], '"v1"');
  assert.equal(h.projectFetches(), 1);
  assert.equal(h.snap(), loaded);
});

test("an explicit refresh works on a store nobody retained and leaves no timer behind", async () => {
  const h = harness();
  await h.store.refresh();
  assert.equal(h.snap().sessionsStatus, "ready");
  assert.equal(h.timers.pending, 0);
  assert.equal(h.streams.length, 0);
});

// ---------------------------------------------------------------------------
// New workspaces
// ---------------------------------------------------------------------------

test("a session in a directory the project list lacks makes the store re-list projects, once", async () => {
  const h = harness();
  h.setServer({ sessions: [session(A), session(B, { projectRoot: "/work/hidden", cwd: "/work/hidden" })] });
  await h.start();
  assert.equal(h.projectFetches(), 1, "roots present at the first look are the baseline (hidden projects have sessions too)");

  h.setServer({ sessions: [...h.server.sessions, session(C, { projectRoot: "/work/a/sub", cwd: "/work/a/sub" })] });
  await h.store.refresh();
  assert.equal(h.projectFetches(), 2);

  await h.store.refresh({ force: true });
  h.setServer({ sessions: [...h.server.sessions, session(D, { projectRoot: "/work/a/sub", cwd: "/work/a/sub" })] });
  await h.store.refresh();
  assert.equal(h.projectFetches(), 2, "a root that was probed is not probed again");
});

test("roots are compared the way projects are: Windows paths ignore case and separators", async () => {
  const h = harness();
  h.server.projects = [{ path: "C:\\Work\\App" }];
  await h.start();
  h.setServer({ sessions: [...h.server.sessions, session(C, { projectRoot: "c:/work/app", cwd: "c:/work/app" })] });
  await h.store.refresh();
  assert.equal(h.projectFetches(), 1);
});

// ---------------------------------------------------------------------------
// Selector helpers
// ---------------------------------------------------------------------------

test("shallowEqualSet compares contents", () => {
  const set = (...items) => new Set(items);
  for (const [a, b, equal] of [
    [set(), set(), true],
    [set(1, 2), set(2, 1), true],
    [set(1), set(1, 2), false],
    [set(1, 2), set(1, 3), false],
  ]) {
    assert.equal(shallowEqualSet(a, b), equal);
  }
  const same = set(1);
  assert.equal(shallowEqualSet(same, same), true);
});

test("selectWithCache reuses the value while the input is unchanged and the previous one while the result is equal", () => {
  const cache = { current: null };
  const snapshotA = { n: 1 };
  const snapshotB = { n: 2 };
  let runs = 0;
  const selector = (snapshot) => { runs += 1; return { even: snapshot.n % 2 === 0 }; };
  const sameEven = (x, y) => x.even === y.even;

  const first = selectWithCache(cache, snapshotA, selector, sameEven);
  assert.equal(selectWithCache(cache, snapshotA, selector, sameEven), first);
  assert.equal(runs, 1);

  const second = selectWithCache(cache, snapshotB, selector, sameEven);
  assert.notEqual(second, first);
  assert.equal(selectWithCache(cache, { n: 4 }, selector, sameEven), second, "an equal result keeps the old identity");

  const other = (snapshot) => ({ even: snapshot.n % 2 === 1 });
  assert.notEqual(selectWithCache(cache, { n: 4 }, other, sameEven), second, "a new selector is evaluated");
  assert.notEqual(selectWithCache({ current: null }, snapshotA, selector, Object.is), selectWithCache({ current: null }, snapshotA, selector, Object.is), "without an equality, fresh objects are fresh");
});
