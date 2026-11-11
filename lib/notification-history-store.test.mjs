import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "fox-history-store-"));
const previous = process.env.PI_CODING_AGENT_DIR;
const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.PI_CODING_AGENT_DIR = root;
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const store = await jiti.import("./notification-history-store.ts");
const { closeStorage, storageRequest } = await jiti.import("./storage/client.ts");
after(async () => {
  await closeStorage();
  for (const [key, value] of Object.entries(previousHome)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
beforeEach(async () => store.clearHistory());
const event = (sessionId, type = "completed") => ({ type, sessionId, sessionName: sessionId });
test("reused notification tags replace read entries with newest unread occurrence", async () => {
  await store.recordHistory(event("s1"), { at: 1 });
  await store.markHistoryRead(["s1:completed"]);
  await store.recordHistory(event("s2"), { at: 2, read: true });
  await store.recordHistory(event("s1"), { at: 3 });
  assert.deepEqual((await store.listHistory()).map(({ id, at, read }) => ({ id, at, read })), [{ id: "s1:completed", at: 3, read: false }, { id: "s2:completed", at: 2, read: true }]);
  await closeStorage();
  assert.equal((await store.listHistory()).length, 2);
});
test("record and input settlement commit as one revision without affecting other dialogs", async () => {
  await store.recordHistory(event("s1", "input"));
  await store.recordHistory(event("s2", "input"));
  const before = await storageRequest({ operation: "head" });
  await store.recordHistory(event("s1"), { settleInputIds: ["s1:input"] });
  const after = await storageRequest({ operation: "head" });
  assert.equal(after.revision, before.revision + 1);
  const entries = await store.listHistory();
  assert.equal(entries.find(({ id }) => id === "s1:input").read, true);
  assert.equal(entries.find(({ id }) => id === "s2:input").read, false);
});
test("bounded history and targeted deletion preserve unrelated events", async () => {
  for (let n = 0; n < 105; n++) await store.recordHistory(event(`s${n}`), { at: n });
  const entries = await store.listHistory();
  assert.equal(entries.length, 100);
  assert.equal(entries.at(-1).id, "s5:completed");
  await store.removeHistory("s6:completed");
  assert.equal((await store.listHistory()).some(({ id }) => id === "s6:completed"), false);
  assert.equal((await store.listHistory()).length, 99);
  await store.clearHistory();
  assert.deepEqual(await store.listHistory(), []);
});
