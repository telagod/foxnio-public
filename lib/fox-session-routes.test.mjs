import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
