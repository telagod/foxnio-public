import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const sessions = await jiti.import("./fox-session.ts");
const { closeStorage } = await jiti.import("./storage/client.ts");
function homeFor(t) {
  const home = mkdtempSync(join(tmpdir(), "fox-session-race-"));
  t.after(async () => { await closeStorage(); rmSync(home, { recursive: true, force: true }); });
  return home;
}
test("a delayed registration cannot revive the coordinator after reset", async (t) => {
  const home = homeFor(t);
  await sessions.writeFoxSessionId("original-fox", home);
  const before = await sessions.readFoxSessionRecord(home);
  const reset = await sessions.clearFoxSessionId(home, before);
  assert.equal(await sessions.compareAndSetFoxSessionId("original-fox", before, home), null);
  assert.deepEqual(await sessions.readFoxSessionRecord(home), reset);
});
test("concurrent first registrations cannot overwrite the winner", async (t) => {
  const home = homeFor(t);
  const before = await sessions.readFoxSessionRecord(home);
  const results = await Promise.all([sessions.compareAndSetFoxSessionId("first-fox", before, home), sessions.compareAndSetFoxSessionId("second-fox", before, home)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.deepEqual(await sessions.readFoxSessionRecord(home), results.find(Boolean));
});
test("a stale reset rejects without erasing a newly registered conversation", async (t) => {
  const home = homeFor(t);
  const before = await sessions.readFoxSessionRecord(home);
  await sessions.writeFoxSessionId("newer-fox", home);
  await assert.rejects(sessions.clearFoxSessionId(home, before), { code: "storage_conflict" });
  assert.equal(await sessions.readFoxSessionId(home), "newer-fox");
});
test("successive resets have distinct epochs and retain the revoked id", async (t) => {
  const home = homeFor(t);
  await sessions.writeFoxSessionId("original-fox", home);
  const first = await sessions.clearFoxSessionId(home);
  const second = await sessions.clearFoxSessionId(home);
  assert.ok(second.resetAt > first.resetAt);
  assert.equal(second.revokedSessionId, "original-fox");
  assert.equal(await sessions.compareAndSetFoxSessionId("stale-fox", first, home), null);
});
test("invalid pointer ids reject without changing stored authority", async (t) => {
  const home = homeFor(t);
  await sessions.writeFoxSessionId("original-fox", home);
  await assert.rejects(sessions.writeFoxSessionId(12345678, home), /Invalid/);
  await assert.rejects(sessions.writeFoxSessionId("../escape", home), /Invalid/);
  assert.equal(await sessions.readFoxSessionId(home), "original-fox");
});
