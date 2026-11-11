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
const { writeFoxServiceState } = await jiti.import("./fox-service-state.ts");
const { emptyFoxServiceState, localDayKey } = await jiti.import("./fox-service-core.ts");
const { recordHistory, clearHistory } = await jiti.import("./notification-store.ts");
const { getSessionsDir } = await jiti.import("./omp/paths.ts");
const { invalidateSessionListCache } = await jiti.import("./session-reader.ts");
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
beforeEach(() => {
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
    send: async (command) => { prompts.push(command); },
  }]]);
  writeFoxSessionId("fox-test-session");
  writeFoxServiceConfig({ enabled: true, quietStart: "00:00", quietEnd: "00:00", maxDailyMessages: 3 });
  writeFoxServiceState({ ...emptyFoxServiceState(), seededAt: at, lastTickAt: at, daily: { date: localDayKey(Date.now()), count: 0 } });
  clearHistory();
  recordHistory({ type: "input", sessionId: "waiting", sessionName: "Project", detail: "Choose a release" });
  service.startFoxService();
  clearTimeout(globalThis.__foxnioFoxService.initial);
  clearInterval(globalThis.__foxnioFoxService.timer);
});
afterEach(() => {
  service.stopFoxService();
  globalThis.__ompSessions.clear();
});
test.after(() => {
  globalThis.__ompNotificationStore?.db.close();
  rmSync(root, { recursive: true, force: true });
});

test("an idle failed target is eligible for a normal wake and native recovery clears its failure health", async () => {
  assert.equal(service.foxServiceStatus().lastRunError, "Provider unavailable");
  assert.equal(foxServiceHealth(service.foxServiceStatus(), false, Date.now()), "error");
  const plan = await service.requestFoxServiceTick();
  assert.equal(plan.reason, "wake");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].type, "prompt");
  assert.match(prompts[0].message, /Choose a release/);
  assert.equal(service.foxServiceStatus().dailyCount, 1);
  assert.equal(service.foxServiceStatus().lastRunError, "Provider unavailable", "sending alone must not claim native recovery");
  lastRunError = null; // The native wrapper clears this on agent_start or a successful prompt_result.
  assert.equal(service.foxServiceStatus().lastRunError, null);
  assert.equal(foxServiceHealth(service.foxServiceStatus(), false, Date.now()), "checking");
});

for (const busy of ["running", "pending input"]) {
  test(`${busy} still prevents a wake even if the previous run failed`, async () => {
    running = busy === "running";
    pending = busy === "pending input" ? 1 : 0;
    assert.equal((await service.requestFoxServiceTick()).reason, "busy");
    assert.equal(prompts.length, 0);
    assert.equal(service.foxServiceStatus().pending, 1);
    running = false;
    pending = 0;
    assert.equal((await service.requestFoxServiceTick()).reason, "wake");
    assert.equal(prompts.length, 1);
  });
}

test("failure health belongs only to the currently registered FOX workspace", () => {
  globalThis.__ompSessions.set("other-session", {
    cwd: project, isAlive: () => true, lastRunErrorMessage: () => "Unrelated project error",
  });
  writeFoxSessionId("other-session");
  assert.equal(service.foxServiceStatus().lastRunError, null);
});
