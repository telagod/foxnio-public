import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import React from "react";
import { act, cleanup, render, renderHook } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";
const streams = [];
class FakeSharedWorker {
  constructor() { this.port = { onmessage: null, start() {}, postMessage: (message) => { if (message.op === "open") streams.push({ channel: message.channel, deliver: (frame) => this.port.onmessage?.({ data: { id: message.id, ...frame } }) }); } }; }
}
const originalWorker = globalThis.SharedWorker, originalFetch = globalThis.fetch;
globalThis.SharedWorker = FakeSharedWorker;
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { useSessionSignals } = await jiti.import("./useSessionSignals.ts");
const { notificationHistory, useNotificationHistory } = await jiti.import("../lib/notification-history.ts");
const { ToastProvider, toast } = await jiti.import("@/components/ui/toast");
const entry = (id, read = false, detail = id) => ({ id: `${id}:input`, event: { type: "input", sessionId: id, sessionName: id, detail }, at: 1, read });
const response = (body) => new Response(JSON.stringify(body));
const settle = () => act(async () => { for (let n = 0; n < 100; n++) await Promise.resolve(); });
let server, revision, calls, generation = 0;
beforeEach(() => {
  server = []; revision = 1; calls = []; generation++; streams.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url, "http://test"); calls.push([init.method ?? "GET", path.pathname]);
    if (path.pathname === "/api/notifications/history") {
      assert.equal(init.method, "PATCH"); const { ids } = JSON.parse(init.body); server = server.map((item) => ids.includes(item.id) ? { ...item, read: true } : item); revision++; return response({ ok: true });
    }
    if (init.method === "DELETE") return response({ ok: true });
    const cursor = { generation: `test-${generation}`, revision };
    if (path.pathname.endsWith("changes")) {
      const before = JSON.parse(path.searchParams.get("cursor"));
      if (before.generation !== cursor.generation) return new Response(JSON.stringify({ code: "reset_required" }), { status: 409 });
      return response({ cursor, through: cursor, changes: before.revision < revision ? [{ revision, topic: "notification-history", keys: [] }] : [], hasMore: false });
    }
    return response({ cursor, token: "reader", next: false, complete: true, staleSources: [], warnings: [], data: { sessions: [], projects: [], pins: [], notifications: server, foxPointer: { sessionId: null, resetAt: null }, foxObservation: {}, foxWorkspace: "/fox" } });
  };
});
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
test.after(() => { globalThis.SharedWorker = originalWorker; });
const mount = (sessionId = null) => renderHook(() => { useSessionSignals({ sessionId, onOpenSession() {} }); return useNotificationHistory(); });
function head() { const stream = streams.find((item) => item.channel.kind === "data"); stream.deliver({ type: "message", data: JSON.stringify({ type: "data-head", cursor: { generation: `test-${generation}`, revision } }) }); }
test("durable subscription precedes snapshot and reconnect recovers input/read state without notification-history GET", async () => {
  const view = mount(); assert.equal(calls.length, 0); assert.ok(streams.some((stream) => stream.channel.kind === "data"));
  server = [entry("first")]; act(head); await settle();
  assert.deepEqual(view.result.current.map((item) => [item.id, item.read]), [["first:input", false]]);
  server = [entry("missed"), entry("first", true)]; revision++;
  act(() => { const stream = streams.find((item) => item.channel.kind === "data"); stream.deliver({ type: "error", readyState: 0 }); stream.deliver({ type: "open" }); head(); });
  await settle(); assert.deepEqual(view.result.current.map((item) => [item.id, item.read]), [["missed:input", false], ["first:input", true]]);
  assert.ok(calls.every(([method, path]) => method !== "GET" || path.startsWith("/api/data/")));
});

test("notification signals cannot invent unread history over the database's read state", async () => {
  server = [entry("read", true)]; const view = mount(); act(head); await settle();
  act(() => streams.find((stream) => stream.channel.kind === "notifications").deliver({ type: "message", data: JSON.stringify({ type: "notification", kind: "signal", event: entry("read", false, "late delivery").event }) }));
  assert.deepEqual(view.result.current.map((item) => [item.id, item.read]), [["read:input", true]]);
  server = [entry("read", false, "actual new question")]; revision++; act(head); await settle();
  assert.equal(view.result.current[0].event.detail, "actual new question"); assert.equal(view.result.current[0].read, false);
});

test("settling a viewed input writes only its history id; unrelated waiting sessions remain unread", async () => {
  server = [entry("viewed"), entry("other")]; await notificationHistory.load();
  const view = mount("viewed"); act(head); await settle();
  assert.deepEqual(view.result.current.map((item) => [item.id, item.read]), [["viewed:input", true], ["other:input", false]]);
});


const originalAbortController = globalThis.AbortController;
test.after(() => { globalThis.AbortController = originalAbortController; });
test("goal notices still surface once and navigate to their exact owning session", async () => {
  const opened = [];
  globalThis.AbortController = window.AbortController;
  render(React.createElement(ToastProvider));
  renderHook(() => useSessionSignals({ sessionId: null, onOpenSession: (id) => opened.push(id) }));
  const frame = { type: "notification", kind: "goal-notice", sessionId: "owner-session", notice: { key: "goal-finished", kind: "completed", title: "Goal complete", detail: "Evidence ready" } };
  act(() => {
    const stream = streams.find((item) => item.channel.kind === "notifications");
    stream.deliver({ type: "message", data: JSON.stringify(frame) });
    stream.deliver({ type: "message", data: JSON.stringify(frame) });
  });
  const cards = [...document.querySelectorAll(".toast-card")].filter((card) => card.textContent.includes("Goal complete"));
  assert.equal(cards.length, 1);
  act(() => cards[0].click());
  assert.deepEqual(opened, ["owner-session"]);
  act(() => toast.close());
});