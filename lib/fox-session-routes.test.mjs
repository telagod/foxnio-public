import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { nativeEnvironment } from "../tests/omp-native-env.mjs";

const root = mkdtempSync(join(tmpdir(), "fox-session-api-"));
const environment = nativeEnvironment(root, join(root, "agent"));
const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
Object.assign(process.env, environment);
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const workspace = await jiti.import("./fox-workspace.ts");
const pointer = await jiti.import("./fox-session.ts");
const reader = await jiti.import("./session-reader.ts");
const api = await jiti.import("../app/api/fox/session/route.ts");
const resetApi = await jiti.import("../app/api/fox/session/reset/route.ts");
const cwd = workspace.ensureFoxWorkspace();
const { getSessionsDir } = await jiti.import("./omp/paths.ts");
const { closeStorage } = await jiti.import("./storage/client.ts");
const { ensureSessionIndex, stopSessionIndex } = await jiti.import("./session-index.ts");
const { drainNotificationWrites } = await jiti.import("./notification-hub.ts");
const sessionDir = join(getSessionsDir(), "fox-session-routes");
mkdirSync(sessionDir, { recursive: true });
test.beforeEach((t) => {
  const previousSessions = globalThis.__ompSessions;
  globalThis.__ompSessions = new Map();
  t.after(() => { globalThis.__ompSessions = previousSessions; });
});
test.after(async () => {
  await drainNotificationWrites();
  await stopSessionIndex();
  await closeStorage();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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
  const record = await pointer.clearFoxSessionId();
  const sessionId = "fresh-fox-runtime";
  live(sessionId);
  const result = await api.POST(request({ sessionId, expectedSessionId: null, resetAt: record.resetAt }));
  assert.equal(result.status, 200);
  assert.equal(await pointer.readFoxSessionId(), sessionId);
});

test("a reset overtaking asynchronous session validation cannot be undone by a late POST", async () => {
  const record = await pointer.clearFoxSessionId();
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
  assert.deepEqual(await pointer.readFoxSessionRecord(), await reset);
});

test("refreshing an old transcript cannot make its creation date newer than reset", async () => {
  const record = await pointer.clearFoxSessionId();
  const sessionId = "old-fox-session";
  const file = join(sessionDir, `${sessionId}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd, timestamp: "2020-01-01T00:00:00.000Z" }) + "\n");
  reader.invalidateSessionListCache();
  await ensureSessionIndex();
  const result = await api.POST(request({ sessionId, expectedSessionId: null, resetAt: record.resetAt }));
  assert.equal(result.status, 409);
  assert.equal(await pointer.readFoxSessionId(), null);
});

test("a delayed reset cannot erase a conversation registered after its snapshot", async () => {
  const before = await pointer.clearFoxSessionId();
  await pointer.writeFoxSessionId("newer-fox-session");
  const result = await resetApi.POST(request({ sessionId: before.sessionId, resetAt: before.resetAt }));
  assert.equal(result.status, 409);
  assert.equal(await pointer.readFoxSessionId(), "newer-fox-session");
});

test("reset returns the new epoch and rejects registrations with the previous epoch", async () => {
  await pointer.writeFoxSessionId("missing-fox-session");
  const before = await pointer.readFoxSessionRecord();
  const result = await resetApi.POST(request({ sessionId: before.sessionId, resetAt: before.resetAt }));
  assert.equal(result.status, 200);
  const after = await result.json();
  assert.equal(after.sessionId, null);
  assert.ok(after.resetAt > before.resetAt);
  live("stale-client-fox");
  assert.equal((await api.POST(request({ sessionId: "stale-client-fox", expectedSessionId: null, resetAt: before.resetAt }))).status, 409);
});

test("a missing pointer with surviving native continuation cannot be reset without revocation", async (t) => {
  const dir = join(getSessionsDir(), "fox-reset-proof");
  mkdirSync(dir, { recursive: true });
  t.after(async () => {
    await drainNotificationWrites();
    await stopSessionIndex();
    await closeStorage();
    rmSync(dir, { recursive: true, force: true });
    reader.invalidateSessionListCache();
  });
  const file = join(dir, "continued.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "continued-fox", cwd, continuationOf: "missing-fox-source", parentSession: "missing-fox-source", timestamp: new Date().toISOString() }) + "\n");
  reader.invalidateSessionListCache();
  await pointer.writeFoxSessionId("missing-fox-source");
  const before = await pointer.readFoxSessionRecord();
  const result = await resetApi.POST(request({ sessionId: before.sessionId, resetAt: before.resetAt }));
  assert.equal(result.status, 503);
  assert.deepEqual(await pointer.readFoxSessionRecord(), before);
});

test("malformed native inventory prevents a stale-pointer absence proof", async (t) => {
  const dir = join(getSessionsDir(), "fox-damaged-proof");
  mkdirSync(dir, { recursive: true });
  t.after(async () => {
    await drainNotificationWrites();
    await stopSessionIndex();
    await closeStorage();
    rmSync(dir, { recursive: true, force: true });
    reader.invalidateSessionListCache();
  });
  writeFileSync(join(dir, "unknown.jsonl"), "damaged header\n");
  reader.invalidateSessionListCache();
  await pointer.writeFoxSessionId("missing-damaged-fox");
  const before = await pointer.readFoxSessionRecord();
  const result = await resetApi.POST(request({ sessionId: before.sessionId, resetAt: before.resetAt }));
  assert.equal(result.status, 503);
  assert.deepEqual(await pointer.readFoxSessionRecord(), before);
});

test("a complete persisted legacy conversation can reset without spawning an unsupported goal runtime", async () => {
  const file = join(sessionDir, "legacy-reset.jsonl");
  const sessionId = "legacy-reset-session";
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: sessionId, cwd, timestamp: new Date().toISOString() }) + "\n");
  reader.invalidateSessionListCache();
  await pointer.writeFoxSessionId(sessionId);
  const before = await pointer.readFoxSessionRecord();
  const result = await resetApi.POST(request({ sessionId, resetAt: before.resetAt }));
  assert.equal(result.status, 200);
  assert.equal(await pointer.readFoxSessionId(), null);
});

test("persisted goal authority is not cleared when native revocation is unavailable", async () => {
  const file = join(sessionDir, "authority-reset.jsonl");
  const sessionId = "authority-reset-session";
  writeFileSync(file, [
    { type: "session", version: 3, id: sessionId, cwd, timestamp: new Date().toISOString() },
    { type: "custom", id: "authority", parentId: null, customType: "fox-goal", data: { version: 1, op: "consent", sessionId } },
  ].map(JSON.stringify).join("\n") + "\n");
  reader.invalidateSessionListCache();
  await pointer.writeFoxSessionId(sessionId);
  globalThis.__ompSessions.set(sessionId, {
    sessionId, sessionFile: file, cwd, isAlive: () => true,
    closeFoxGoalAdmission() {}, waitFoxGoalEffects: async () => {},
    getFoxGoalSnapshot: async () => { throw new Error("Native revocation unavailable"); },
  });
  const before = await pointer.readFoxSessionRecord();
  const result = await resetApi.POST(request({ sessionId, resetAt: before.resetAt }));
  assert.equal(result.status, 503);
  assert.deepEqual(await pointer.readFoxSessionRecord(), before);
  globalThis.__ompSessions.delete(sessionId);
});
