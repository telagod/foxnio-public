import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, cleanup, renderHook } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";
const originalWorker = globalThis.SharedWorker, originalFetch = globalThis.fetch;
const streams = [];
globalThis.SharedWorker = class {
  constructor() { this.port = { onmessage: null, start() {}, postMessage: (message) => { if (message.op === "open") streams.push({ channel: message.channel, deliver: (frame) => this.port.onmessage?.({ data: { id: message.id, type: "message", data: JSON.stringify(frame) } }) }); } }; }
};
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { useBriefing } = await jiti.import("./useBriefing.ts");
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; streams.length = 0; });
test.after(() => { globalThis.SharedWorker = originalWorker; });
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const briefing = (needsYou = []) => ({ generatedAt: "2026-11-12T00:00:00Z", projects: [], needsYou, totals: { projects: 0, sessions: 0, running: 0, waiting: needsYou.length, unread: 0 }, workers: [], recent: [] });

test("briefing reacts to live attention without a durable revision and never mirrors from the browser", async () => {
  let current = briefing(), fail = false;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([url, init?.method ?? "GET"]); assert.ok(url.startsWith("/api/briefing?")); return response(fail ? {} : current, fail ? 503 : 200); };
  const view = renderHook(() => useBriefing()); await act(async () => {});
  current = briefing([{ sessionId: "worker", kind: "input", detail: "Choose" }]);
  await act(async () => { streams.find((stream) => stream.channel.kind === "running").deliver({ type: "running", runningSessionIds: ["worker"] }); await new Promise((resolve) => setTimeout(resolve, 120)); });
  assert.equal(view.result.current.briefing.needsYou[0].sessionId, "worker");
  fail = true; await act(async () => { await view.result.current.refresh(); });
  assert.equal(view.result.current.briefing.needsYou.length, 1); assert.ok(view.result.current.error);
  assert.ok(calls.every(([, method]) => method === "GET"));
});

test("a hint during a delayed briefing read produces one trailing read rather than losing the live change", async () => {
  let resolve, reads = 0;
  globalThis.fetch = async () => { reads++; if (reads === 1) return new Promise((done) => { resolve = done; }); return response(briefing([{ sessionId: "new", kind: "input" }])); };
  const view = renderHook(() => useBriefing()); await act(async () => {});
  await act(async () => { streams.find((stream) => stream.channel.kind === "running").deliver({ type: "running", runningSessionIds: ["new"] }); await new Promise((done) => setTimeout(done, 120)); });
  await act(async () => { resolve(response(briefing())); });
  assert.equal(reads, 2); assert.equal(view.result.current.briefing.needsYou[0].sessionId, "new");
});

test("a durable display change refreshes briefing even when no runtime session changes", async () => {
  let revision = 1, name = "before", reads = 0;
  globalThis.fetch = async (raw, init = {}) => {
    const url = new URL(raw, "http://test");
    if (url.pathname === "/api/briefing") { reads++; return response({ ...briefing(), projects: [{ path: "/work", name }] }); }
    if (init.method === "DELETE") return response({ ok: true });
    const cursor = { generation: "briefing-test", revision };
    if (url.pathname.endsWith("changes")) {
      const before = JSON.parse(url.searchParams.get("cursor"));
      return response({ cursor, through: cursor, changes: before.revision < revision ? [{ revision, topic: "fox-display", keys: ["report"] }] : [], hasMore: false });
    }
    return response({ cursor, token: "reader", next: false, complete: true, staleSources: [], warnings: [], data: { sessions: [], projects: [], pins: [], notifications: [], foxWorkspace: "/fox", foxPointer: { sessionId: null, resetAt: null }, foxObservation: {} } });
  };
  const view = renderHook(() => useBriefing());
  await act(async () => { streams.find((stream) => stream.channel.kind === "data").deliver({ type: "data-head", cursor: { generation: "briefing-test", revision } }); await new Promise((resolve) => setTimeout(resolve, 120)); });
  assert.equal(view.result.current.briefing.projects[0].name, "before");
  name = "after"; revision++;
  await act(async () => { streams.find((stream) => stream.channel.kind === "data").deliver({ type: "data-head", cursor: { generation: "briefing-test", revision } }); await new Promise((resolve) => setTimeout(resolve, 120)); });
  assert.equal(view.result.current.briefing.projects[0].name, "after"); assert.ok(reads >= 2);
});
