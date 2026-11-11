import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildFoxMetrics, effectiveToolNamesForCwd, FOX_TOOL_NAMES, formatFoxBriefing, isFoxToolPolicy, isFoxWorkspacePath } = await jiti.import("./fox.ts");

const project = (name, overrides = {}) => ({
  key: `/work/${name}`,
  name,
  path: `/work/${name}`,
  sessions: 1,
  running: 0,
  waiting: 0,
  errors: 0,
  unread: 0,
  lastActivity: null,
  ...overrides,
});

const briefing = (overrides = {}) => ({
  generatedAt: "2026-11-07T12:00:00.000Z",
  totals: { projects: 0, sessions: 0, running: 0, waiting: 0, unread: 0 },
  needsYou: [],
  projects: [],
  recent: [],
  pulse: { hours: new Array(24).fill(0), max: 1 },
  ...overrides,
});

test("an empty portfolio is healthy and has no focus", () => {
  const metrics = buildFoxMetrics(briefing());
  assert.equal(metrics.health, 100);
  assert.equal(metrics.activeProjects, 0);
  assert.equal(metrics.attention, 0);
  assert.equal(metrics.focus, null);
  assert.deepEqual(metrics.distribution, { running: 0, waiting: 0, errors: 0, quiet: 0, total: 0 });
});

test("orders projects by error, waiting, running, then activity", () => {
  const metrics = buildFoxMetrics(briefing({
    totals: { projects: 4, sessions: 7, running: 1, waiting: 1, unread: 0 },
    projects: [
      project("quiet", { sessions: 4 }),
      project("active", { running: 1 }),
      project("waiting", { waiting: 1 }),
      project("critical", { errors: 1 }),
    ],
  }));

  assert.deepEqual(metrics.projects.map((signal) => signal.project.name), ["critical", "waiting", "active", "quiet"]);
  assert.deepEqual(metrics.projects.map((signal) => signal.state), ["critical", "waiting", "active", "quiet"]);
  assert.equal(metrics.focus.project.name, "critical");
});

test("health is reduced by errors and waiting but never negative", () => {
  const metrics = buildFoxMetrics(briefing({
    totals: { projects: 1, sessions: 12, running: 0, waiting: 10, unread: 0 },
    projects: [project("broken", { sessions: 12, errors: 5, waiting: 10 })],
  }));

  assert.equal(metrics.health, 0);
  assert.equal(metrics.distribution.errors, 5);
  assert.equal(metrics.distribution.quiet, 0);
  assert.equal(metrics.activeProjects, 1);
});

test("quiet sessions absorb the remainder without double counting", () => {
  const metrics = buildFoxMetrics(briefing({
    totals: { projects: 2, sessions: 6, running: 1, waiting: 1, unread: 0 },
    projects: [project("alpha", { sessions: 4, running: 1 }), project("beta", { sessions: 2, waiting: 1 })],
  }));

  assert.deepEqual(metrics.distribution, { running: 1, waiting: 1, errors: 0, quiet: 4, total: 6 });
  assert.equal(metrics.activeProjects, 2);
});

test("recognizes only FOX's resident cwd as hidden", () => {
  assert.equal(isFoxWorkspacePath("/home/telagod/.omp/agent/omp-web/fox"), true);
  assert.equal(isFoxWorkspacePath("C:\\Users\\telagod\\.omp\\agent\\omp-web\\fox\\"), true);
  assert.equal(isFoxWorkspacePath("/home/telagod/project/foxnio"), false);
  assert.equal(isFoxWorkspacePath("/home/telagod/project/fox"), false);
  assert.equal(isFoxWorkspacePath(null), false);
});

test("FOX uses native planning, questions and memory without project mutation tools", () => {
  assert.equal(isFoxToolPolicy([...FOX_TOOL_NAMES]), true);
  assert.equal(isFoxToolPolicy(["read", "grep", "glob"]), false);
  assert.equal(isFoxToolPolicy(["read", "grep", "glob", "bash"]), false);
  assert.equal(isFoxToolPolicy(["read", "grep", "glob", "recall", "retain", "reflect", "memory_edit"]), false);
  assert.equal(isFoxToolPolicy(["read", "grep", "glob", "recall", "retain", "reflect", "memory_edit", "glob"]), false);
  assert.equal(isFoxToolPolicy(null), false);
  assert.equal(isFoxToolPolicy(undefined), false);

  assert.deepEqual(
    effectiveToolNamesForCwd("/home/telagod/.omp/agent/omp-web/fox", ["bash", "read"]),
    [...FOX_TOOL_NAMES],
  );
  assert.deepEqual(effectiveToolNamesForCwd("/home/telagod/project/foxnio", ["bash", "read"]), ["bash", "read"]);
  assert.equal(effectiveToolNamesForCwd("/home/telagod/project/foxnio", undefined), undefined);
});

test("writes a compact 7-day snapshot with sanitized names and details", () => {
  const text = formatFoxBriefing(briefing({
    totals: { projects: 1, sessions: 2, running: 1, waiting: 0, unread: 0 },
    needsYou: [{
      id: "s1:error",
      kind: "error",
      sessionId: "s1",
      sessionName: "Fix\nlogin",
      projectKey: "/work/alpha",
      projectName: "Alpha",
      detail: "Boom\nagain",
      at: "2026-11-07T11:55:00.000Z",
    }],
    projects: [project("alpha", { sessions: 2, running: 1, lastActivity: "2026-11-07T11:50:00.000Z" })],
    active: [{
      id: "s1:active",
      kind: "activity",
      sessionId: "s1",
      sessionName: "Fix login",
      projectKey: "/work/alpha",
      projectName: "Alpha",
      detail: "Reproduce the auth failure",
      at: "2026-11-07T11:55:00.000Z",
    }],
    workers: [{
      sessionId: "s1",
      parentSessionId: "fox",
      cwd: "/work/alpha",
      at: "2026-11-07T11:56:00.000Z",
      title: "Fix the auth redirect",
      state: "running",
      projectName: "Alpha",
    }],
    recent: [{
      id: "s1:activity",
      kind: "activity",
      sessionId: "s1",
      sessionName: "Fix login",
      projectKey: "/work/alpha",
      projectName: "Alpha",
      at: "2026-11-07T11:55:00.000Z",
    }],
    warnings: ["sessions"],
  }));

  assert.match(text, /# FOX project context/);
  assert.match(text, /1 projects, 2 sessions, 1 running/);
  assert.match(text, /Fix login \(Alpha\) — Boom again/);
  assert.doesNotMatch(text, /Fix\nlogin/);
  assert.match(text, /## Active work/);
  assert.match(text, /Fix login \[s1\] \(Alpha\): Reproduce the auth failure/);
  assert.match(text, /## Native workers/);
  assert.match(text, /running: Fix the auth redirect \[s1\] cwd="\/work\/alpha"/);
  assert.doesNotMatch(text, /task=|taskId/);
  assert.match(text, /alpha cwd="\/work\/alpha": 2 sessions, 1 running, 0 waiting, 0 errors/);
  assert.match(text, /Warnings: sessions/);
});
