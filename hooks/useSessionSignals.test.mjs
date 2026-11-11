import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { act, cleanup, renderHook } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const streams = [];
class FakeSharedWorker {
  constructor() {
    this.port = {
      onmessage: null,
      start() {},
      postMessage: (message) => {
        if (message.op !== "open") return;
        streams.push({
          channel: message.channel,
          deliver: (frame) => this.port.onmessage?.({ data: { id: message.id, ...frame } }),
        });
      },
    };
  }
}
const originalWorker = globalThis.SharedWorker;
const originalFetch = globalThis.fetch;
globalThis.SharedWorker = FakeSharedWorker;
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { useSessionSignals } = await jiti.import("./useSessionSignals.ts");
const { notificationHistory, useNotificationHistory } = await jiti.import("../lib/notification-history.ts");
const entry = (id, detail = id) => ({
  id: `${id}:input`, event: { type: "input", sessionId: id, sessionName: id, detail }, at: 1, read: false,
});
const response = (entries) => new Response(JSON.stringify({ entries }), { headers: { "content-type": "application/json" } });
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const mount = () => renderHook(() => {
  useSessionSignals({ sessionId: null, onOpenSession() {} });
  return useNotificationHistory();
});

beforeEach(async () => {
  globalThis.fetch = async () => response([]);
  await notificationHistory.load();
  streams.length = 0;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
test.after(() => { globalThis.SharedWorker = originalWorker; });

test("subscribes before the first snapshot and recovers missed input on OPEN while continuously visible", async () => {
  let server = [];
  const reads = [];
  globalThis.fetch = async () => {
    reads.push(streams.length);
    return response(server);
  };
  const view = mount();
  assert.equal(streams[0].channel.kind, "notifications");
  assert.deepEqual(reads, [], "history must wait until the notification stream is subscribed");
  server = [entry("first")];
  act(() => streams[0].deliver({ type: "open" }));
  await settle();
  assert.deepEqual(view.result.current.map((item) => item.id), ["first:input"]);
  act(() => streams[0].deliver({ type: "error", readyState: 0 }));
  server = [entry("missed"), ...server];
  assert.equal(document.visibilityState, "visible");
  act(() => streams[0].deliver({ type: "open" }));
  await settle();
  assert.deepEqual(view.result.current.map((item) => [item.id, item.read]), [["missed:input", false], ["first:input", false]]);
  assert.deepEqual(reads, [1, 1]);
  act(() => streams[0].deliver({ type: "message", data: JSON.stringify({ type: "notification", kind: "signal", event: entry("missed", "newer question").event }) }));
  assert.equal(view.result.current[0].event.detail, "newer question", "a later signal supersedes the completed reconnect snapshot");
});

test("a reconnect snapshot cannot replace a newer live input and reconciliation includes missed signals", async () => {
  const pending = [];
  globalThis.fetch = () => new Promise((resolve) => pending.push(resolve));
  const view = mount();
  act(() => streams[0].deliver({ type: "open" }));
  await act(async () => { pending.shift()(response([])); });
  act(() => {
    streams[0].deliver({ type: "error", readyState: 0 });
    streams[0].deliver({ type: "open" });
    streams[0].deliver({ type: "message", data: JSON.stringify({ type: "notification", kind: "signal", event: entry("live", "new question").event }) });
  });
  await act(async () => { pending.shift()(response([entry("live", "old question"), entry("missed")])); });
  assert.equal(view.result.current[0].event.detail, "new question");
  assert.equal(pending.length, 1, "a live change fences the snapshot and requests one reconciliation");
  await act(async () => { pending.shift()(response([entry("live", "new question"), entry("missed")])); });
  assert.deepEqual(view.result.current.map((item) => [item.id, item.event.detail]), [["live:input", "new question"], ["missed:input", "missed"]]);
});
