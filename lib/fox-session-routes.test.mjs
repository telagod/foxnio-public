import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { nativeEnvironment } from "../tests/omp-native-env.mjs";

const root = mkdtempSync(join(tmpdir(), "fox-session-api-"));
Object.assign(process.env, nativeEnvironment(root, join(root, "agent")));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const workspace = await jiti.import("./fox-workspace.ts");
const pointer = await jiti.import("./fox-session.ts");
const reader = await jiti.import("./session-reader.ts");
const api = await jiti.import("../app/api/fox/session/route.ts");
const resetApi = await jiti.import("../app/api/fox/session/reset/route.ts");
const cwd = workspace.ensureFoxWorkspace();
const { getSessionsDir } = await jiti.import("./omp/paths.ts");
globalThis.__ompSessions ??= new Map();
test.after(() => {
  globalThis.__ompNotificationStore?.db.close();
  rmSync(root, { recursive: true, force: true });
});

function request(body) {
  return new Request("http://localhost/api/fox/session", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

function live(id) {
  globalThis.__ompSessions.set(id, { sessionId: id, cwd, createdAt: Date.now() + 1000, isAlive: () => true });
}

test("the first unpersisted FOX can register from its verified live runtime", async () => {
  const record = pointer.clearFoxSessionId();
  const sessionId = "fresh-fox-runtime";
  live(sessionId);
  const result = await api.POST(request({ sessionId, expectedSessionId: null, resetAt: record.resetAt }));
  assert.equal(result.status, 200);
  assert.equal(pointer.readFoxSessionId(), sessionId);
});

test("a reset overtaking asynchronous session validation cannot be undone by a late POST", async () => {
  const record = pointer.clearFoxSessionId();
  let reset;
  const sessionId = "late-fox-runtime";
  live(sessionId);
  const result = await api.POST({ json: async () => ({
    sessionId, expectedSessionId: null,
    get resetAt() {
      queueMicrotask(() => { reset = pointer.clearFoxSessionId(); });
      return record.resetAt;
    },
  }) });
  assert.equal(result.status, 409);
  assert.deepEqual(pointer.readFoxSessionRecord(), reset);
});

test("refreshing an old transcript cannot make its creation date newer than reset", async () => {
  const record = pointer.clearFoxSessionId();
  const sessionId = "old-fox-session";
  const file = join(root, `${sessionId}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: "session", id: sessionId, cwd, timestamp: "2020-01-01T00:00:00.000Z" }) + "\n");
  reader.cacheSessionPath(sessionId, file);
  const result = await api.POST(request({ sessionId, expectedSessionId: null, resetAt: record.resetAt }));
  assert.equal(result.status, 409);
  assert.equal(pointer.readFoxSessionId(), null);
});

test("a delayed reset cannot erase a conversation registered after its snapshot", async () => {
  const before = pointer.clearFoxSessionId();
  pointer.writeFoxSessionId("newer-fox-session");
  const result = await resetApi.POST(request({ sessionId: before.sessionId, resetAt: before.resetAt }));
  assert.equal(result.status, 409);
  assert.equal(pointer.readFoxSessionId(), "newer-fox-session");
});

test("reset returns the new epoch and rejects registrations with the previous epoch", async () => {
  const before = pointer.readFoxSessionRecord();
  const result = await resetApi.POST(request({ sessionId: before.sessionId, resetAt: before.resetAt }));
  assert.equal(result.status, 200);
  const after = await result.json();
  assert.equal(after.sessionId, null);
  assert.ok(after.resetAt > before.resetAt);
  live("stale-client-fox");
  assert.equal((await api.POST(request({ sessionId: "stale-client-fox", expectedSessionId: null, resetAt: before.resetAt }))).status, 409);
});

test("a missing pointer with surviving native continuation cannot be reset without revocation", async () => {
  const dir = join(getSessionsDir(), "fox-reset-proof");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "continued.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "continued-fox", cwd, continuationOf: "missing-fox-source", parentSession: "missing-fox-source", timestamp: new Date().toISOString() }) + "\n");
  pointer.writeFoxSessionId("missing-fox-source");
  const before = pointer.readFoxSessionRecord();
  const result = await resetApi.POST(request({ sessionId: before.sessionId, resetAt: before.resetAt }));
  assert.equal(result.status, 503);
  assert.deepEqual(pointer.readFoxSessionRecord(), before);
  rmSync(dir, { recursive: true, force: true });
  reader.invalidateSessionListCache();
});

test("malformed native inventory prevents a stale-pointer absence proof", async () => {
  const dir = join(getSessionsDir(), "fox-damaged-proof");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "unknown.jsonl"), "damaged header\n");
  pointer.writeFoxSessionId("missing-damaged-fox");
  const before = pointer.readFoxSessionRecord();
  const result = await resetApi.POST(request({ sessionId: before.sessionId, resetAt: before.resetAt }));
  assert.equal(result.status, 503);
  assert.deepEqual(pointer.readFoxSessionRecord(), before);
  rmSync(dir, { recursive: true, force: true });
  reader.invalidateSessionListCache();
});

test("a complete persisted legacy conversation can reset without spawning an unsupported goal runtime", async () => {
  const file = join(root, "legacy-reset.jsonl");
  const sessionId = "legacy-reset-session";
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd, timestamp: new Date().toISOString() }) + "\n");
  reader.cacheSessionPath(sessionId, file);
  pointer.writeFoxSessionId(sessionId);
  const before = pointer.readFoxSessionRecord();
  const result = await resetApi.POST(request({ sessionId, resetAt: before.resetAt }));
  assert.equal(result.status, 200);
  assert.equal(pointer.readFoxSessionId(), null);
});

test("persisted goal authority is not cleared when native revocation is unavailable", async () => {
  const file = join(root, "authority-reset.jsonl");
  const sessionId = "authority-reset-session";
  writeFileSync(file, [
    { type: "session", version: 3, id: sessionId, cwd, timestamp: new Date().toISOString() },
    { type: "custom", id: "authority", parentId: null, customType: "fox-goal", data: { version: 1, op: "consent", sessionId } },
  ].map(JSON.stringify).join("\n") + "\n");
  reader.cacheSessionPath(sessionId, file);
  pointer.writeFoxSessionId(sessionId);
  globalThis.__ompSessions.set(sessionId, {
    sessionId, sessionFile: file, cwd, isAlive: () => true,
    closeFoxGoalAdmission() {}, waitFoxGoalEffects: async () => {},
    getFoxGoalSnapshot: async () => { throw new Error("Native revocation unavailable"); },
  });
  const before = pointer.readFoxSessionRecord();
  const result = await resetApi.POST(request({ sessionId, resetAt: before.resetAt }));
  assert.equal(result.status, 503);
  assert.deepEqual(pointer.readFoxSessionRecord(), before);
  globalThis.__ompSessions.delete(sessionId);
});
