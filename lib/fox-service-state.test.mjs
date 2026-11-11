import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const core = await jiti.import("./fox-service-core.ts");
const stateStore = await jiti.import("./fox-service-state.ts");
const configStore = await jiti.import("./fox-service-config.ts");
const sessionStore = await jiti.import("./fox-session.ts");

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), "fox-control-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("durable state retains dedupe and budget, not a pending event ledger", (t) => {
  const dir = home(t);
  assert.deepEqual(stateStore.readFoxServiceState(dir), core.emptyFoxServiceState());
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
  stateStore.writeFoxServiceState(state, dir);
  assert.deepEqual(stateStore.readFoxServiceState(dir), { ...state, seen: {}, pending: [] });
  const stored = JSON.parse(readFileSync(stateStore.foxServiceStatePath(dir), "utf8"));
  assert.equal("pending" in stored, false);
  assert.doesNotMatch(JSON.stringify(stored), /boom/);
});

test("corrupt and unknown-version state fall back to empty", (t) => {
  const dir = home(t);
  const path = stateStore.foxServiceStatePath(dir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{not json");
  assert.deepEqual(stateStore.readFoxServiceState(dir), core.emptyFoxServiceState());
  writeFileSync(path, JSON.stringify({ version: 99, seededAt: "x" }));
  assert.deepEqual(stateStore.readFoxServiceState(dir), core.emptyFoxServiceState());
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

test("the FOX session pointer accepts only a valid id and fails closed on corrupt JSON", (t) => {
  const dir = home(t);
  assert.equal(sessionStore.readFoxSessionId(dir), null);
  assert.throws(() => sessionStore.writeFoxSessionId("../escape", dir), /Invalid/);
  sessionStore.writeFoxSessionId("01abcDEF_12345678", dir);
  assert.equal(sessionStore.readFoxSessionId(dir), "01abcDEF_12345678");
  writeFileSync(sessionStore.foxSessionRecordPath(dir), JSON.stringify({ sessionId: 42 }));
  assert.throws(() => sessionStore.readFoxSessionId(dir), /Invalid FOX session record/);
  assert.match(readFileSync(sessionStore.foxSessionRecordPath(dir), "utf8"), /42/);
});

test("clearing a FOX session persists a reset epoch and revokes the old id", (t) => {
  const dir = home(t);
  sessionStore.writeFoxSessionId("01abcDEF_12345678", dir);
  const reset = sessionStore.clearFoxSessionId(dir);
  assert.equal(reset.sessionId, null);
  assert.ok(reset.resetAt);
  assert.equal(reset.revokedSessionId, "01abcDEF_12345678");
  assert.equal(sessionStore.readFoxSessionId(dir), null);

  sessionStore.writeFoxSessionId("01newSession_87654321", dir);
  const record = sessionStore.readFoxSessionRecord(dir);
  assert.equal(record.sessionId, "01newSession_87654321");
  assert.equal(record.resetAt, reset.resetAt);
  assert.equal(record.revokedSessionId, "01abcDEF_12345678");
});
