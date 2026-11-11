import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const index = await jiti.import("./session-index.ts");
const { storageRequest, closeStorage } = await jiti.import("./storage/client.ts");
const reader = await jiti.import("./session-reader.ts");
async function isolated(t, run) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "fox-session-index-")));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const previousHome = process.env.HOME;
  const previousPackage = process.env.OMP_WEB_PACKAGE_DIR;
  process.env.OMP_WEB_PACKAGE_DIR = fileURLToPath(new URL("../", import.meta.url));
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = root;
  const dir = join(root, "sessions", "project");
  mkdirSync(dir, { recursive: true });
  try { await run(dir); }
  finally {
    await index.stopSessionIndex();
    await closeStorage();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousPackage === undefined) delete process.env.OMP_WEB_PACKAGE_DIR;
    else process.env.OMP_WEB_PACKAGE_DIR = previousPackage;
    rmSync(root, { force: true, recursive: true });
  }
}
function session(dir, id, title = id) {
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: "session", id, cwd: join(dir, "missing"), timestamp: "2026-01-01T00:00:00.000Z", title }) + "\n");
  return file;
}

test("coalesced invalidation during initial ingestion settles before list readers publish", async (t) => isolated(t, async dir => {
  const file = session(dir, "a", "before");
  for (let i = 0; i < 130; i++) session(dir, `filler-${i}`);
  const first = index.ensureSessionIndex();
  session(dir, "a", "after");
  for (let i = 0; i < 20; i++) index.invalidateSessionIndex([file]);
  await first;
  const selected = await reader.listSessionsByIds(["a", "missing", "a"]);
  assert.equal(selected.sessions[0].name, "after");
  assert.deepEqual(selected.missing, ["missing"]);
  assert.equal((await reader.listAllSessions()).length, 131);
}));

test("worker ingestion leaves main event loop responsive and durable snapshot includes every page", async (t) => isolated(t, async dir => {
  for (let i = 0; i < 510; i++) session(dir, `session-${i}`);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  try { await index.ensureSessionIndex(); } finally { clearInterval(timer); }
  assert.ok(ticks > 0, "synchronous scanning must never move onto the HTTP thread");
  const snapshot = await index.readDurableSnapshot();
  assert.equal(snapshot.data.sessions.length, 510);
  assert.equal(snapshot.complete, true);
  assert.ok(snapshot.data.sessions.every(row => !("running" in row) && !("pendingInput" in row)));
  // Completed helpers release all four pinned-reader slots rather than relying on TTL.
  const snapshots = await Promise.all(Array.from({ length: 4 }, () => storageRequest({ operation: "snapshot.open" })));
  await Promise.all(snapshots.map(value => storageRequest({ operation: "snapshot.close", token: value.token })));
}));

test("index rows and cached paths cannot authorize a deleted or identity-replaced native source", async (t) => isolated(t, async dir => {
  const file = session(dir, "native");
  await index.ensureSessionIndex();
  assert.equal(await reader.resolveSessionPath("native"), file);
  session(dir, "native", "same filename");
  writeFileSync(file, JSON.stringify({ type: "session", id: "impostor", cwd: dir }) + "\n");
  assert.equal(await reader.resolveSessionPath("native"), null);
  rmSync(file);
  assert.equal(await reader.resolveSessionPath("native"), null);
}));

test("alias-root candidates keep native containment and identity checks", async (t) => isolated(t, async dir => {
  const root = process.env.PI_CODING_AGENT_DIR;
  const alias = join(root, "agent-alias");
  symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
  process.env.PI_CODING_AGENT_DIR = alias;
  const file = session(dir, "alias-native");
  const aliasFile = join(alias, "sessions", "project", "alias-native.jsonl");
  reader.cacheSessionPath("alias-native", aliasFile);
  assert.equal(await reader.resolveSessionPath("alias-native"), file);
  assert.equal(await reader.resolveSessionIdByPath(aliasFile), "alias-native");
  writeFileSync(file, JSON.stringify({ type: "session", id: "replaced", cwd: dir }) + "\n");
  assert.equal(await reader.resolveSessionPath("alias-native"), null);
  const outside = join(root, "outside");
  mkdirSync(outside);
  session(outside, "escaped");
  const escape = join(dir, "..", "escape");
  symlinkSync(outside, escape, process.platform === "win32" ? "junction" : "dir");
  reader.cacheSessionPath("escaped", join(alias, "sessions", "escape", "escaped.jsonl"));
  assert.equal(await reader.resolveSessionPath("escaped"), null);
  assert.equal(await reader.resolveSessionCandidate("escaped"), null);
}));

test("server watcher continues ingesting after the last browser listener leaves", { timeout: 20_000 }, async (t) => isolated(t, async dir => {
  const file = session(dir, "watched");
  const stop = await index.startSessionIndex();
  const { subscribeSessionFileChanges } = await jiti.import("./session-watcher.ts");
  const unsubscribe = subscribeSessionFileChanges(() => {});
  unsubscribe();
  appendFileSync(file, JSON.stringify({ type: "message", id: "u", timestamp: "2026-02-01T00:00:00.000Z", message: { role: "user", content: "without browser" } }) + "\n");
  while ((await storageRequest({ operation: "index.get", ids: ["watched"] })).sessions[0]?.firstMessage !== "without browser") {
    await new Promise(resolve => setTimeout(resolve, 50));
    t.signal.throwIfAborted();
  }
  stop();
}));

test("read-only history candidates preserve malformed diagnostics without authorizing resume", async (t) => isolated(t, async dir => {
  const file = session(dir, "diagnostic");
  await index.ensureSessionIndex();
  reader.cacheSessionPath("diagnostic", file);
  writeFileSync(file, "malformed native source\n");
  assert.equal(await reader.resolveSessionCandidate("diagnostic"), file);
  assert.equal(await reader.resolveSessionPath("diagnostic"), null);
  writeFileSync(file, JSON.stringify({ type: "session", id: "someone-else", cwd: dir }) + "\n");
  assert.equal(await reader.resolveSessionCandidate("diagnostic"), null);
  assert.equal(await reader.resolveSessionPath("diagnostic"), null);
}));

test("a poisoned projection cannot turn an outside-root native header into an execution candidate", async (t) => isolated(t, async dir => {
  await index.ensureSessionIndex();
  const outside = join(process.env.PI_CODING_AGENT_DIR, "outside.jsonl");
  writeFileSync(outside, JSON.stringify({ type: "session", id: "poison", cwd: dir }) + "\n");
  await storageRequest({ operation: "index.apply", updates: [{ path: outside, stamp: "poisoned", session: {
    id: "poison", path: outside, cwd: dir, created: "2026-01-01T00:00:00.000Z", modified: "2026-01-01T00:00:00.000Z", messageCount: 0, firstMessage: "(no messages)",
  } }] });
  assert.equal(await reader.resolveSessionPath("poison"), null);
  assert.equal(await reader.resolveSessionCandidate("poison"), null);
}));

test("bounded index batches admit application commands and repeated inventories do not revise unchanged data", async (t) => isolated(t, async dir => {
  for (let i = 0; i < 130; i++) session(dir, `bounded-${i}`);
  let scanToken;
  let batches = 0;
  do {
    const batch = await storageRequest({ operation: "index.scan", ...(scanToken ? { scanToken } : {}) });
    scanToken = batch.nextScanToken;
    batches++;
    const pointer = await storageRequest({ operation: "foxPointer.get" });
    assert.equal(pointer.sessionId, null);
    assert.ok(batch.updates.length <= 64);
  } while (scanToken);
  assert.ok(batches > 2);
  const before = await storageRequest({ operation: "head" });
  await index.ensureSessionIndex();
  const after = await storageRequest({ operation: "head" });
  assert.deepEqual(after, before, "restart reconciliation reuses persisted source versions without metadata churn");
}));
