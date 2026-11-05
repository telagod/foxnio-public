import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { act, cleanup, renderHook } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { useSessionTabs } = await jiti.import("./useSessionTabs.ts");
const { SESSION_TABS_STORAGE_KEY, serializeSessionTabs } = await jiti.import("@/lib/session-tabs");

const EMPTY = { sessions: [], sessionsStatus: "loading", running: new Set() };

/** A stand-in for the page-wide session store that `getSessionStore()` hands out. */
function installStore(initial = {}) {
  let snapshot = { ...EMPTY, ...initial };
  const listeners = new Set();
  const ensured = [];
  const store = {
    ensured,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => EMPTY,
    async ensureSession(id) {
      ensured.push(id);
      return snapshot.sessions.find((session) => session.id === id) ?? null;
    },
    publish(next) {
      snapshot = { ...snapshot, ...next };
      for (const listener of [...listeners]) listener();
    },
  };
  globalThis.__ompSessionStore = store;
  return store;
}

const session = (id, extra = {}) => ({ id, cwd: "/work", name: `Session ${id}`, firstMessage: "", ...extra });
const storedTab = (id, title = id) => ({ id, title, cwd: "/work" });

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(SESSION_TABS_STORAGE_KEY, serializeSessionTabs([storedTab("a", "old a"), storedTab("b")]));
});
afterEach(() => {
  cleanup();
  delete globalThis.__ompSessionStore;
});

const mount = (props = {}) => renderHook(() => useSessionTabs({ enabled: true, selectedSession: null, ...props }));

test("stored tabs survive until the session list has loaded", async () => {
  const store = installStore();
  const { result } = mount();
  await act(async () => {});
  assert.deepEqual(result.current.tabs.map((tab) => tab.id), ["a", "b"]);

  await act(async () => store.publish({ sessions: [], sessionsStatus: "loading" }));
  assert.deepEqual(result.current.tabs.map((tab) => tab.id), ["a", "b"]);
});

test("a loaded list refreshes tab titles and drops sessions that are gone", async () => {
  const store = installStore();
  const { result } = mount();
  await act(async () => {});

  await act(async () => store.publish({ sessions: [session("a", { name: "Renamed" })], sessionsStatus: "ready" }));
  assert.deepEqual(result.current.tabs.map((tab) => [tab.id, tab.title]), [["a", "Renamed"]]);
});

test("a session opened this page load is kept although the list does not have it yet", async () => {
  const store = installStore();
  const opened = session("fresh");
  const { result } = mount({ selectedSession: opened });
  await act(async () => {});

  await act(async () => store.publish({ sessions: [session("a")], sessionsStatus: "ready" }));
  assert.deepEqual(result.current.tabs.map((tab) => tab.id).sort(), ["a", "fresh"]);
});

test("the list is not reconciled while tabs are disabled", async () => {
  const store = installStore();
  const { result } = mount({ enabled: false });
  await act(async () => store.publish({ sessions: [], sessionsStatus: "ready" }));
  assert.deepEqual(result.current.tabs, []);
  assert.equal(window.localStorage.getItem(SESSION_TABS_STORAGE_KEY).includes('"a"'), true);
});

test("resolveSession answers the selected session from its cache and the rest from the store", async () => {
  const store = installStore({ sessions: [session("b"), session("c")], sessionsStatus: "ready" });
  const selected = session("a");
  const { result } = mount({ selectedSession: selected });
  await act(async () => {});

  assert.equal(await result.current.resolveSession("a"), selected);
  assert.deepEqual(store.ensured, []);
  assert.equal((await result.current.resolveSession("b")).id, "b", "a tab is served from the cache the list filled");
  assert.equal((await result.current.resolveSession("c")).id, "c");
  assert.equal(await result.current.resolveSession("missing"), null);
  assert.deepEqual(store.ensured, ["c", "missing"]);

  await act(async () => store.publish({ sessionsStatus: "error" }));
  assert.equal(await result.current.resolveSession("missing"), "unavailable");
});
