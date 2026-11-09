import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { nativeFoxWorkers } = await createJiti(import.meta.url).import("./fox-native-work.ts");
const session = (id, extra = {}) => ({
  id, name: `FOX · ${id}`, cwd: "/projects/app", projectRoot: "/projects/app",
  firstMessage: "Request", created: "2026-11-08T10:00:00Z", modified: "2026-11-08T11:00:00Z",
  parentSessionId: "fox", ...extra,
});

test("only direct native children are FOX workers, not name or directory matches", () => {
  const workers = nativeFoxWorkers([
    session("owned"), session("unowned", { parentSessionId: undefined }),
    session("nested", { parentSessionId: "owned" }), session("old", { parentSessionId: "previous-fox" }),
  ], [], "fox");
  assert.deepEqual(workers.map((worker) => worker.sessionId), ["owned"]);
  assert.deepEqual(nativeFoxWorkers([session("owned")], [], null), []);
});

test("an idle worker with fresh activity is not declared completed", () => {
  const [worker] = nativeFoxWorkers([session("owned", { lastMessageAt: "2026-11-08T12:00:00Z", messageCount: 50 })], [], "fox");
  assert.equal(worker.state, "idle");
  assert.equal(worker.title, "owned");
});

test("worker states come from the native live registry", () => {
  const workers = nativeFoxWorkers([session("ask"), session("run"), session("error")], [
    { id: "ask", running: true, pendingInput: 1, pendingInputDetail: "Choose a target" },
    { id: "run", running: true, pendingInput: 0, lastRunError: "old error" },
    { id: "error", running: false, pendingInput: 0, lastRunError: "Failed" },
  ], "fox");
  assert.deepEqual(workers.map((worker) => worker.state), ["waiting", "running", "error"]);
  assert.equal(workers[0].detail, "Choose a target");
});

test("same-named projects stay distinct and worker cwd is retained for follow-ups", () => {
  const workers = nativeFoxWorkers([
    session("one", { cwd: "/work/a/app" }), session("two", { cwd: "/work/b/app", projectRoot: "/work/b/app" }),
  ], [], "fox");
  assert.notEqual(workers[0].projectKey, workers[1].projectKey);
  assert.equal(workers[1].cwd, "/work/b/app");
});

test("reports retain their source and delivery status without converting claims into completion", () => {
  const report = { id: "owned:1", sourceSessionId: "owned", parentSessionId: "fox", status: "result", summary: "Result with pending checks" };
  const [worker] = nativeFoxWorkers([session("owned")], [], "fox", new Map([["owned", { report, delivery: "pending" }]]));
  assert.equal(worker.state, "idle");
  assert.equal(worker.report, report);
  assert.equal(worker.reportDelivery, "pending");
  const [unrelated] = nativeFoxWorkers([session("owned")], [], "fox", new Map([["owned", { report: { ...report, parentSessionId: "someone-else" }, delivery: "received" }]]));
  assert.equal(unrelated.report, undefined);
});

test("historical workers keep the original parent rather than being adopted by a new FOX", () => {
  const [worker] = nativeFoxWorkers([session("old", { parentSessionId: "original-fox" })], [], new Set(["original-fox"]));
  assert.equal(worker.parentSessionId, "original-fox");
  assert.deepEqual(nativeFoxWorkers([session("old", { parentSessionId: "original-fox" })], [], "new-fox"), []);
});
