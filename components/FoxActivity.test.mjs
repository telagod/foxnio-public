import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { FoxActivity } = await jiti.import("./FoxActivity.tsx");
const { FoxSettings } = await jiti.import("./FoxSettings.tsx");
const noop = () => {};
const state = {
  briefing: { needsYou: [], workers: [], warnings: [] },
  loading: false, refreshing: false, error: null, refresh: async () => {},
};
const worker = (id, extra = {}) => ({
  sessionId: id, parentSessionId: "fox", title: `Worker ${id}`, cwd: "/projects/app",
  projectName: "App", projectKey: "/projects/app", state: "idle", at: "2026-11-08T10:00:00Z",
  ...extra,
});
afterEach(cleanup);

test("native workers open their exact session, and idle never means completed", () => {
  const opened = [];
  render(React.createElement(FoxActivity, {
    state: { ...state, briefing: { ...state.briefing, workers: [worker("one")], dispatches: [{ task: "Legacy ticket" }] } },
    onOpenSession: (id) => opened.push(id), onDiscuss: noop,
  }));
  fireEvent.click(screen.getByRole("button", { name: /Worker one/ }));
  assert.deepEqual(opened, ["one"]);
  assert.ok(screen.getByText(/Open conversation/));
  assert.equal(screen.queryByText(/Completed|Legacy ticket/), null);
});

test("every waiting conversation is reachable without a separate approval panel", () => {
  const opened = [];
  render(React.createElement(FoxActivity, {
    state: { ...state, briefing: { ...state.briefing, needsYou: Array.from({ length: 9 }, (_, index) => ({
      id: `ask-${index}`, sessionId: `worker-${index}`, sessionName: `Question ${index}`,
      kind: "input", detail: `Choose the scope ${index}`, projectName: "App",
    })) } },
    onOpenSession: (id) => opened.push(id), onDiscuss: noop,
  }));
  fireEvent.click(screen.getByRole("button", { name: /Question 8/ }));
  assert.deepEqual(opened, ["worker-8"]);
  assert.equal(screen.getAllByRole("button", { name: /Question \d/ }).length, 9);
});

test("worker history can be expanded and collapsed", () => {
  render(React.createElement(FoxActivity, {
    state: { ...state, briefing: { ...state.briefing, workers: Array.from({ length: 9 }, (_, id) => worker(String(id))) } },
    onOpenSession: noop, onDiscuss: noop,
  }));
  assert.equal(screen.queryByText("Worker 8"), null);
  fireEvent.click(screen.getByRole("button", { name: "Show all 9 conversations" }));
  assert.ok(screen.getByText("Worker 8"));
  fireEvent.click(screen.getByRole("button", { name: "Show fewer" }));
  assert.equal(screen.queryByText("Worker 8"), null);
});

test("failed sources show uncertainty, not an empty all-clear", () => {
  render(React.createElement(FoxActivity, { state: { ...state, error: "offline" }, onOpenSession: noop, onDiscuss: noop }));
  assert.match(screen.getByRole("status").textContent, /not an all-clear/);
  assert.equal(screen.queryByText("A place to follow the work"), null);
});

test("progress is discussed in the existing FOX conversation", () => {
  const prompts = [];
  render(React.createElement(FoxActivity, { state, onOpenSession: noop, onDiscuss: (prompt) => prompts.push(prompt) }));
  fireEvent.click(screen.getByRole("button", { name: "Ask FOX for an update" }));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /evidence/);
});

test("agent reports show evidence separately from transport and missing reports remain uncertain", () => {
  render(React.createElement(FoxActivity, {
    state: { ...state, briefing: { ...state.briefing, workers: [
      worker("reported", { report: { status: "result", summary: "Regression passed; deployment not checked." }, reportDelivery: "pending" }),
      worker("missing"),
    ] } }, onOpenSession: noop, onDiscuss: noop,
  }));
  assert.ok(screen.getByText("Regression passed; deployment not checked."));
  assert.ok(screen.getByText(/waiting for FOX to receive/));
  assert.ok(screen.getByText(/Progress is unverified/));
  assert.equal(screen.queryByText("Completed"), null);
});

test("late reports can be followed back to the exact original coordinator", () => {
  const opened = [];
  render(React.createElement(FoxActivity, {
    state: { ...state, briefing: { ...state.briefing, historicalWorkers: [worker("older", { parentSessionId: "original-fox" })] } },
    onOpenSession: (id) => opened.push(id), onDiscuss: noop,
  }));
  fireEvent.click(screen.getByRole("button", { name: "Other FOX conversations · 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Open original FOX conversation" }));
  assert.deepEqual(opened, ["original-fox"]);
});

test("settings use native policies, distinguish same-named projects, and resolve aliases", () => {
  const updates = [];
  render(React.createElement(FoxSettings, {
    projects: [
      { key: "/one/app", path: "/one/app", name: "App", policyKey: "/real/app" },
      { key: "/two/app", path: "/two/app", name: "App" },
    ],
    service: {
      status: { config: { enabled: false, quietStart: "22:00", quietEnd: "08:00", maxDailyMessages: 3, dispatchPolicies: { "/real/app": "auto", "/two/app": "observe" } } },
      saving: false, failed: false, health: "manual", refresh: noop, update: async (patch) => { updates.push(patch); return true; },
    },
    onClose: noop,
  }));
  const first = screen.getByRole("combobox", { name: "Delegation permission for /one/app" });
  assert.equal(first.value, "auto");
  assert.equal(screen.getByRole("combobox", { name: "Delegation permission for /two/app" }).value, "observe");
  fireEvent.change(first, { target: { value: "confirm" } });
  assert.deepEqual(updates, [{ dispatchPolicies: { "/one/app": "confirm" } }]);
});

test("settings render native execution failure distinctly from healthy automatic checks", () => {
  const service = {
    status: { config: { enabled: true, quietStart: "22:00", quietEnd: "08:00", maxDailyMessages: 3 }, lastRunError: "Provider unavailable" },
    health: "error", saving: false, failed: false, refresh: noop, update: async () => true,
  };
  const view = render(React.createElement(FoxSettings, { service, projects: [], onClose: noop }));
  assert.match(screen.getByRole("status").textContent, /Run failed/);
  assert.match(screen.getByRole("status").textContent, /Provider unavailable/);
  assert.equal(screen.queryByText("Automatic checks enabled"), null);
  view.rerender(React.createElement(FoxSettings, {
    service: { ...service, health: "checking", status: { ...service.status, lastRunError: null } }, projects: [], onClose: noop,
  }));
  assert.equal(screen.queryByText(/Provider unavailable/), null);
  assert.match(screen.getByRole("status").textContent, /Automatic checks enabled/);
});
