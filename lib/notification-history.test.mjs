import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createNotificationHistory } = await jiti.import("./notification-history.ts");
const { createDataStore } = await jiti.import("./data-store.ts");
const entry = (sessionId, read = false, type = "input") => ({ id: `${sessionId}:${type}`, event: { type, sessionId, sessionName: sessionId }, at: 1, read });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const settle = async () => { for (let n = 0; n < 100; n++) await Promise.resolve(); };
function harness() {
  let entries = [entry("a"), entry("b")], revision = 1, failing = false, hold = null;
  const calls = [], streams = [];
  const fetch = async (path, init = {}) => {
    const url = new URL(path, "http://test"); calls.push([init.method ?? "GET", url.pathname]);
    if (url.pathname === "/api/notifications/history") {
      assert.notEqual(init.method ?? "GET", "GET", "history reads belong to shared durable snapshots");
      if (hold) await hold;
      if (failing) return response({}, 503);
      if (init.method === "PATCH") { const { ids } = JSON.parse(init.body); entries = entries.map((item) => ids.includes(item.id) ? { ...item, read: true } : item); }
      if (init.method === "DELETE") entries = url.searchParams.has("all") ? [] : entries.filter((item) => item.id !== url.searchParams.get("id"));
      revision++; return response({ ok: true });
    }
    if (init.method === "DELETE") return response({ ok: true });
    if (failing) return response({ error: "offline" }, 503);
    const cursor = { generation: "one", revision };
    if (url.pathname.endsWith("changes")) return response({ cursor, through: cursor, changes: [], hasMore: false });
    return response({ token: "reader", next: false, cursor, complete: true, staleSources: [], warnings: [], data: { sessions: [], projects: [], pins: [], notifications: entries, foxWorkspace: "/fox", foxPointer: { sessionId: null, resetAt: null }, foxObservation: {} } });
  };
  const dataStore = createDataStore({ fetch, openStream: () => { const stream = { close() {}, onopen: null, onmessage: null, onerror: null, readyState: 1 }; streams.push(stream); return stream; } });
  const history = createNotificationHistory({ dataStore, fetch });
  return { history, dataStore, calls, async load() { await history.load(); }, set(value) { entries = value; revision++; }, fail(value) { failing = value; }, hold() { let release; hold = new Promise((resolve) => { release = resolve; }); return release; } };
}

test("history loads from the complete shared snapshot and errors retain visible entries", async () => {
  const h = harness(); await h.load(); assert.deepEqual(h.history.get().map((item) => item.id), ["a:input", "b:input"]);
  const before = h.history.get(); h.fail(true); await h.load(); assert.equal(h.history.get(), before);
});

test("read state is optimistic while in flight, then reflects committed history", async () => {
  const h = harness(); await h.load(); const release = h.hold();
  h.history.markSessionInputRead("a"); assert.deepEqual(h.history.get().map((item) => item.read), [true, false]);
  h.set([entry("new"), entry("a"), entry("b")]); await h.load();
  assert.deepEqual(h.history.get().map((item) => [item.id, item.read]), [["new:input", false], ["a:input", true], ["b:input", false]]);
  release(); await settle(); assert.deepEqual(h.history.get().map((item) => [item.id, item.read]), [["new:input", false], ["a:input", true], ["b:input", false]]);
});

test("failed mutations roll back without losing newer server notifications", async () => {
  const h = harness(); await h.load(); h.fail(true); h.history.remove("a:input");
  assert.deepEqual(h.history.get().map((item) => item.id), ["b:input"]); await settle();
  assert.deepEqual(h.history.get().map((item) => item.id), ["a:input", "b:input"]);
  h.fail(false); h.set([entry("new"), entry("b")]); await h.load(); assert.deepEqual(h.history.get().map((item) => item.id), ["new:input", "b:input"]);
});

test("mark-all affects only the displayed ids and commands preserve ordering", async () => {
  const h = harness(); await h.load(); const release = h.hold(); h.history.markAllRead();
  h.set([entry("new"), entry("a"), entry("b")]); release(); await settle();
  assert.deepEqual(h.history.get().map((item) => [item.id, item.read]), [["new:input", false], ["a:input", true], ["b:input", true]]);
  h.history.remove("a:input"); h.history.clear(); await settle(); assert.deepEqual(h.history.get(), []);
});
