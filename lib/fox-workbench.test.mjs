import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildFoxWorkbench, foxDispatchState, foxServiceHealth, shortFoxTitle } = await jiti.import("./fox-workbench.ts");
const now = "2026-11-08T12:00:00Z";
const project = (path) => ({ key: path, path, name: "App", sessions: 1, running: 0, waiting: 0, errors: 0, unread: 0, lastActivity: now });
const briefing = (overrides = {}) => ({
  generatedAt: now,
  totals: { projects: 2, sessions: 2, running: 0, waiting: 0, unread: 0 },
  projects: [project("/one/app"), project("/two/app")],
  needsYou: [], active: [], dispatches: [], recent: [],
  ...overrides,
});
const chief = (overrides = {}) => ({ tickets: [], approvals: [], preferences: [], autonomy: {}, audit: [], ...overrides });
const dispatch = (overrides = {}) => ({
  id: "d1", taskId: "d1", at: now, task: "Fix login", state: "running",
  targetSessionId: "s1", sessionName: "Login fix", projectName: "App", projectKey: "/one/app",
  ...overrides,
});
const ticket = (overrides = {}) => ({
  id: "t1", title: "Fix login", projectRef: "/one/app", projectName: "App",
  assigneeSessionId: "s1", state: "working", artifacts: [], createdAt: now, updatedAt: now,
  mandate: { kind: "explicit", requestedBy: "fox", scope: "/one/app", policyVersion: "1" },
  ...overrides,
});
const approval = (overrides = {}) => ({
  id: "a1", ticketId: "t1", projectRef: "/one/app", projectName: "App", title: "Fix login",
  state: "pending", action: { toolName: "new_session" }, evidence: "Requested by FOX",
  createdAt: now, decidedAt: null, ...overrides,
});

test("joins a worker, its follow-up and its ticket without repeating active or recent sessions", () => {
  const item = { id: "s1:active", sessionId: "s1", sessionName: "Login fix", projectKey: "/one/app", projectName: "App", kind: "activity", at: now };
  const model = buildFoxWorkbench(briefing({
    dispatches: [dispatch(), dispatch({ id: "d2", at: "2026-11-08T12:01:00Z", task: "Run tests" })],
    active: [item], recent: [item],
  }), chief({ tickets: [ticket()] }));
  assert.equal(model.work.length, 1);
  assert.equal(model.work[0].sessionId, "s1");
  assert.equal(model.work[0].ticket.id, "t1");
  assert.equal(model.work[0].dispatches.length, 2);
  assert.equal(model.otherActive.length, 0);
  assert.equal(model.recent.length, 0);
});

test("pending approvals are attention items, not duplicated waiting tickets", () => {
  const model = buildFoxWorkbench(briefing(), chief({
    approvals: [approval()],
    tickets: [ticket({ assigneeSessionId: undefined, state: "waiting_human" })],
  }));
  assert.equal(model.attention.length, 1);
  assert.equal(model.attention[0].approval.id, "a1");
  assert.equal(model.work.length, 1);
  assert.equal(model.work[0].status, "waiting");
});

test("keeps every approval, and filters projects by path rather than display name", () => {
  const approvals = Array.from({ length: 9 }, (_, i) => approval({ id: `a${i}`, ticketId: `t${i}` }));
  approvals.push(approval({ id: "other", ticketId: "other", projectRef: "/two/app" }));
  const model = buildFoxWorkbench(briefing(), chief({ approvals }), "/one/app");
  assert.equal(model.attention.length, 9);
  assert.ok(model.attention.every((item) => item.projectKey === "/one/app"));
  assert.equal(buildFoxWorkbench(briefing(), chief({ approvals })).attention.length, 10);
});

test("an unresolved waiting ticket stays actionable even without an approval", () => {
  const model = buildFoxWorkbench(briefing(), chief({ tickets: [ticket({ state: "waiting_human" })] }));
  assert.equal(model.attention.length, 1);
  assert.equal(model.attention[0].work.ticket.id, "t1");
});

test("does not equate new transcript activity with task completion", () => {
  const record = { status: "started", at: "2026-11-08T11:00:00Z" };
  assert.equal(foxDispatchState(record, undefined, now), "updated");
  assert.equal(foxDispatchState(record, { running: true, pendingInput: 0 }, now), "running");
  assert.equal(foxDispatchState(record, { running: false, pendingInput: 1 }, now), "waiting");
  assert.equal(foxDispatchState(record, { running: false, pendingInput: 0, lastRunError: "failed" }, now), "failed");
  assert.equal(foxDispatchState({ ...record, status: "waited" }, undefined, now), "waited");
  assert.equal(foxDispatchState({ ...record, status: "failed" }, undefined, now), "failed");
  assert.equal(foxDispatchState(record, undefined, null), "started");
});

test("service status distinguishes disabled, fresh, stale and unavailable", () => {
  const status = { config: { enabled: true }, lastTickAt: now };
  const time = Date.parse(now);
  assert.equal(foxServiceHealth(status, false, time), "checking");
  assert.equal(foxServiceHealth(status, false, time + 180_000), "stale");
  assert.equal(foxServiceHealth({ ...status, lastTickAt: null }, false, time), "starting");
  assert.equal(foxServiceHealth({ ...status, config: { enabled: false } }, false, time), "manual");
  assert.equal(foxServiceHealth(status, true, time), "unavailable");
  assert.equal(foxServiceHealth(null, false, time), "loading");
});

test("titles are compact but the source text is not modified", () => {
  const title = "Fix login\n" + "Details ".repeat(100);
  assert.equal(shortFoxTitle(title), "Fix login");
  assert.ok(shortFoxTitle("x".repeat(120)).length <= 85);
  assert.ok(title.length > 500);
});

test("live execution and input override an older ticket review state", () => {
  const signal = { id: "s1:active", sessionId: "s1", sessionName: "Login fix", projectKey: "/one/app", projectName: "App", kind: "activity", at: now };
  const value = chief({ tickets: [ticket({ state: "review" })] });
  assert.equal(buildFoxWorkbench(briefing({ dispatches: [dispatch()], active: [signal] }), value).work[0].status, "running");
  assert.equal(buildFoxWorkbench(briefing({ dispatches: [dispatch()], needsYou: [{ ...signal, kind: "input" }] }), value).work[0].status, "waiting");
});
