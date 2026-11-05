import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSidebarSearch, MAX_SEARCH_HITS, MAX_SEARCH_QUERY_LENGTH, SEARCH_DEBOUNCE_MS, SEARCH_MERGE_INTERVAL_MS } = await jiti.import("./sidebar-search.ts");
const { searchField } = await jiti.import("./session-search.ts");

const NDJSON = "application/x-ndjson; charset=utf-8";
const encoder = new TextEncoder();

/** Let promise continuations and stream reads run. */
async function settle() {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

function createClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, ms) {
      const id = ++seq;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    get pending() {
      return timers.size;
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        let next;
        for (const [id, timer] of timers) if (timer.at <= target && (!next || timer.at < next.timer.at)) next = { id, timer };
        if (!next) break;
        timers.delete(next.id);
        now = Math.max(now, next.timer.at);
        next.timer.callback();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}

/**
 * Fake `fetch` whose response bodies are streams the test feeds by hand.
 * Text is cut into `chunkSize`-byte pieces, so lines and multi-byte
 * characters regularly straddle chunk boundaries.
 */
function createFetch(plan = () => ({}), chunkSize = 3) {
  const requests = [];
  const fetch = (url, { signal }) => {
    const options = plan(url, requests.length);
    if (options.reject) return Promise.reject(options.reject);
    let controller;
    const request = {
      url,
      signal,
      cancelled: false,
      push(text) {
        const bytes = encoder.encode(text);
        try {
          for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
        } catch {
          // The reader already went away; a real server would see a closed socket.
        }
      },
      batch(scores) {
        request.push(`${JSON.stringify({ scores })}\n`);
      },
      fail() {
        try {
          controller.error(new TypeError("network error"));
        } catch {
          // already closed
        }
      },
      close() {
        try {
          controller.close();
        } catch {
          // already errored or cancelled
        }
      },
    };
    const stream = new ReadableStream({
      start(c) {
        controller = c;
      },
      cancel() {
        request.cancelled = true;
      },
    });
    signal.addEventListener("abort", () => {
      try {
        controller.error(new DOMException("aborted", "AbortError"));
      } catch {
        // already closed
      }
    });
    requests.push(request);
    return Promise.resolve(new Response(stream, { status: options.status ?? 200, headers: { "content-type": options.type ?? NDJSON } }));
  };
  return { fetch, requests };
}

function setup({ plan, chunkSize } = {}) {
  const clock = createClock();
  const net = createFetch(plan, chunkSize);
  const fieldTexts = [];
  const controller = createSidebarSearch({
    fetch: net.fetch,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    searchField(text, weight) {
      fieldTexts.push(text);
      return searchField(text, weight);
    },
  });
  const notifications = [];
  controller.subscribe(() => notifications.push(controller.getSnapshot()));
  return { controller, clock, requests: net.requests, fieldTexts, notifications };
}

let counter = 0;
function session(id, name, firstMessage = "", extra = {}) {
  counter += 1;
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd: "/work/app",
    name,
    created: "2026-01-01T00:00:00.000Z",
    modified: `2026-01-01T00:00:${String(counter % 60).padStart(2, "0")}.000Z`,
    messageCount: 1,
    firstMessage,
    ...extra,
  };
}

const ids = (state) => state.hits.map((hit) => hit.sessionId);
const queryOf = (url) => new URL(url, "http://localhost").searchParams.get("q");

test("blank or word-less queries produce no search and no network", async () => {
  const { controller, clock, requests, notifications } = setup();
  controller.setSessions([session("a", "login bug")], []);
  for (const raw of ["", "   ", "!!! ???", '""']) {
    controller.setQuery(raw);
    assert.equal(controller.getSnapshot(), null, JSON.stringify(raw));
  }
  await clock.advance(5000);
  assert.equal(requests.length, 0);
  assert.equal(clock.pending, 0);
  assert.equal(notifications.length, 0);
});

test("local hits are available synchronously, ranked title > first message, without waiting for the network", () => {
  const { controller, requests } = setup();
  controller.setSessions(
    [session("first-message", "refactor", "please fix the login flow"), session("title", "Login page"), session("none", "unrelated", "nothing")],
    [],
  );
  controller.setQuery("login");
  const state = controller.getSnapshot();
  assert.deepEqual(ids(state), ["title", "first-message"]);
  assert.ok(state.hits[0].score > state.hits[1].score);
  assert.equal(state.query, "login");
  assert.equal(state.searching, true);
  assert.equal(requests.length, 0);
});

test("hits never carry a snippet: the route returns scores only", async () => {
  const { controller, clock, requests } = setup();
  controller.setSessions([session("a", "needle")], []);
  controller.setQuery("needle");
  await clock.advance(SEARCH_DEBOUNCE_MS);
  requests[0].batch({ a: 150, b: 20 });
  await settle();
  for (const hit of controller.getSnapshot().hits) assert.equal(hit.snippet, undefined);
});

test("the stream starts only after the debounce and only for the last query", async () => {
  const { controller, clock, requests } = setup();
  controller.setSessions([session("a", "abc")], []);
  controller.setQuery("a");
  await clock.advance(200);
  controller.setQuery("ab");
  await clock.advance(200);
  assert.equal(requests.length, 0);
  await clock.advance(50);
  assert.equal(requests.length, 1);
  assert.equal(queryOf(requests[0].url), "ab");
  assert.equal(new URL(requests[0].url, "http://localhost").pathname, "/api/sessions/search");
});

test("the query is sent trimmed and URL-encoded", async () => {
  const { controller, clock, requests } = setup();
  controller.setQuery("  foo bar&baz=1 #hash 你好  ");
  await clock.advance(SEARCH_DEBOUNCE_MS);
  assert.equal(queryOf(requests[0].url), "foo bar&baz=1 #hash 你好");
});

test("a new query aborts the running request and discards its scores", async () => {
  const { controller, clock, requests } = setup();
  controller.setSessions([session("old", "alpha"), session("new", "beta")], []);
  controller.setQuery("alpha");
  await clock.advance(SEARCH_DEBOUNCE_MS);
  requests[0].batch({ old: 500 });
  await settle();
  assert.equal(controller.getSnapshot().hits[0].score, 500);

  controller.setQuery("beta");
  assert.equal(requests[0].signal.aborted, true);
  assert.deepEqual(ids(controller.getSnapshot()), ["new"]);
  requests[0].batch({ old: 900 });
  await settle();
  await clock.advance(SEARCH_DEBOUNCE_MS);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].signal.aborted, false);
  requests[1].batch({ new: 300 });
  await settle();
  const state = controller.getSnapshot();
  assert.deepEqual(state.hits.map((hit) => [hit.sessionId, hit.score]), [["new", 300]]);
});

test("searching spans debounce and stream, and ends when the stream completes", async () => {
  const { controller, clock, requests } = setup();
  controller.setSessions([session("a", "needle")], []);
  controller.setQuery("needle");
  assert.equal(controller.getSnapshot().searching, true);
  await clock.advance(SEARCH_DEBOUNCE_MS);
  assert.equal(controller.getSnapshot().searching, true);
  requests[0].batch({});
  requests[0].close();
  await settle();
  assert.equal(controller.getSnapshot().searching, false);
  assert.deepEqual(ids(controller.getSnapshot()), ["a"]);
});

test("a final line without a trailing newline still counts, multi-byte ids survive byte-split chunks", async () => {
  const { controller, clock, requests } = setup({ chunkSize: 2 });
  controller.setSessions([session("会话-1", "needle"), session("会话-2", "needle two")], []);
  controller.setQuery("needle");
  await clock.advance(SEARCH_DEBOUNCE_MS);
  requests[0].batch({ "会话-2": 400 });
  requests[0].push(JSON.stringify({ scores: { "会话-1": 300 } }));
  requests[0].close();
  await settle();
  const state = controller.getSnapshot();
  assert.deepEqual(state.hits.map((hit) => [hit.sessionId, hit.score]), [["会话-2", 400], ["会话-1", 300]]);
  assert.equal(state.searching, false);
});

test("stop keeps hits (including unmerged ones), ends searching and aborts the request", async () => {
  const { controller, clock, requests } = setup();
  controller.setSessions([session("a", "x1"), session("b", "x2"), session("c", "x3")], []);
  controller.setQuery("needle");
  await clock.advance(SEARCH_DEBOUNCE_MS);
  requests[0].batch({ a: 10 });
  await settle();
  requests[0].batch({ b: 20 });
  await settle();
  assert.deepEqual(ids(controller.getSnapshot()), ["a"]);
  assert.ok(clock.pending > 0);

  controller.stop();
  assert.equal(requests[0].signal.aborted, true);
  const state = controller.getSnapshot();
  assert.equal(state.searching, false);
  assert.deepEqual(ids(state), ["b", "a"]);
  assert.equal(clock.pending, 0);

  const seen = state;
  requests[0].batch({ c: 99 });
  await clock.advance(5000);
  assert.equal(controller.getSnapshot(), seen);
  controller.stop();
  assert.equal(controller.getSnapshot(), seen);
});

test("stop during the debounce cancels the request before it exists", async () => {
  const { controller, clock, requests } = setup();
  controller.setSessions([session("a", "needle")], []);
  controller.setQuery("needle");
  await clock.advance(100);
  controller.stop();
  await clock.advance(5000);
  assert.equal(requests.length, 0);
  assert.equal(controller.getSnapshot().searching, false);
  assert.deepEqual(ids(controller.getSnapshot()), ["a"]);
});

test("typing the same query again after stop does not restart the search; a changed one does", async () => {
  const { controller, clock, requests } = setup();
  controller.setSessions([session("a", "needle")], []);
  controller.setQuery("needle");
  await clock.advance(SEARCH_DEBOUNCE_MS);
  controller.stop();
  controller.setQuery("needle ");
  await clock.advance(5000);
  assert.equal(requests.length, 1);
  assert.equal(controller.getSnapshot().searching, false);
  controller.setQuery("needle x");
  await clock.advance(SEARCH_DEBOUNCE_MS);
  assert.equal(requests.length, 2);
});

test("streamed batches merge at most every 200 ms: first at once, the rest coalesced", async () => {
  const { controller, clock, requests, notifications } = setup();
  controller.setSessions(["a", "b", "c", "d"].map((id) => session(id, `item ${id}`)), []);
  controller.setQuery("needle");
  await clock.advance(SEARCH_DEBOUNCE_MS);
  const started = notifications.length;

  requests[0].batch({ a: 1 });
  await settle();
  assert.equal(notifications.length, started + 1);
  assert.deepEqual(ids(controller.getSnapshot()), ["a"]);

  await clock.advance(50);
  requests[0].batch({ b: 2 });
  await settle();
  await clock.advance(50);
  requests[0].batch({ c: 3 });
  await settle();
  assert.equal(notifications.length, started + 1);
  assert.deepEqual(ids(controller.getSnapshot()), ["a"]);

  await clock.advance(SEARCH_MERGE_INTERVAL_MS - 100);
  assert.equal(notifications.length, started + 2);
  assert.deepEqual(ids(controller.getSnapshot()), ["c", "b", "a"]);

  requests[0].batch({ d: 4 });
  await settle();
  assert.equal(notifications.length, started + 2, "inside the interval after the last merge");
  requests[0].close();
  await settle();
  assert.equal(notifications.length, started + 3, "end of stream merges the rest and clears searching in one notification");
  assert.deepEqual(ids(controller.getSnapshot()), ["d", "c", "b", "a"]);
  assert.equal(controller.getSnapshot().searching, false);
  assert.equal(clock.pending, 0);
});

test("ranking: best score first, transcript scores lift sessions, lower ones never demote, ties prefer newer", async () => {
  const { controller, clock, requests } = setup();
  controller.setSessions(
    [
      session("title", "needle"),
      session("first", "other", "needle inside"),
      session("content-only", "unrelated"),
      session("tie-old", "needle", "", { modified: "2026-01-01T00:00:01.000Z" }),
      session("tie-new", "needle", "", { modified: "2026-02-01T00:00:00.000Z" }),
    ],
    [],
  );
  controller.setQuery("needle");
  const local = controller.getSnapshot();
  assert.deepEqual(ids(local), ["tie-new", "title", "tie-old", "first"]);
  const titleScore = local.hits.find((hit) => hit.sessionId === "title").score;

  await clock.advance(SEARCH_DEBOUNCE_MS);
  requests[0].batch({ "content-only": 12, first: titleScore + 5, title: 1, unknown: 9999 });
  await settle();
  const state = controller.getSnapshot();
  assert.deepEqual(ids(state), ["first", "tie-new", "title", "tie-old", "content-only"]);
  assert.equal(state.hits.find((hit) => hit.sessionId === "title").score, titleScore);
  for (let i = 1; i < state.hits.length; i++) assert.ok(state.hits[i - 1].score >= state.hits[i].score);
});

test("retained hits are capped at 200, best first", () => {
  const { controller } = setup();
  const many = Array.from({ length: 300 }, (_, i) =>
    session(`s${i}`, "needle", "", { modified: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() }),
  );
  controller.setSessions(many, []);
  controller.setQuery("needle");
  const state = controller.getSnapshot();
  assert.equal(state.hits.length, MAX_SEARCH_HITS);
  assert.equal(state.hits[0].sessionId, "s299");
  assert.equal(state.hits.at(-1).sessionId, "s100");
});

test("quoted phrases must appear verbatim; an unclosed quote is a phrase in progress", () => {
  const { controller } = setup();
  controller.setSessions(
    [
      session("exact", "Fix login bug"),
      session("scattered", "login: please fix"),
      session("typographic", "x", "we should Fix  Login soon"),
    ],
    [],
  );
  controller.setQuery('"fix login"');
  assert.deepEqual(ids(controller.getSnapshot()).sort(), ["exact", "typographic"]);
  controller.setQuery("“fix login”");
  assert.deepEqual(ids(controller.getSnapshot()).sort(), ["exact", "typographic"]);
  controller.setQuery('"fix lo');
  assert.deepEqual(ids(controller.getSnapshot()).sort(), ["exact", "typographic"]);
  controller.setQuery('"fix login" bug');
  assert.deepEqual(ids(controller.getSnapshot()), ["exact"]);
  controller.setQuery('"no such phrase"');
  assert.deepEqual(ids(controller.getSnapshot()), []);
});

test("workspace label and alias match their sessions, below title matches", () => {
  const { controller } = setup();
  const projects = [{ path: "/work/app", alias: "Payments" }, { path: "/work/gateway-api" }];
  const sessions = [
    session("in-app-1", "refactor"),
    session("in-app-2", "cleanup"),
    session("in-gateway", "tidy", "", { cwd: "/work/gateway-api/pkg", projectRoot: "/work/gateway-api" }),
    session("titled", "payments cleanup", "", { cwd: "/elsewhere" }),
  ];
  controller.setSessions(sessions, projects);

  controller.setQuery("payments");
  const byAlias = controller.getSnapshot();
  assert.equal(ids(byAlias)[0], "titled");
  assert.deepEqual(ids(byAlias).slice(1).sort(), ["in-app-1", "in-app-2"]);
  assert.ok(byAlias.hits[0].score > byAlias.hits[1].score);

  controller.setQuery("gateway");
  assert.deepEqual(ids(controller.getSnapshot()), ["in-gateway"]);
  controller.setQuery("app cleanup");
  assert.deepEqual(ids(controller.getSnapshot()), ["in-app-2"]);
  controller.setQuery("nonexistent");
  assert.deepEqual(ids(controller.getSnapshot()), []);
});

test("workspace matching folds case for Windows-form paths and follows alias edits", () => {
  const { controller, fieldTexts } = setup();
  const win = session("win", "x", "", { cwd: "c:\\work\\app\\sub", projectKey: "c:/work/app" });
  controller.setSessions([win], [{ path: "C:\\Work\\App" }]);
  controller.setQuery("app");
  assert.deepEqual(ids(controller.getSnapshot()), ["win"]);

  const before = fieldTexts.length;
  controller.setSessions([win], [{ path: "C:\\Work\\App", alias: "Billing" }]);
  controller.setQuery("billing");
  assert.deepEqual(ids(controller.getSnapshot()), ["win"]);
  assert.deepEqual(fieldTexts.slice(before), ["App", "Billing"], "only the edited workspace is re-indexed");
});

test("search fields are built once per session version and invalidated only for changed sessions", () => {
  const { controller, fieldTexts } = setup();
  const a = session("a", "alpha title", "alpha first");
  const b = session("b", "beta title", "beta first");
  const c = session("c", "gamma title", "gamma first");
  controller.setSessions([a, b, c], []);
  assert.equal(fieldTexts.length, 0, "nothing is indexed while there is no query");

  controller.setQuery("title");
  assert.equal(fieldTexts.length, 6);
  controller.setQuery("alpha");
  controller.setQuery('"beta first"');
  assert.equal(fieldTexts.length, 6, "new queries reuse the cached fields");

  controller.setSessions([{ ...a }, { ...b }, { ...c, messageCount: 99 }], []);
  assert.equal(fieldTexts.length, 6, "new objects with the same indexed content hit the cache");

  controller.setSessions([a, b, { ...c, name: "gamma renamed" }], []);
  assert.deepEqual(fieldTexts.slice(6), ["gamma renamed", "gamma first"]);

  controller.setSessions([a, b, { ...c, name: "gamma renamed", modified: "2030-01-01T00:00:00.000Z" }], []);
  assert.equal(fieldTexts.length, 8 + 2, "a new `modified` rebuilds that session");

  controller.setSessions([a, b, { ...c, name: "gamma renamed", modified: "2030-01-01T00:00:00.000Z", firstMessage: "new first" }], []);
  assert.deepEqual(fieldTexts.slice(10), ["gamma renamed", "new first"]);
});

test("sessions that disappear are evicted from the cache and rebuilt when they return", () => {
  const { controller, fieldTexts } = setup();
  const a = session("a", "alpha");
  const b = session("b", "beta");
  controller.setSessions([a, b], []);
  controller.setQuery("a");
  assert.equal(fieldTexts.length, 4);
  controller.setSessions([a], []);
  assert.equal(fieldTexts.length, 4);
  controller.setSessions([a, b], []);
  assert.equal(fieldTexts.length, 6);
});

test("query length is clamped to the server limit without splitting surrogate pairs", async () => {
  const { controller, clock, requests } = setup();
  controller.setQuery("x".repeat(MAX_SEARCH_QUERY_LENGTH + 100));
  assert.equal(controller.getSnapshot().query.length, MAX_SEARCH_QUERY_LENGTH);
  await clock.advance(SEARCH_DEBOUNCE_MS);
  assert.equal(queryOf(requests[0].url).length, MAX_SEARCH_QUERY_LENGTH);

  const cases = [
    ["a".repeat(MAX_SEARCH_QUERY_LENGTH - 1) + "😀", MAX_SEARCH_QUERY_LENGTH - 1],
    ["a".repeat(MAX_SEARCH_QUERY_LENGTH - 1) + " b", MAX_SEARCH_QUERY_LENGTH - 1],
    ["a".repeat(MAX_SEARCH_QUERY_LENGTH - 2) + "😀", MAX_SEARCH_QUERY_LENGTH],
  ];
  for (const [raw, expected] of cases) {
    controller.setQuery(raw);
    assert.equal(controller.getSnapshot().query.length, expected);
    await clock.advance(SEARCH_DEBOUNCE_MS);
    assert.equal(queryOf(requests.at(-1).url).length, expected);
  }
});

test("failures end the transcript stage quietly and keep the local hits", async (t) => {
  const failures = [
    ["HTML login page", { type: "text/html; charset=utf-8" }],
    ["JSON error body", { status: 400, type: "application/json" }],
    ["HTTP 500 with ndjson type", { status: 500 }],
    ["network error", { reject: new TypeError("Failed to fetch") }],
  ];
  for (const [label, options] of failures) {
    await t.test(label, async () => {
      const { controller, clock, requests } = setup({ plan: () => options });
      controller.setSessions([session("a", "needle")], []);
      controller.setQuery("needle");
      await clock.advance(SEARCH_DEBOUNCE_MS);
      await settle();
      const state = controller.getSnapshot();
      assert.equal(state.searching, false);
      assert.deepEqual(ids(state), ["a"]);
      assert.equal(clock.pending, 0);
      if (requests[0]) assert.equal(requests[0].cancelled, true, "the unusable body is released");
    });
  }
});

test("a malformed line mid-stream ends the stage, keeping batches read before it", async () => {
  const { controller, clock, requests } = setup();
  controller.setSessions(["a", "b"].map((id) => session(id, `item ${id}`)), []);
  controller.setQuery("needle");
  await clock.advance(SEARCH_DEBOUNCE_MS);
  requests[0].push('{"scores":{"a":5}}\nthis is not json\n{"scores":{"b":6}}\n');
  await settle();
  const state = controller.getSnapshot();
  assert.deepEqual(ids(state), ["a"]);
  assert.equal(state.searching, false);
  assert.equal(requests[0].cancelled, true);
});

test("lines with an unexpected shape are skipped, not fatal", async () => {
  const { controller, clock, requests } = setup();
  controller.setSessions(["a", "b"].map((id) => session(id, `item ${id}`)), []);
  controller.setQuery("needle");
  await clock.advance(SEARCH_DEBOUNCE_MS);
  requests[0].push('\n[1,2]\n{"other":1}\n{"scores":[1]}\n{"scores":{"a":"x","b":7}}\n');
  requests[0].close();
  await settle();
  assert.deepEqual(controller.getSnapshot().hits.map((hit) => [hit.sessionId, hit.score]), [["b", 7]]);
});

test("a stream that dies mid-way keeps what arrived, merges the unmerged rest and stops searching", async () => {
  const { controller, clock, requests } = setup();
  controller.setSessions([session("a", "item a")], []);
  controller.setQuery("needle");
  await clock.advance(SEARCH_DEBOUNCE_MS);
  requests[0].batch({ a: 5 });
  await settle();
  await clock.advance(10);
  requests[0].batch({ a: 8 });
  await settle();
  assert.equal(controller.getSnapshot().hits[0].score, 5);
  requests[0].fail();
  await settle();
  const state = controller.getSnapshot();
  assert.equal(state.hits[0].score, 8);
  assert.equal(state.searching, false);
  assert.equal(clock.pending, 0);
});

test("subscribers are notified only when the snapshot really changes", async () => {
  const { controller, clock, requests, notifications } = setup();
  const sessions = [session("a", "needle one"), session("b", "needle two")];
  const projects = [{ path: "/work/app" }];
  controller.setSessions(sessions, projects);
  assert.equal(notifications.length, 0, "no query, no snapshot");

  controller.setQuery("needle");
  assert.equal(notifications.length, 1);
  const state = controller.getSnapshot();
  assert.equal(controller.getSnapshot(), state, "stable identity between reads");

  controller.setQuery("needle");
  controller.setQuery("  needle  ");
  controller.setSessions(sessions, projects);
  controller.setSessions([...sessions], [...projects]);
  assert.equal(notifications.length, 1);
  assert.equal(controller.getSnapshot(), state);

  await clock.advance(SEARCH_DEBOUNCE_MS);
  requests[0].batch({});
  await settle();
  assert.equal(notifications.length, 1, "an empty batch changes nothing");
  requests[0].batch({ a: 1 });
  await settle();
  assert.equal(notifications.length, 1, "a score below the local one changes nothing");
  assert.equal(controller.getSnapshot(), state);

  requests[0].close();
  await settle();
  assert.equal(notifications.length, 2);
  const done = controller.getSnapshot();
  assert.equal(done.searching, false);
  assert.equal(done.hits, state.hits, "the hit list keeps its identity when only `searching` flips");

  controller.setSessions([session("c", "needle three"), ...sessions], projects);
  assert.equal(notifications.length, 3);
  controller.setQuery("");
  assert.equal(notifications.length, 4);
  assert.equal(controller.getSnapshot(), null);
  controller.setQuery("   ");
  assert.equal(notifications.length, 4);
});

test("unsubscribed listeners are not called", () => {
  const { controller } = setup();
  let calls = 0;
  const unsubscribe = controller.subscribe(() => calls++);
  controller.setSessions([session("a", "needle")], []);
  controller.setQuery("needle");
  assert.equal(calls, 1);
  unsubscribe();
  controller.setQuery("needle x");
  assert.equal(calls, 1);
});

test("dispose aborts the request, clears timers and silences listeners", async () => {
  const { controller, clock, requests, notifications } = setup();
  controller.setSessions([session("a", "item")], []);
  controller.setQuery("needle");
  await clock.advance(SEARCH_DEBOUNCE_MS);
  requests[0].batch({ a: 1 });
  await settle();
  requests[0].batch({ a: 2 });
  await settle();
  assert.ok(clock.pending > 0);
  const seen = notifications.length;

  controller.dispose();
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(clock.pending, 0);
  requests[0].batch({ a: 3 });
  await clock.advance(5000);
  assert.equal(notifications.length, seen);

  controller.setQuery("other");
  assert.equal(notifications.length, seen, "disposed listeners stay gone");
});

test("dispose during the debounce cancels the pending request", async () => {
  const { controller, clock, requests } = setup();
  controller.setQuery("needle");
  controller.dispose();
  await clock.advance(5000);
  assert.equal(requests.length, 0);
});
