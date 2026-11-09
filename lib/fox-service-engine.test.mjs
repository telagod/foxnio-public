import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const core = await jiti.import("./fox-service-core.ts");
const { createFoxServiceEngine } = await jiti.import("./fox-service-engine.ts");

const now = new Date(2026, 10, 8, 12, 0, 0).getTime();

const config = (overrides = {}) => ({
  enabled: true,
  quietStart: "22:00",
  quietEnd: "08:00",
  maxDailyMessages: 3,
  ...overrides,
});

const item = (sessionId = "s1") => ({
  id: `${sessionId}:error`,
  kind: "error",
  sessionId,
  sessionName: sessionId,
  projectKey: "/work/p1",
  projectName: "p1",
  detail: "boom",
  at: "2026-11-08T04:00:00.000Z",
});

function harness(initial = {}) {
  let state = core.emptyFoxServiceState();
  let events = initial.events ?? [];
  let settings = initial.config ?? config();
  let busy = initial.busy ?? false;
  const calls = { wake: [], saved: [] };
  const target = "target" in initial ? initial.target : { sessionId: "fox" };
  const load = initial.load ?? (async () => ({ needsYou: events }));
  const engine = createFoxServiceEngine({
    now: () => now,
    loadBriefing: load,
    observe: initial.observe,
    loadConfig: () => settings,
    loadState: () => state,
    saveState: (next) => {
      state = next;
      calls.saved.push(next);
    },
    resolveTarget: async () => target,
    isBusy: () => busy,
    wake: async (nextTarget, message) => {
      calls.wake.push({ target: nextTarget, message });
      await initial.wake?.(nextTarget, message);
    },
    log: () => {},
  });
  return {
    engine,
    calls,
    state: () => state,
    setEvents: (next) => { events = next; },
    setConfig: (next) => { settings = next; },
    setBusy: (next) => { busy = next; },
  };
}

test("seeds the portfolio, then wakes once for a new event", async () => {
  const h = harness();
  const seeded = await h.engine.tick(now);
  assert.equal(seeded.reason, "seeded");
  assert.equal(h.calls.wake.length, 0);

  h.setEvents([item()]);
  const woken = await h.engine.tick(now);
  assert.equal(woken.reason, "wake");
  assert.equal(h.calls.wake.length, 1);
  assert.equal(h.calls.wake[0].target.sessionId, "fox");
  assert.match(h.calls.wake[0].message, /boom/);
  assert.equal(h.state().daily.count, 1);

  const duplicate = await h.engine.tick(now);
  assert.equal(duplicate.reason, "no-events");
  assert.equal(h.calls.wake.length, 1);
});

test("a failed wake remains retryable without spending the daily cap", async () => {
  let fail = true;
  const h = harness({
    wake: async () => {
      if (fail) throw new Error("RPC down");
    },
  });
  await h.engine.tick(now);
  h.setEvents([item()]);
  const failed = await h.engine.tick(now);
  assert.equal(failed.reason, "wake-failed");
  assert.equal(h.state().daily.count, 0);
  assert.equal(h.state().pending.length, 1);
  assert.equal(h.state().pending[0].attempts, 1);

  fail = false;
  const retried = await h.engine.tick(now);
  assert.equal(retried.reason, "wake");
  assert.equal(h.state().daily.count, 1);
  assert.equal(h.state().pending.length, 0);
});

test("a disabled service observes without waking or replaying a backlog", async () => {
  const h = harness();
  await h.engine.tick(now);
  h.setConfig(config({ enabled: false }));
  h.setEvents([item()]);
  const disabled = await h.engine.tick(now);
  assert.equal(disabled.reason, "disabled");
  assert.equal(h.calls.wake.length, 0);

  h.setConfig(config());
  const enabled = await h.engine.tick(now);
  assert.equal(enabled.reason, "no-events");
  assert.equal(h.calls.wake.length, 0);
});

test("a busy FOX session queues until idle", async () => {
  const h = harness({ busy: true });
  await h.engine.tick(now);
  h.setEvents([item()]);
  const queued = await h.engine.tick(now);
  assert.equal(queued.reason, "busy");
  assert.equal(h.calls.wake.length, 0);
  assert.equal(h.state().pending.length, 1);

  h.setBusy(false);
  const woken = await h.engine.tick(now);
  assert.equal(woken.reason, "wake");
  assert.equal(h.calls.wake.length, 1);
});

test("a missing or reset FOX queues attention without creating a replacement conversation", async () => {
  const h = harness({ target: null });
  await h.engine.tick(now);
  h.setEvents([item()]);
  const plan = await h.engine.tick(now);
  assert.equal(plan.reason, "busy");
  assert.equal(h.calls.wake.length, 0);
  assert.equal(h.state().pending.length, 1);
  assert.equal(h.state().pending[0].attempts, 0);
});

test("a disabled service never records events or tickets", async () => {
  let observed = 0;
  const h = harness({
    config: config({ enabled: false }),
    observe: (events) => {
      observed += 1;
      return events;
    },
  });
  const plan = await h.engine.tick(now);
  assert.equal(plan.reason, "seeded");
  assert.equal(observed, 0);
  assert.equal(h.calls.wake.length, 0);
});

test("a briefing failure returns null without saving state", async () => {
  const h = harness({ load: async () => { throw new Error("offline"); } });
  const plan = await h.engine.tick(now);
  assert.equal(plan, null);
  assert.equal(h.calls.saved.length, 0);
});

test("native worker reports trigger a review, never an inferred completed ticket", async () => {
  let workers = [];
  const h = harness({ load: async () => ({ needsYou: [], workers }) });
  await h.engine.tick(now);
  workers = [{ sessionId: "worker", title: "Check release", projectKey: "/work/app", projectName: "app", state: "idle", messageCount: 2, at: "2026-11-08T12:00:00Z" }];
  assert.equal((await h.engine.tick(now)).reason, "no-events");
  workers[0].reportDelivery = "received";
  workers[0].report = { id: "worker:1", status: "result", summary: "Release checks passed", at: workers[0].at };
  const plan = await h.engine.tick(now);
  assert.equal(plan.reason, "wake");
  assert.match(plan.wake.message, /not independently verified completion/);
  assert.match(plan.wake.message, /Never call ask, new_session or send_to_session/);
  assert.equal((await h.engine.tick(now)).reason, "no-events");
});
