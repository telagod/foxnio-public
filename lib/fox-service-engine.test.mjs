import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  let version = 0;
  let claim;
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
    loadState: async () => ({ state: { ...state, pending: [] }, version, claim }),
    saveState: async (next, expectedVersion) => {
      assert.equal(expectedVersion, version);
      if (initial.save) await initial.save(next);
      state = next;
      calls.saved.push(next);
      return { state, version: ++version };
    },
    claimWake: async (request) => {
      if (claim || request.expectedVersion !== version || initial.denyClaim) return { claimed: false, version };
      claim = { ...request, leaseUntil: request.now + request.leaseMs, status: "pending" };
      return { claimed: true, version: ++version };
    },
    settleWake: async (request) => {
      if (initial.settle) await initial.settle(request);
      assert.equal(request.wakeId, claim.wakeId);
      assert.equal(request.owner, claim.owner);
      state = request.state ?? state;
      claim = request.outcome === "uncertain" ? { ...claim, status: "uncertain" } : undefined;
      return { state, version: ++version, claim };
    },
    resolveTarget: async () => target,
    isBusy: () => busy,
    wake: async (nextTarget, message, wakeId) => {
      assert.equal(claim.wakeId, wakeId);
      assert.equal(claim.targetSessionId, nextTarget?.sessionId);
      calls.wake.push({ target: nextTarget, message, wakeId });
      await initial.wake?.(nextTarget, message, wakeId);
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
      if (fail) throw Object.assign(new Error("RPC down before submission"), { outcome: "not-submitted" });
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

test("post-submit unknown outcomes reserve the budget and are never replayed", async () => {
  const h = harness({ wake: async () => { throw new Error("ack timed out"); } });
  await h.engine.tick(now);
  h.setEvents([item()]);
  assert.equal((await h.engine.tick(now)).reason, "wake-uncertain");
  assert.equal(h.state().daily.count, 1);
  assert.equal((await h.engine.tick(now + 3_600_000)).reason, "wake-uncertain");
  assert.equal(h.calls.wake.length, 1);
  assert.ok(h.calls.wake[0].wakeId);
});

test("a lost cross-process claim never submits a model turn", async () => {
  const h = harness({ denyClaim: true });
  await h.engine.tick(now);
  h.setEvents([item()]);
  assert.equal(await h.engine.tick(now), null);
  assert.equal(h.calls.wake.length, 0);
  assert.equal(h.state().daily.count, 0);
});

test("a failed durable seed save is not silently published in memory", async () => {
  let fail = true;
  const h = harness({ save: async () => { if (fail) throw new Error("disk unavailable"); } });
  await assert.rejects(h.engine.tick(now), /disk unavailable/);
  fail = false;
  h.setEvents([item()]);
  assert.equal((await h.engine.tick(now)).reason, "seeded");
  assert.equal(h.calls.wake.length, 0);
});

test("failed persistence after native submission leaves claim blocking replay", async () => {
  const h = harness({ settle: async () => { throw new Error("worker disappeared"); } });
  await h.engine.tick(now);
  h.setEvents([item()]);
  await assert.rejects(h.engine.tick(now), /worker disappeared/);
  assert.equal((await h.engine.tick(now + 120_000)).reason, "wake-claimed");
  assert.equal(h.calls.wake.length, 1);
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

test("two engines sharing durable state admit only one native wake", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "fox-observation-race-"));
  const store = await jiti.import("./fox-service-state.ts");
  const { closeStorage } = await jiti.import("./storage/client.ts");
  t.after(async () => { await closeStorage(); rmSync(home, { recursive: true, force: true }); });
  const original = await store.readFoxServiceState(home);
  await store.writeFoxServiceState({ ...original.state, seededAt: new Date(now).toISOString() }, original.version, home);
  const wakes = [];
  const deps = {
    now: () => now,
    loadBriefing: async () => ({ needsYou: [item()], workers: [] }),
    loadConfig: () => config(),
    loadState: () => store.readFoxServiceState(home),
    saveState: (state, version) => store.writeFoxServiceState(state, version, home),
    claimWake: (request) => store.claimFoxObservation(request, home),
    settleWake: (request) => store.settleFoxObservation(request, home),
    resolveTarget: async () => ({ sessionId: "fox-observation-session" }),
    isBusy: () => false,
    wake: async (_target, _message, wakeId) => { wakes.push(wakeId); },
  };
  const first = createFoxServiceEngine(deps);
  const second = createFoxServiceEngine(deps);
  await Promise.all([first.tick(), second.tick()]);
  assert.equal(wakes.length, 1);
  const state = await store.readFoxServiceState(home);
  assert.equal(state.state.daily.count, 1);
  assert.equal(state.claim, undefined);
  await first.tick();
  await second.tick();
  assert.equal(wakes.length, 1);
});
