import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, cleanup, renderHook } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { useFoxGoal } = await jiti.import("./useFoxGoal.ts");
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
const snapshot = (status = "active") => ({
  supported: true,
  goal: { enabled: true, mode: "active", goal: { id: "goal-one", objective: "Verify migration", status, tokensUsed: 12, timeUsedSeconds: 2, createdAt: "2026-11-11T00:00:00Z", updatedAt: "2026-11-11T00:00:00Z" } },
  grant: null, assignments: [], reviews: [], reports: [], dispatchesUsed: 0,
  todoPhases: [], recovery: "waiting", updatedAt: "2026-11-11T00:00:00Z",
});
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

test("overlapping snapshot refreshes share one read and a failed read preserves visible native state", async () => {
  let reads = 0;
  let next = deferred();
  globalThis.fetch = async () => { reads++; return next.promise; };
  const view = renderHook(() => useFoxGoal());
  await act(async () => { void view.result.current.refresh(); void view.result.current.refresh(); });
  assert.equal(reads, 1);
  await act(async () => { next.resolve(response(snapshot())); });
  assert.equal(view.result.current.snapshot.goal.goal.status, "active");
  next = deferred();
  await act(async () => { void view.result.current.refresh(); next.resolve(response({ error: "offline" }, 503)); });
  assert.equal(view.result.current.snapshot.goal.goal.status, "active");
  assert.ok(view.result.current.error);
  assert.equal(view.result.current.loading, false);
});

test("Stop remains pending until the server replies and does not invent completed or dropped state", async () => {
  const stop = deferred();
  globalThis.fetch = async (_url, init) => {
    if (init?.method === "POST") {
      assert.deepEqual(JSON.parse(init.body), { action: "stop" });
      return stop.promise;
    }
    return response(snapshot());
  };
  const view = renderHook(() => useFoxGoal());
  await act(async () => {});
  let pending;
  await act(async () => { pending = view.result.current.control("stop"); });
  assert.equal(view.result.current.pending, "stop");
  assert.equal(view.result.current.snapshot.goal.goal.status, "active");
  await act(async () => { stop.resolve(response({ ...snapshot(), goal: null, reason: "worker abort failed", recovery: "uncertain" })); await pending; });
  assert.equal(view.result.current.pending, null);
  assert.equal(view.result.current.snapshot.goal, null);
  assert.equal(view.result.current.snapshot.recovery, "uncertain");
  assert.equal(view.result.current.snapshot.reason, "worker abort failed");
});

test("a late pre-control read cannot replace the server's paused result", async () => {
  const lateRead = deferred();
  let reads = 0;
  globalThis.fetch = async (_url, init) => init?.method === "POST"
    ? response(snapshot("paused"))
    : ++reads === 1 ? response(snapshot()) : lateRead.promise;
  const view = renderHook(() => useFoxGoal());
  await act(async () => {});
  let refresh;
  await act(async () => { refresh = view.result.current.refresh(); });
  await act(async () => { await view.result.current.control("pause"); });
  await act(async () => { lateRead.resolve(response(snapshot())); await refresh; });
  assert.equal(view.result.current.snapshot.goal.goal.status, "paused");
});

test("failed Resume exposes failure without pretending the grant resumed", async () => {
  globalThis.fetch = async (_url, init) => init?.method === "POST"
    ? response({ error: "Grant revoked" }, 409) : response(snapshot("paused"));
  const view = renderHook(() => useFoxGoal());
  await act(async () => {});
  let ok;
  await act(async () => { ok = await view.result.current.control("resume"); });
  assert.equal(ok, false);
  assert.equal(view.result.current.snapshot.goal.goal.status, "paused");
  assert.match(view.result.current.controlError, /Grant revoked/);
});

test("malformed successful responses are unknown, not an empty delivered goal", async () => {
  globalThis.fetch = async () => response({ supported: true });
  const view = renderHook(() => useFoxGoal());
  await act(async () => {});
  assert.equal(view.result.current.snapshot, null);
  assert.ok(view.result.current.error);
});

test("changing FOX conversation invalidates an older pending control without locking the new goal", async () => {
  const oldStop = deferred();
  let current = snapshot();
  globalThis.fetch = async (_url, init) => init?.method === "POST" ? oldStop.promise : response(current);
  const view = renderHook(({ id }) => useFoxGoal(id), { initialProps: { id: "fox-old" } });
  await act(async () => {});
  let stopping;
  await act(async () => { stopping = view.result.current.control("stop"); });
  current = snapshot("paused");
  current.goal.goal.id = "goal-new";
  await act(async () => { view.rerender({ id: "fox-new" }); });
  assert.equal(view.result.current.pending, null);
  assert.equal(view.result.current.snapshot.goal.goal.id, "goal-new");
  await act(async () => { oldStop.resolve(response({ ...snapshot(), goal: null })); await stopping; });
  assert.equal(view.result.current.snapshot.goal.goal.id, "goal-new");
});
