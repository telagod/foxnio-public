import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { cleanup, fireEvent, render, within } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { FoxGoalPanel } = await jiti.import("./FoxGoalPanel.tsx");
const { FoxActivity } = await jiti.import("./FoxActivity.tsx");
const { setLocale } = await jiti.import("../lib/i18n/index.tsx");
setLocale("en");
afterEach(cleanup);

function snapshot() {
  return {
    supported: true,
    goal: { enabled: true, mode: "active", goal: { id: "goal-one", objective: "Ship migration", status: "active", tokensUsed: 12, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2 } },
    grant: { id: "grant-one", goalId: "goal-one", terms: { objective: "Ship migration", projects: ["/project"], criteria: [{ id: "pass", text: "Migration passes" }], operations: ["implementation", "verification"], maxWorkers: 4, maxDispatches: 64, maxRework: 3 }, epoch: "epoch-one", createdAt: "2026-11-11T00:00:00Z", revoked: false, paused: false },
    assignments: [{ id: "assignment-one", grantEntryId: "grant-one", goalId: "goal-one", planItemRef: "todo-one", purpose: "verification", criterionIds: ["pass"], cwd: "/project", workerSessionId: "worker-linked", state: "running", rework: 0 }],
    reports: [], reviews: [], dispatchesUsed: 1,
    todoPhases: [{ name: "Verify", tasks: [{ id: "todo-one", content: "Run migration", status: "in_progress" }] }],
    recovery: "running", updatedAt: "2026-11-11T00:00:00Z",
  };
}
function state(value) {
  return { snapshot: value, loading: false, refreshing: false, error: null, pending: null, controlError: null, refresh: async () => {}, control: async () => true };
}

test("human report navigation opens the original question session, never a duplicate answer dialog", () => {
  const value = snapshot();
  value.reports.push({ version: 1, id: "report-question", sourceSessionId: "worker-linked", parentSessionId: "fox-one", sequence: 1, cwd: "/project", at: "2026-11-11T00:00:00Z", source: "native", status: "needs_input", summary: "Choose production target", evidence: [], audience: "human", assignmentId: "assignment-one", question: { sessionId: "original-request-session", requestId: "request-7" } });
  let opened;
  const view = render(React.createElement(FoxGoalPanel, { state: state(value), onOpenSession: (id) => { opened = id; }, onDiscuss() {} }));
  fireEvent.click(view.getByRole("button", { name: "Open original question" }));
  assert.equal(opened, "original-request-session");
  assert.equal(view.queryByRole("dialog"), null);
  assert.equal(view.queryByRole("textbox"), null);
});

test("same-cwd legacy workers remain unlinked instead of inheriting the current goal", () => {
  const value = snapshot();
  const worker = (id) => ({ sessionId: id, parentSessionId: "fox-one", title: id, projectName: "Project", cwd: "/project", state: "idle", messageCount: 1 });
  const view = render(React.createElement(FoxActivity, {
    goal: state(value),
    state: { briefing: { workers: [worker("worker-linked"), worker("worker-legacy")], historicalWorkers: [], needsYou: [], warnings: [] }, loading: false, refreshing: false, error: null, refresh: async () => {} },
    onOpenSession() {}, onDiscuss() {},
  }));
  assert.ok(within(view.getByRole("button", { name: /worker-legacy/ })).getByText("Unlinked / legacy worker"));
  assert.ok(within(view.getByRole("button", { name: /worker-linked.*Project/ })).getByText("Linked to this goal"));
});

test("a result report and completed todo do not imply accepted criterion or native goal completion", () => {
  const value = snapshot();
  value.todoPhases[0].tasks[0].status = "completed";
  value.reports.push({ version: 1, id: "report-result", sourceSessionId: "worker-linked", parentSessionId: "fox-one", sequence: 2, cwd: "/project", at: "2026-11-11T00:00:00Z", source: "agent", status: "result", summary: "Done", evidence: ["passed"], audience: "coordinator" });
  const view = render(React.createElement(FoxGoalPanel, { state: state(value), onOpenSession() {}, onDiscuss() {} }));
  assert.ok(view.getByText("Native goal · active"));
  assert.ok(view.getByText("Not reviewed"));
  assert.equal(view.queryByText("Native goal · complete"), null);
  assert.equal(view.queryByText("Accepted review"), null);
});

test("verified native complete is displayed without offering execution controls", () => {
  const value = snapshot();
  value.goal.enabled = false;
  value.goal.goal.status = "complete";
  value.assignments[0].state = "settled";
  value.todoPhases[0].tasks[0].status = "completed";
  const view = render(React.createElement(FoxGoalPanel, { state: state(value), onOpenSession() {}, onDiscuss() {} }));
  assert.ok(view.getByText("Native goal · complete"));
  assert.equal(view.queryByRole("button", { name: "Resume" }), null);
  assert.equal(view.queryByRole("button", { name: "Pause" }), null);
  assert.equal(view.queryByRole("button", { name: "Stop" }), null);
});

test("exact fallback references bind a native todo, but ambiguous duplicate content does not", () => {
  const value = snapshot();
  value.planEntryId = "plan-entry-one";
  delete value.todoPhases[0].tasks[0].id;
  value.assignments[0].planItemRef = '["plan-entry-one","Verify","Run migration"]';
  const view = render(React.createElement(FoxGoalPanel, { state: state(value), onOpenSession() {}, onDiscuss() {} }));
  const phase = view.getByText("Verify", { selector: "h4" }).parentElement;
  assert.ok(within(phase).getByText("Running · worker-l"));
  value.planReferences = [value.assignments[0].planItemRef];
  value.planEntryId = "plan-entry-two";
  value.todoPhases[0].tasks[0].status = "blocked";
  view.rerender(React.createElement(FoxGoalPanel, { state: state(value), onOpenSession() {}, onDiscuss() {} }));
  assert.ok(within(phase).getByText("Running · worker-l"));
  value.todoPhases[0].tasks.push({ content: "Run migration", status: "pending" });
  view.rerender(React.createElement(FoxGoalPanel, { state: state(value), onOpenSession() {}, onDiscuss() {} }));
  assert.equal(within(phase).queryByText("Running · worker-l"), null);
});

test("server-revoked permission prevents Resume while leaving worker Stop available", () => {
  const value = snapshot();
  value.goal.goal.status = "paused";
  value.grant.revoked = true;
  let action;
  const view = render(React.createElement(FoxGoalPanel, { state: { ...state(value), control: async (next) => { action = next; return true; } }, onOpenSession() {}, onDiscuss() {} }));
  assert.equal(view.getByRole("button", { name: "Resume" }).disabled, true);
  fireEvent.click(view.getByRole("button", { name: "Stop" }));
  assert.equal(action, "stop");
});

test("legacy report excerpts remain visibly distinct from an executed independent check", () => {
  const value = snapshot();
  value.reviews.push({ criterionId: "pass", decision: "accept", reportIds: [], evidence: [{ kind: "artifact", reference: "report:old-worker:1", observed: "Inspected legacy report" }] });
  const view = render(React.createElement(FoxGoalPanel, { state: state(value), onOpenSession() {}, onDiscuss() {} }));
  assert.ok(view.getByText("Inspected report excerpt"));
  assert.ok(view.getByText("Not bound to a verified revision"));
  assert.equal(view.queryByText("Executed check"), null);
});
