import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react/pure.js";
import { readFile } from "node:fs/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { FoxOverview } = await jiti.import("./FoxOverview.tsx");
const now = "2026-11-08T12:00:00Z";
const project = (path) => ({ key: path, path, name: "App", sessions: 1, running: 0, waiting: 0, errors: 0, unread: 0, lastActivity: now });
const emptyChief = { tickets: [], approvals: [], preferences: [], autonomy: {}, audit: [] };
const emptyBriefing = {
  generatedAt: now,
  totals: { projects: 2, sessions: 2, running: 0, waiting: 0, unread: 0 },
  projects: [project("/one/app"), project("/two/app")],
  needsYou: [], active: [], dispatches: [], recent: [],
};
const approval = (id) => ({
  id, ticketId: `t${id}`, projectRef: "/one/app", projectName: "App", title: `Permission ${id}`,
  state: "pending", action: { toolName: "new_session" }, evidence: "Requested by FOX",
  createdAt: now, decidedAt: null,
});
const noop = () => {};
const props = {
  briefing: emptyBriefing, chief: emptyChief, projectKey: "", loading: false,
  refreshing: false, briefingError: null, chiefFailed: false,
  onProjectChange: noop, onRefresh: noop, onSelect: noop, onOpenSession: noop, onDiscuss: noop,
};
afterEach(cleanup);

test("all pending decisions are visible and open the matching detail", () => {
  const selected = [];
  render(React.createElement(FoxOverview, {
    ...props, chief: { ...emptyChief, approvals: Array.from({ length: 9 }, (_, i) => approval(String(i))) },
    onSelect: (value) => selected.push(value),
  }));
  assert.equal(screen.getAllByRole("button", { name: /Permission \d/ }).length, 9);
  fireEvent.click(screen.getByRole("button", { name: /Permission 8/ }));
  assert.deepEqual(selected, [{ kind: "attention", id: "approval:8" }]);
});

test("work beyond the initial page can be reached and filtered", () => {
  render(React.createElement(FoxOverview, {
    ...props,
    briefing: {
      ...emptyBriefing,
      dispatches: Array.from({ length: 12 }, (_, i) => ({
        id: `d${i}`, taskId: `d${i}`, at: now, task: `Task ${i}`,
        state: i === 11 ? "waited" : "running", targetSessionId: `s${i}`,
        sessionName: `Work item ${i}`, projectName: "App", projectKey: "/one/app",
      })),
    },
  }));
  assert.equal(screen.queryByText("Work item 11"), null);
  fireEvent.click(screen.getByRole("button", { name: "Show more (4 remaining)" }));
  assert.ok(screen.getByText("Work item 11"));
  fireEvent.click(screen.getByRole("button", { name: "Updates & results" }));
  assert.ok(screen.getByText("Work item 11"));
  assert.equal(screen.queryByText("Work item 0"), null);
  assert.ok(screen.getByText("Run ended"));
});

test("missing or failed sources never announce that nothing needs attention", () => {
  const view = render(React.createElement(FoxOverview, { ...props, chief: null, chiefFailed: true }));
  assert.ok(screen.getByText(/Pending decisions may be missing/));
  assert.equal(screen.queryByText("No pending decisions in the latest snapshot."), null);
  view.rerender(React.createElement(FoxOverview, { ...props, briefing: { ...emptyBriefing, warnings: ["sessions"] } }));
  assert.ok(screen.getByText(/this is not an all-clear/));
  assert.equal(screen.queryByText("No pending decisions in the latest snapshot."), null);
});

test("project scope uses canonical identity even when names match", () => {
  const changes = [];
  const view = render(React.createElement(FoxOverview, {
    ...props,
    chief: { ...emptyChief, approvals: [approval("first"), { ...approval("second"), projectRef: "/two/app" }] },
    onProjectChange: (value) => changes.push(value),
  }));
  fireEvent.change(screen.getByRole("combobox", { name: "Scope" }), { target: { value: "/two/app" } });
  assert.deepEqual(changes, ["/two/app"]);
  view.rerender(React.createElement(FoxOverview, {
    ...props, projectKey: "/two/app",
    chief: { ...emptyChief, approvals: [approval("first"), { ...approval("second"), projectRef: "/two/app" }] },
  }));
  assert.equal(screen.queryByText("Permission first"), null);
  assert.ok(screen.getByText("Permission second"));
});

test("unowned running sessions open their exact session rather than guessing a project", () => {
  const opened = [];
  render(React.createElement(FoxOverview, {
    ...props, onOpenSession: (id) => opened.push(id),
    briefing: { ...emptyBriefing, active: [{ id: "s:active", sessionId: "exact-id", kind: "activity", sessionName: "Independent run", projectKey: "/one/app", projectName: "App", at: now }] },
  }));
  fireEvent.click(within(screen.getByRole("region", { name: /Other running sessions/ })).getByRole("button", { name: /Independent run/ }));
  assert.deepEqual(opened, ["exact-id"]);
});

test("workbench copy covers every supported locale, including dynamic states", async () => {
  const sources = await Promise.all(["FoxOverview.tsx", "FoxWorkDetails.tsx", "FoxSettings.tsx", "FoxPage.tsx", "FoxActivity.tsx"].map((file) => readFile(new URL(file, import.meta.url), "utf8")));
  const keys = new Set(sources.flatMap((source) => [...source.matchAll(/t\("(fox\.[^"]+|chief\.[^"]+)"/g)].map((match) => match[1])));
  for (const group of [
    ["workState", "pending", "running", "waiting", "review", "ended", "updated", "failed", "done", "dropped"],
    ["service", "loading", "unavailable", "manual", "starting", "checking", "stale"],
    ["attentionKind", "approval", "input", "error", "blocked", "review"],
    ["attentionHint", "approval", "input", "error", "blocked", "review"],
    ["autonomy", "observe", "suggest", "approve", "auto"],
    ["native.worker", "running", "waiting", "error", "idle"],
    ["native.start", "delegate", "delegateHint", "progress", "progressHint", "preferences", "preferencesHint"],
    ["native.prompt", "delegate", "progress", "preferences"],
  ]) for (const value of group.slice(1)) keys.add(`fox.${group[0]}.${value}`);
  for (const locale of ["en", "zh-CN", "ja"]) {
    const messages = JSON.parse(await readFile(new URL(`../lib/i18n/locales/${locale}.json`, import.meta.url), "utf8"));
    for (const key of keys) assert.ok(messages[key], `${locale}: ${key}`);
  }
});
