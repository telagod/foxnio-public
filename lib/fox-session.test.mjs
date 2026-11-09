import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const sessions = await jiti.import("./fox-session.ts");

function homeFor(t) {
  const home = mkdtempSync(join(tmpdir(), "fox-session-race-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test("a delayed registration cannot revive the coordinator after reset", (t) => {
  const home = homeFor(t);
  sessions.writeFoxSessionId("original-fox", home);
  const before = sessions.readFoxSessionRecord(home);
  const reset = sessions.clearFoxSessionId(home);
  assert.equal(sessions.compareAndSetFoxSessionId("original-fox", before, home), null);
  assert.deepEqual(sessions.readFoxSessionRecord(home), reset);
  assert.equal(statSync(sessions.foxSessionRecordPath(home)).mode & 0o777, 0o600);
});

test("a competing first registration cannot overwrite the winner", (t) => {
  const home = homeFor(t);
  const before = sessions.readFoxSessionRecord(home);
  const first = sessions.compareAndSetFoxSessionId("first-fox", before, home);
  assert.ok(first);
  assert.equal(sessions.compareAndSetFoxSessionId("second-fox", before, home), null);
  assert.equal(sessions.readFoxSessionRecord(home).sessionId, "first-fox");
  assert.ok(sessions.compareAndSetFoxSessionId("moved-fox", first, home));
});

test("successive resets have distinct epochs even within one clock tick", (t) => {
  const home = homeFor(t);
  t.mock.method(Date, "now", () => 1794140000000);
  const first = sessions.clearFoxSessionId(home);
  const second = sessions.clearFoxSessionId(home);
  assert.ok(second.resetAt > first.resetAt);
  assert.equal(sessions.compareAndSetFoxSessionId("stale-fox", first, home), null);
});

test("an unreadable or corrupt pointer is not treated as permission to create or adopt another FOX", (t) => {
  const home = homeFor(t);
  sessions.writeFoxSessionId("original-fox", home);
  writeFileSync(sessions.foxSessionRecordPath(home), "{broken");
  assert.throws(() => sessions.readFoxSessionRecord(home));
  assert.throws(() => sessions.clearFoxSessionId(home));
  assert.throws(() => sessions.writeFoxSessionId("another-fox", home));
});
