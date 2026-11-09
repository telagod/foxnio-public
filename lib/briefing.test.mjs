import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildBriefing } = await jiti.import("./briefing.ts");

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const session = (id, project, overrides = {}) => ({
  id,
  path: `/tmp/${id}.jsonl`,
  cwd: `/work/${project}`,
  name: `Session ${id}`,
  created: iso(10 * DAY),
  modified: iso(HOUR),
  lastMessageAt: iso(HOUR),
  messageCount: 1,
  firstMessage: `First message ${id}`,
  projectRoot: `/work/${project}`,
  projectKey: `/work/${project}`,
  ...overrides,
});

const project = (path, alias) => ({ path, alias });

const notification = (type, sessionId, at, read = false, detail) => ({
  id: `${sessionId}:${type}`,
  event: { type, sessionId, sessionName: `Session ${sessionId}`, detail },
  at,
  read,
});

test("an empty workspace yields an empty, quiet briefing", () => {
  const briefing = buildBriefing({ now: NOW, sessions: [], projects: [], live: [], notifications: [] });
  assert.deepEqual(briefing.totals, { projects: 0, sessions: 0, running: 0, waiting: 0, unread: 0 });
  assert.deepEqual(briefing.needsYou, []);
  assert.deepEqual(briefing.projects, []);
  assert.deepEqual(briefing.recent, []);
  assert.equal(briefing.pulse.hours.length, 24);
  assert.equal(briefing.pulse.hours.reduce((sum, count) => sum + count, 0), 0);
  assert.equal(briefing.pulse.max, 1);
});

test("pulse buckets session activity into the last 24 hours", () => {
  const briefing = buildBriefing({
    now: NOW,
    sessions: [
      session("recent", "alpha", { lastMessageAt: iso(30 * 60 * 1000) }),
      session("now", "alpha", { lastMessageAt: iso(0) }),
      session("older", "alpha", { lastMessageAt: iso(1.5 * HOUR) }),
      session("outside", "beta", { lastMessageAt: iso(25 * HOUR) }),
    ],
    projects: [project("/work/alpha", "Alpha"), project("/work/beta", "Beta")],
  });

  assert.equal(briefing.pulse.hours.length, 24);
  assert.equal(briefing.pulse.hours[23], 1, "the current hour is last");
  assert.equal(briefing.pulse.hours[22], 1);
  assert.equal(briefing.pulse.hours[21], 1);
  assert.equal(briefing.pulse.hours.reduce((sum, count) => sum + count, 0), 3);
  assert.equal(briefing.pulse.max, 1);
});

test("groups sessions by project and derives running, waiting, errors, and unread", () => {
  const briefing = buildBriefing({
    now: NOW,
    sessions: [
      session("a1", "alpha"),
      session("a2", "alpha"),
      session("b1", "beta"),
    ],
    projects: [project("/work/alpha", "Alpha")],
    live: [
      { id: "a1", running: true, pendingInput: 0, lastRunError: "Boom" },
      { id: "a2", running: true, pendingInput: 1 },
    ],
    notifications: [
      notification("input", "b1", NOW - 30 * 60 * 1000, false, "Answer me"),
      notification("error", "a1", NOW - 10 * 60 * 1000, false, "Boom"),
    ],
  });

  assert.equal(briefing.projects.length, 2);
  const alpha = briefing.projects.find((entry) => entry.key === "/work/alpha");
  const beta = briefing.projects.find((entry) => entry.key === "/work/beta");
  assert.equal(alpha.name, "Alpha");
  assert.equal(alpha.sessions, 2);
  assert.equal(alpha.running, 1);
  assert.equal(alpha.waiting, 1);
  assert.equal(alpha.errors, 1);
  assert.equal(alpha.unread, 1);
  assert.equal(beta.name, "beta");
  assert.equal(beta.sessions, 1);
  assert.equal(beta.waiting, 1);
  assert.equal(beta.unread, 1);

  assert.equal(briefing.needsYou.length, 3);
  assert.equal(briefing.needsYou[0].kind, "error");
  assert.equal(briefing.needsYou[0].sessionId, "a1");
  assert.equal(briefing.needsYou[1].kind, "input");
  assert.equal(briefing.needsYou[2].kind, "input");
  assert.equal(briefing.recent.length, 3);
});

test("live work carries the task and the exact pending question", () => {
  const briefing = buildBriefing({
    now: NOW,
    sessions: [session("run", "alpha"), session("ask", "beta")],
    live: [
      { id: "run", running: true, pendingInput: 0, pendingInputDetail: null },
      { id: "ask", running: true, pendingInput: 1, pendingInputDetail: "Which branch should I use?" },
    ],
  });

  assert.equal(briefing.active?.length, 1);
  assert.equal(briefing.active?.[0].sessionId, "run");
  assert.equal(briefing.active?.[0].detail, "First message run");
  const question = briefing.needsYou.find((item) => item.sessionId === "ask");
  assert.equal(question?.kind, "input");
  assert.equal(question?.detail, "Which branch should I use?");
});

test("a live pending request and its unread notification produce one input row", () => {
  const briefing = buildBriefing({
    now: NOW,
    sessions: [session("s1", "alpha")],
    live: [{ id: "s1", running: true, pendingInput: 1 }],
    notifications: [notification("input", "s1", NOW - 1000, false, "Which file?")],
  });

  assert.equal(briefing.needsYou.filter((item) => item.sessionId === "s1").length, 1);
  assert.equal(briefing.projects[0].waiting, 1);
});

test("a live session with no pending request ignores its stale unread input notification", () => {
  const briefing = buildBriefing({
    now: NOW,
    sessions: [session("s1", "alpha")],
    live: [{ id: "s1", running: true, pendingInput: 0 }],
    notifications: [notification("input", "s1", NOW - 1000, false, "Answered already")],
  });

  assert.equal(briefing.needsYou.length, 0);
  assert.equal(briefing.projects[0].running, 1);
  assert.equal(briefing.projects[0].waiting, 0);
  assert.equal(briefing.projects[0].unread, 1);
});

test("an unread error resolved by a later completion is not shown", () => {
  const briefing = buildBriefing({
    now: NOW,
    sessions: [session("s1", "alpha")],
    notifications: [
      notification("error", "s1", NOW - 2 * HOUR, false, "Thinking loop detected"),
      notification("completed", "s1", NOW - HOUR, false),
    ],
  });

  assert.deepEqual(briefing.needsYou, []);
  assert.equal(briefing.projects[0].errors, 0);
  assert.equal(briefing.projects[0].unread, 2);
});

test("a live session without a recorded failure ignores its unread error notification", () => {
  const briefing = buildBriefing({
    now: NOW,
    sessions: [session("s1", "alpha")],
    live: [{ id: "s1", running: false, pendingInput: 0, lastRunError: null }],
    notifications: [notification("error", "s1", NOW - HOUR, false, "Boom")],
  });

  assert.deepEqual(briefing.needsYou, []);
  assert.equal(briefing.projects[0].errors, 0);
  assert.equal(briefing.projects[0].unread, 1);
});

test("a failed live run is visible without notification history", () => {
  const briefing = buildBriefing({
    now: NOW,
    sessions: [session("s1", "alpha")],
    live: [{ id: "s1", running: false, pendingInput: 0, lastRunError: "Boom" }],
    notifications: [notification("error", "s1", NOW - 1000, false, "Older failure")],
  });

  assert.equal(briefing.needsYou.length, 1);
  assert.equal(briefing.needsYou[0].kind, "error");
  assert.equal(briefing.needsYou[0].detail, "Boom");
  assert.equal(briefing.projects[0].errors, 1);
});

test("excludeSession removes only the needs-you row, not the project", () => {
  const briefing = buildBriefing({
    now: NOW,
    sessions: [session("a1", "alpha"), session("b1", "beta")],
    live: [{ id: "a1", running: true, pendingInput: 1 }],
    notifications: [notification("error", "b1", NOW - 1000, false, "Broken")],
    excludeSessionId: "a1",
  });

  assert.equal(briefing.needsYou.some((item) => item.sessionId === "a1"), false);
  assert.equal(briefing.projects.length, 2);
});

test("days bounds the session set while recent stays on its 24-hour window", () => {
  const old = session("old", "alpha", { modified: iso(8 * DAY), lastMessageAt: iso(8 * DAY) });
  const current = session("current", "alpha");

  const week = buildBriefing({ now: NOW, sessions: [old, current], days: 7 });
  assert.equal(week.totals.sessions, 1);
  assert.equal(week.projects[0].sessions, 1);

  const month = buildBriefing({ now: NOW, sessions: [old, current], days: 30 });
  assert.equal(month.totals.sessions, 2);
  assert.equal(month.recent.some((item) => item.sessionId === "old"), false);
  assert.equal(month.recent.some((item) => item.sessionId === "current"), true);
});

test("recent activity is capped at twenty rows", () => {
  const sessions = Array.from({ length: 25 }, (_, index) =>
    session(`s${index}`, "alpha", { lastMessageAt: iso(index * 60 * 1000) }),
  );
  const briefing = buildBriefing({ now: NOW, sessions });
  assert.equal(briefing.recent.length, 20);
});

test("source warnings pass through and registered projects without sessions stay hidden", () => {
  const briefing = buildBriefing({
    now: NOW,
    sessions: [],
    projects: [project("/work/empty", "Empty")],
    warnings: ["sessions"],
  });
  assert.deepEqual(briefing.warnings, ["sessions"]);
  assert.deepEqual(briefing.projects, []);
});
