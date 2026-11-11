import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const core = await jiti.import("./fox-service-core.ts");
const stateStore = await jiti.import("./fox-service-state.ts");
const configStore = await jiti.import("./fox-service-config.ts");
const { closeStorage } = await jiti.import("./storage/client.ts");

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), "fox-control-"));
  t.after(async () => { await closeStorage(); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test("durable state retains dedupe and budget, not a pending event ledger", async (t) => {
  const dir = home(t);
  const original = await stateStore.readFoxServiceState(dir);
  assert.deepEqual(original.state, core.emptyFoxServiceState());
  const state = {
    ...core.emptyFoxServiceState(),
    seededAt: "2026-11-08T00:00:00.000Z",
    daily: { date: "2026-11-08", count: 2 },
    seen: { k: "2026-11-08T00:00:00.000Z" },
    pending: [{
      key: "k", kind: "error", sessionId: "s", sessionName: "S", projectName: "p",
      detail: "boom", at: "2026-11-08T00:00:00.000Z", firstSeenAt: "2026-11-08T00:00:00.000Z", attempts: 1,
    }],
  };
  const saved = await stateStore.writeFoxServiceState(state, original.version, dir);
  const stored = await stateStore.readFoxServiceState(dir);
  assert.deepEqual(stored.state, { ...state, seen: {}, pending: [] });
  assert.equal(stored.version, saved.version);
  await assert.rejects(stateStore.writeFoxServiceState(state, original.version, dir), { code: "storage_conflict" });
});

test("strict observation parsing rejects unknown schema and invalid budget", () => {
  assert.throws(() => stateStore.parseFoxServiceState({ version: 99 }), /Invalid/);
  assert.throws(() => stateStore.parseFoxServiceState({ ...core.emptyFoxServiceState(), daily: { date: "2026-11-08", count: -1 } }), /Invalid/);
  assert.throws(() => stateStore.parseFoxServiceState({ ...core.emptyFoxServiceState(), seen: { key: 42 } }), /Invalid/);
});

test("config defaults, clamps, and rejects invalid times", (t) => {
  const dir = home(t);
  assert.deepEqual(configStore.readFoxServiceConfig(dir), configStore.DEFAULT_FOX_SERVICE_CONFIG);
  const written = configStore.writeFoxServiceConfig({
    enabled: true,
    quietStart: "25:00",
    quietEnd: "08:00",
    maxDailyMessages: 99,
  }, dir);
  assert.equal(written.enabled, true);
  assert.equal(written.quietStart, "22:00");
  assert.equal(written.quietEnd, "08:00");
  assert.equal(written.maxDailyMessages, 10);
  assert.deepEqual(configStore.readFoxServiceConfig(dir), written);
});

test("goal notification limits stay independent from observation turn limits", (t) => {
  const dir = home(t);
  const written = configStore.writeFoxServiceConfig({
    enabled: false, quietStart: "22:00", quietEnd: "08:00",
    maxDailyMessages: 2, maxDailyGoalNotifications: 7,
  }, dir);
  assert.equal(written.maxDailyMessages, 2);
  assert.equal(written.maxDailyGoalNotifications, 7);
  assert.equal(configStore.readFoxServiceConfig(dir).maxDailyGoalNotifications, 7);
  const invalid = configStore.normalizeFoxServiceConfig({ maxDailyGoalNotifications: -1, maxDailyMessages: 2 });
  assert.equal(invalid.maxDailyGoalNotifications, 1);
  assert.equal(invalid.maxDailyMessages, 2);
});

test("outstanding claims block competing observers even after lease expiry", async (t) => {
  const dir = home(t);
  const original = await stateStore.readFoxServiceState(dir);
  const request = { expectedVersion: original.version, wakeId: "wake-one", targetSessionId: "original-fox", eventKeys: ["event"], owner: "owner-one", now: 1, leaseMs: 1 };
  assert.equal((await stateStore.claimFoxObservation(request, dir)).claimed, true);
  const reserved = await stateStore.readFoxServiceState(dir);
  assert.equal(reserved.claim.targetSessionId, "original-fox");
  assert.equal((await stateStore.claimFoxObservation({ ...request, wakeId: "wake-two", owner: "owner-two", now: 99, expectedVersion: reserved.version }, dir)).claimed, false);
  await assert.rejects(stateStore.writeFoxServiceState(original.state, reserved.version, dir), { code: "storage_conflict" });
  await stateStore.settleFoxObservation({ wakeId: request.wakeId, owner: request.owner, outcome: "uncertain", state: { ...original.state, daily: { date: "2026-11-08", count: 1 } } }, dir);
  const uncertain = await stateStore.readFoxServiceState(dir);
  assert.equal(uncertain.claim.status, "uncertain");
  assert.equal(uncertain.claim.targetSessionId, "original-fox");
  assert.equal(uncertain.state.daily.count, 1);
  await stateStore.settleFoxObservation({ wakeId: request.wakeId, owner: request.owner, outcome: "delivered" }, dir);
  assert.equal((await stateStore.readFoxServiceState(dir)).claim, undefined);
});

