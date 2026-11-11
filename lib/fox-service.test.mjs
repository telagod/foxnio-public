import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { nativeEnvironment } from "../tests/omp-native-env.mjs";

const root = mkdtempSync(join(tmpdir(), "fox-service-recovery-"));
Object.assign(process.env, nativeEnvironment(root, join(root, "agent")));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const service = await jiti.import("./fox-service.ts");
const { foxServiceHealth } = await jiti.import("./fox-service-health.ts");
const { ensureFoxWorkspace } = await jiti.import("./fox-workspace.ts");
const { writeFoxSessionId } = await jiti.import("./fox-session.ts");
const { writeFoxServiceConfig } = await jiti.import("./fox-service-config.ts");
const { readFoxServiceState, writeFoxServiceState } = await jiti.import("./fox-service-state.ts");
const { emptyFoxServiceState, localDayKey } = await jiti.import("./fox-service-core.ts");
const { recordHistory, clearHistory } = await jiti.import("./notification-history-store.ts");
const { closeStorage } = await jiti.import("./storage/client.ts");
const { stopSessionIndex } = await jiti.import("./session-index.ts");
const { getSessionsDir } = await jiti.import("./omp/paths.ts");
const { invalidateSessionListCache } = await jiti.import("./session-reader.ts");
const goals = await jiti.import("./fox-goal-service.ts");
const { projectFoxGoal } = await jiti.import("./omp/fox-goals.mjs");
const cwd = ensureFoxWorkspace();
const project = join(root, "project");
const sessionDir = join(getSessionsDir(), "project");
mkdirSync(project, { recursive: true });
mkdirSync(sessionDir, { recursive: true });
const at = new Date().toISOString();
writeFileSync(join(sessionDir, "waiting.jsonl"), [
  { type: "session", version: 3, id: "waiting", cwd: project, timestamp: at },
  { type: "message", id: "question", parentId: null, timestamp: at, message: { role: "user", content: "Review this project" } },
].map((record) => JSON.stringify(record)).join("\n") + "\n");
invalidateSessionListCache();

let running;
let pending;
let lastRunError;
let prompts;
beforeEach(async () => {
  running = false;
  pending = 0;
  lastRunError = "Provider unavailable";
  prompts = [];
  globalThis.__ompSessions = new Map([["fox-test-session", {
    sessionId: "fox-test-session", cwd,
    isAlive: () => true,
    isRunning: () => running,
    pendingHumanRequests: () => pending,
    pendingHumanRequestDetail: () => pending ? "Choose an option" : null,
    lastRunErrorMessage: () => lastRunError,
    getFoxGoalSnapshot: async () => projectFoxGoal([]),
    send: async (command) => { prompts.push(command); },
  }]]);
  await writeFoxSessionId("fox-test-session");
  writeFoxServiceConfig({ enabled: true, quietStart: "00:00", quietEnd: "00:00", maxDailyMessages: 3 });
  await writeFoxServiceState({ ...emptyFoxServiceState(), seededAt: at, lastTickAt: at, daily: { date: localDayKey(Date.now()), count: 0 } }, (await readFoxServiceState()).version);
  await clearHistory();
  await recordHistory({ type: "input", sessionId: "waiting", sessionName: "Project", detail: "Choose a release" });
  await service.startFoxService();
  clearTimeout(globalThis.__foxnioFoxService.initial);
  clearInterval(globalThis.__foxnioFoxService.timer);
});
afterEach(async () => {
  await service.stopFoxService();
  globalThis.__ompSessions.clear();
});
test.after(async () => {
  await stopSessionIndex();
  await closeStorage();
  rmSync(root, { recursive: true, force: true });
});

test("an idle failed target is eligible for a normal wake and native recovery clears its failure health", async () => {
  assert.equal((await service.foxServiceStatus()).lastRunError, "Provider unavailable");
  assert.equal(foxServiceHealth(await service.foxServiceStatus(), false, Date.now()), "error");
  const plan = await service.requestFoxServiceTick();
  assert.equal(plan.reason, "wake");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].type, "prompt");
  assert.match(prompts[0].message, /Choose a release/);
  assert.equal((await service.foxServiceStatus()).dailyCount, 1);
  assert.equal((await service.foxServiceStatus()).lastRunError, "Provider unavailable", "sending alone must not claim native recovery");
  lastRunError = null; // The native wrapper clears this on agent_start or a successful prompt_result.
  assert.equal((await service.foxServiceStatus()).lastRunError, null);
  assert.equal(foxServiceHealth(await service.foxServiceStatus(), false, Date.now()), "checking");
});

for (const busy of ["running", "pending input"]) {
  test(`${busy} still prevents a wake even if the previous run failed`, async () => {
    running = busy === "running";
    pending = busy === "pending input" ? 1 : 0;
    assert.equal((await service.requestFoxServiceTick()).reason, "busy");
    assert.equal(prompts.length, 0);
    assert.equal((await service.foxServiceStatus()).pending, 1);
    running = false;
    pending = 0;
    assert.equal((await service.requestFoxServiceTick()).reason, "wake");
    assert.equal(prompts.length, 1);
  });
}

test("failure health belongs only to the currently registered FOX workspace", async () => {
  globalThis.__ompSessions.set("other-session", {
    cwd: project, isAlive: () => true, lastRunErrorMessage: () => "Unrelated project error",
  });
  await writeFoxSessionId("other-session");
  assert.equal((await service.foxServiceStatus()).lastRunError, null);
});

test("legacy observation survives an unavailable goal capability only after a complete no-grant journal read", async () => {
  const file = join(root, "legacy-fox.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "fox-test-session", cwd, timestamp: at }) + "\n");
  const wrapper = globalThis.__ompSessions.get("fox-test-session");
  wrapper.sessionFile = file;
  wrapper.getFoxGoalSnapshot = async () => { throw new Error("OMP native goal RPC is unsupported"); };
  assert.equal((await goals.getFoxGoalSnapshot()).supported, false);
  assert.equal((await service.requestFoxServiceTick()).reason, "wake");
  assert.equal(prompts.length, 1);
  rmSync(file);
});

test("unavailable goal capability never treats a damaged authority journal as an empty legacy conversation", async () => {
  const file = join(root, "damaged-fox.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "fox-test-session", cwd, timestamp: at }) + '\n{"type":"custom","customType":"fox-goal"');
  const wrapper = globalThis.__ompSessions.get("fox-test-session");
  wrapper.sessionFile = file;
  wrapper.getFoxGoalSnapshot = async () => { throw new Error("OMP native goal RPC is unsupported"); };
  assert.equal(await service.requestFoxServiceTick(), null);
  assert.equal(prompts.length, 0);
  rmSync(file);
});

test("unavailable goal capability cannot bypass persisted grant authority", async () => {
  const file = join(root, "granted-fox.jsonl");
  writeFileSync(file, [
    { type: "session", version: 3, id: "fox-test-session", cwd, timestamp: at },
    { type: "custom", id: "authority", parentId: null, timestamp: at, customType: "fox-goal", data: { version: 1, op: "consent", sessionId: "fox-test-session" } },
  ].map(JSON.stringify).join("\n") + "\n");
  const wrapper = globalThis.__ompSessions.get("fox-test-session");
  wrapper.sessionFile = file;
  wrapper.getFoxGoalSnapshot = async () => { throw new Error("OMP native goal RPC is unsupported"); };
  assert.equal(await service.requestFoxServiceTick(), null);
  assert.equal(prompts.length, 0);
  rmSync(file);
});

test("stop joins an admitted observation and prevents a prompt after the goal read completes", { timeout: 20_000 }, async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const wrapper = globalThis.__ompSessions.get("fox-test-session");
  wrapper.getFoxGoalSnapshot = async () => {
    entered.resolve();
    await release.promise;
    return projectFoxGoal([]);
  };
  const tick = service.requestFoxServiceTick();
  await entered.promise;
  let stopped = false;
  const stopping = service.stopFoxService().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false, "the shutdown barrier must join an admitted tick");
  release.resolve();
  assert.equal(await tick, null);
  await stopping;
  assert.deepEqual(prompts, []);
  assert.equal(globalThis.__foxnioFoxService, undefined);
});

test("stop waits for an already submitted prompt to settle before releasing the resident service", { timeout: 20_000 }, async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  globalThis.__ompSessions.get("fox-test-session").send = async command => {
    prompts.push(command);
    entered.resolve();
    await release.promise;
  };
  const tick = service.requestFoxServiceTick();
  await entered.promise;
  let stopped = false;
  const stopping = service.stopFoxService().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.equal(await service.requestFoxServiceTick(), null, "shutdown does not admit a second observation");
  release.resolve();
  await tick;
  await stopping;
  assert.equal(prompts.length, 1);
  assert.equal((await readFoxServiceState()).claim, undefined);
  assert.equal(globalThis.__foxnioFoxService, undefined);
});

test("stop cancels a storage-gated FOX startup instead of installing late timers", { timeout: 20_000 }, async t => {
  await service.stopFoxService();
  const client = [...globalThis.__foxStorageContext.clients.values()][0];
  const request = client.request;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.mock.method(client, "request", async function (input) {
    if (input.operation === "head") {
      entered.resolve();
      await release.promise;
    }
    return request.call(this, input);
  });
  const starting = service.startFoxService();
  await entered.promise;
  let stopped = false;
  const stopping = service.stopFoxService().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  release.resolve();
  await starting;
  await stopping;
  assert.equal(globalThis.__foxnioFoxService, undefined);
  assert.equal(globalThis.__foxReportRelay.timer, null);
});

test("shutdown fences a claimed observation before its native prompt boundary", { timeout: 20_000 }, async t => {
  const client = [...globalThis.__foxStorageContext.clients.values()][0];
  const request = client.request;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.mock.method(client, "request", async function (input) {
    const result = await request.call(this, input);
    if (input.operation === "observation.claim") {
      entered.resolve();
      await release.promise;
    }
    return result;
  });
  const tick = service.requestFoxServiceTick();
  await entered.promise;
  const stopping = service.stopFoxService();
  release.resolve();
  assert.equal((await tick).reason, "wake-failed");
  await stopping;
  assert.deepEqual(prompts, []);
  assert.equal((await readFoxServiceState()).claim, undefined);
});

test("the resident timer joins the same shutdown barrier as a requested tick", { timeout: 20_000 }, async t => {
  await service.stopFoxService();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await service.startFoxService();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  globalThis.__ompSessions.get("fox-test-session").getFoxGoalSnapshot = async () => {
    entered.resolve();
    await release.promise;
    return projectFoxGoal([]);
  };
  t.mock.timers.tick(5000);
  await entered.promise;
  let stopped = false;
  const stopping = service.stopFoxService().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false);
  release.resolve();
  await stopping;
  assert.deepEqual(prompts, []);
  assert.equal(globalThis.__foxnioFoxService, undefined);
  t.mock.timers.reset();
});
