import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const core = await jiti.import("./fox-service-core.ts");

const config = (overrides = {}) => ({
  enabled: true,
  quietStart: "22:00",
  quietEnd: "08:00",
  maxDailyMessages: 3,
  ...overrides,
});

const item = (overrides = {}) => ({
  id: "s1:error",
  kind: "error",
  sessionId: "s1",
  sessionName: "Session 1",
  projectKey: "/work/p1",
  projectName: "p1",
  detail: "boom",
  at: "2026-11-08T04:00:00.000Z",
  ...overrides,
});

const eventsFor = (...items) => core.extractFoxEvents({ needsYou: items });

const local = (hour, day = 8) => new Date(2026, 10, day, hour, 0, 0).getTime();

function seededState(now = local(12), items = []) {
  return core.planFoxTick({
    events: eventsFor(...items),
    state: core.emptyFoxServiceState(),
    config: config(),
    now,
    foxBusy: false,
  }).state;
}

test("the first tick baselines existing attention without waking", () => {
  const now = local(12);
  const plan = core.planFoxTick({
    events: eventsFor(item()),
    state: core.emptyFoxServiceState(),
    config: config(),
    now,
    foxBusy: false,
  });
  assert.equal(plan.reason, "seeded");
  assert.equal(plan.wake, null);
  assert.ok(plan.state.seededAt);
  assert.equal(plan.state.pending.length, 0);
  assert.equal(Object.keys(plan.state.seen).length, 1);
  assert.equal(plan.state.lastTickAt, new Date(now).toISOString());
});

test("a new event wakes once and the same occurrence never wakes twice", () => {
  const now = local(12);
  const baseline = seededState(now);
  const first = core.planFoxTick({ events: eventsFor(item()), state: baseline, config: config(), now, foxBusy: false });
  assert.equal(first.reason, "wake");
  assert.equal(first.wake.events.length, 1);
  assert.match(first.wake.message, /\[error\]/);
  assert.match(first.wake.message, /proactive check/);
  assert.equal(first.state.daily.count, 1);
  assert.equal(first.state.pending.length, 0);

  const second = core.planFoxTick({ events: eventsFor(item()), state: first.state, config: config(), now, foxBusy: false });
  assert.equal(second.reason, "no-events");
  assert.equal(second.wake, null);
});

test("disabled service observes without waking and does not replay a backlog", () => {
  const now = local(12);
  const baseline = seededState(now);
  const disabled = core.planFoxTick({
    events: eventsFor(item()),
    state: baseline,
    config: config({ enabled: false }),
    now,
    foxBusy: false,
  });
  assert.equal(disabled.reason, "disabled");
  assert.equal(disabled.wake, null);
  assert.equal(disabled.state.pending.length, 0);
  assert.equal(Object.keys(disabled.state.seen).length, 1);

  const enabled = core.planFoxTick({
    events: eventsFor(item()),
    state: disabled.state,
    config: config(),
    now,
    foxBusy: false,
  });
  assert.equal(enabled.reason, "no-events");
  assert.equal(enabled.wake, null);
});

test("quiet hours queue the event and wake after the window", () => {
  const night = local(23);
  const baseline = seededState(night);
  const quiet = core.planFoxTick({ events: eventsFor(item()), state: baseline, config: config(), now: night, foxBusy: false });
  assert.equal(quiet.reason, "quiet");
  assert.equal(quiet.wake, null);
  assert.equal(quiet.state.pending.length, 1);

  const morning = local(9, 9);
  const wake = core.planFoxTick({ events: eventsFor(item()), state: quiet.state, config: config(), now: morning, foxBusy: false });
  assert.equal(wake.reason, "wake");
  assert.equal(wake.wake.events.length, 1);
});

test("a running FOX turn queues wakes until the session is idle", () => {
  const now = local(12);
  const baseline = seededState(now);
  const busy = core.planFoxTick({ events: eventsFor(item()), state: baseline, config: config(), now, foxBusy: true });
  assert.equal(busy.reason, "busy");
  assert.equal(busy.wake, null);
  assert.equal(busy.state.pending.length, 1);

  const idle = core.planFoxTick({ events: eventsFor(item()), state: busy.state, config: config(), now, foxBusy: false });
  assert.equal(idle.reason, "wake");
  assert.equal(idle.wake.events.length, 1);
});

test("an event that resolves while queued is dropped", () => {
  const now = local(12);
  const baseline = seededState(now);
  const busy = core.planFoxTick({ events: eventsFor(item()), state: baseline, config: config(), now, foxBusy: true });
  const resolved = core.planFoxTick({ events: [], state: busy.state, config: config(), now, foxBusy: false });
  assert.equal(resolved.reason, "no-events");
  assert.equal(resolved.state.pending.length, 0);
});

test("the daily cap suppresses a wake and does not lose the event silently", () => {
  const now = local(12);
  const baseline = seededState(now);
  const atCap = {
    ...baseline,
    daily: { date: core.localDayKey(now), count: 3 },
  };
  const plan = core.planFoxTick({ events: eventsFor(item()), state: atCap, config: config(), now, foxBusy: false });
  assert.equal(plan.reason, "cap");
  assert.equal(plan.wake, null);
  assert.equal(plan.state.pending.length, 0);
  assert.equal(Object.keys(plan.state.seen).length, 1);
});

test("a failed wake stays pending without consuming the daily budget", () => {
  const now = local(12);
  const baseline = seededState(now);
  const plan = core.planFoxTick({ events: eventsFor(item()), state: baseline, config: config(), now, foxBusy: false });
  assert.equal(plan.reason, "wake");
  const before = baseline;
  const failed = core.recordWakeFailure(before, plan.wake.events, now);
  assert.equal(failed.daily.count, 0);
  assert.equal(failed.lastWakeAt, null);
  assert.equal(failed.pending.length, 1);
  assert.equal(failed.pending[0].attempts, 1);

  const retry = core.planFoxTick({ events: eventsFor(item()), state: failed, config: config(), now, foxBusy: false });
  assert.equal(retry.reason, "wake");
  assert.equal(retry.state.daily.count, 1);
});

test("a poison event stops retrying after three failed wakes", () => {
  const now = local(12);
  let state = seededState(now);
  const plan = core.planFoxTick({ events: eventsFor(item()), state, config: config(), now, foxBusy: false });
  const events = plan.wake.events;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    state = core.recordWakeFailure(state, events, now);
  }
  assert.equal(state.pending.length, 0);
  const next = core.planFoxTick({ events: eventsFor(item()), state, config: config(), now, foxBusy: false });
  assert.equal(next.reason, "no-events");
});

test("quiet window handles daytime and cross-midnight windows", () => {
  assert.equal(core.isQuietAt(local(12), "22:00", "08:00"), false);
  assert.equal(core.isQuietAt(local(23), "22:00", "08:00"), true);
  assert.equal(core.isQuietAt(local(7), "22:00", "08:00"), true);
  assert.equal(core.isQuietAt(local(12), "09:00", "18:00"), true);
  assert.equal(core.isQuietAt(local(8), "09:00", "18:00"), false);
  assert.equal(core.isQuietAt(local(12), "12:00", "12:00"), false);
});

test("extracts errors first, dedupes, and keeps detail in the occurrence key", () => {
  const events = eventsFor(
    item({ id: "s1:input", kind: "input", sessionId: "s1", at: "2026-11-08T05:00:00.000Z", detail: "question" }),
    item({ id: "s2:error", kind: "error", sessionId: "s2", at: "2026-11-08T04:00:00.000Z", detail: "boom" }),
    item({ id: "s2:error", kind: "error", sessionId: "s2", at: "2026-11-08T04:00:00.000Z", detail: "boom" }),
    item({ id: "s3:activity", kind: "activity", sessionId: "s3" }),
  );
  assert.deepEqual(events.map((event) => [event.kind, event.sessionId]), [["error", "s2"], ["input", "s1"]]);
  assert.notEqual(core.eventKey(item({ detail: "a" })), core.eventKey(item({ detail: "b" })));
});

test("worker updates come from delivered reports, never idle state or prefix-derived message counts", () => {
  const worker = { sessionId: "worker-one", title: "Task", projectName: "App", projectKey: "/app", state: "idle", messageCount: 200, at: "2026-11-08T12:00:00Z" };
  assert.deepEqual(core.extractFoxEvents({ needsYou: [], workers: [worker] }), []);
  const report = { id: "worker-one:1", status: "result", summary: "Checks passed", at: worker.at };
  assert.deepEqual(core.extractFoxEvents({ needsYou: [], workers: [{ ...worker, report, reportDelivery: "pending" }] }), []);
  const events = core.extractFoxEvents({ needsYou: [], workers: [{ ...worker, report, reportDelivery: "received", messageCount: 1 }] });
  assert.equal(events.length, 1);
  assert.match(events[0].detail, /Checks passed/);
  assert.match(events[0].detail, /not independently verified/);
  assert.equal(events[0].key, JSON.stringify(["worker-report", report.id]));
});
