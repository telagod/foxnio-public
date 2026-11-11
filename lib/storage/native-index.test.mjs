import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync, realpathSync, statSync, symlinkSync, utimesSync, appendFileSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { scanNativeIndexBatch } = await jiti.import("./native-index.ts");
const { serializeTitleSlot } = await jiti.import("../omp/session-files.ts");

function fixture(t) {
  const agentDir = realpathSync.native(mkdtempSync(join(tmpdir(), "fox-native-index-")));
  const roots = { agentDir, sessionsDir: join(agentDir, "sessions"), foxDir: join(agentDir, "fox") };
  const dir = join(roots.sessionsDir, "project");
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  return { roots, dir, sources: new Map() };
}
function session(dir, id, extra = {}, entries = []) {
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, [JSON.stringify({ type: "session", version: 3, id, cwd: join(dir, "missing"), timestamp: "2026-01-01T00:00:00.000Z", ...extra }), ...entries.map(JSON.stringify)].join("\n") + "\n");
  return file;
}
function apply(f, result) {
  for (const update of result.updates) {
    const old = f.sources.get(update.path);
    f.sources.set(update.path, { path: update.path, stamp: update.stamp, payload: update.session ?? old?.payload, ...(update.error ? { error: update.error } : {}) });
  }
  for (const path of result.removedPaths ?? []) f.sources.delete(path);
}
async function scan(f, request = {}, projects = [], scanBatch = scanNativeIndexBatch) {
  const batches = [];
  do {
    const result = await scanBatch(request, f.roots, projects, [...f.sources.values()]);
    assert.ok(result.updates.length <= 64, "a worker command must leave room for application commands");
    apply(f, result);
    batches.push(result);
    request = { scanToken: result.nextScanToken };
  } while (request.scanToken);
  return batches;
}

test("preserves title-slot, first-user, tail-time and fork path/id semantics across batches", async (t) => {
  const f = fixture(t);
  const parent = session(f.dir, "zz-parent");
  session(f.dir, "a-child", { parentSession: parent });
  session(f.dir, "b-child", { parentSession: "zz-parent" });
  session(f.dir, "c-orphan", { parentSession: "absent" });
  for (let i = 0; i < 70; i++) session(f.dir, `filler-${i}`);
  const file = session(f.dir, "titled", {}, [
    { type: "custom_message", content: "x".repeat(20_000), display: false },
    { type: "message", id: "u", timestamp: "2026-01-02T00:00:00.000Z", message: { role: "user", content: "real first prompt" } },
    { type: "title_change", timestamp: "2026-03-01T00:00:00.000Z", title: "ignored tail title" },
  ]);
  const body = fs.readFileSync(file, "utf8");
  writeFileSync(file, serializeTitleSlot({ title: "slot title", updatedAt: "2026-01-01T00:00:00.000Z" }) + body);
  const batches = await scan(f);
  assert.ok(batches.length > 1);
  assert.equal(batches.at(-1).complete, true);
  const byId = new Map([...f.sources.values()].map(s => [s.payload.id, s.payload]));
  assert.equal(byId.get("a-child").parentSessionId, "zz-parent");
  assert.equal(byId.get("b-child").parentSessionId, "zz-parent");
  assert.equal(byId.get("c-orphan").parentSessionId, undefined);
  assert.equal(byId.get("titled").name, "slot title");
  assert.equal(byId.get("titled").firstMessage, "real first prompt");
  assert.equal(byId.get("titled").lastMessageAt, "2026-01-02T00:00:00.000Z");
});

test("an aliased inventory root publishes only canonical source identities", async (t) => {
  const f = fixture(t);
  const alias = join(f.roots.agentDir, "sessions-alias");
  symlinkSync(f.roots.sessionsDir, alias, process.platform === "win32" ? "junction" : "dir");
  const file = session(f.dir, "canonical");
  f.roots.sessionsDir = alias;
  const batches = await scan(f);
  assert.equal(batches.at(-1).complete, true);
  assert.deepEqual([...f.sources.keys()], [file]);
  assert.equal(f.sources.get(file).payload.path, file);
});

test("canonical sources retain parent links written through a native-root alias", async (t) => {
  const f = fixture(t);
  const alias = join(f.roots.agentDir, "sessions-alias");
  symlinkSync(f.roots.sessionsDir, alias, process.platform === "win32" ? "junction" : "dir");
  const parent = session(f.dir, "parent");
  const child = session(f.dir, "child", { parentSession: join(alias, "project", "parent.jsonl") });
  const batches = await scan(f);
  assert.equal(batches.at(-1).complete, true);
  assert.equal(f.sources.get(child).payload.parentSessionId, "parent");
  assert.equal(f.sources.get(parent).payload.path, parent);
  assert.equal(f.sources.size, 2);
});

test("targeted alias writes update one canonical source and preserve deletion diagnostics", async (t) => {
  const f = fixture(t);
  const alias = join(f.roots.agentDir, "sessions-alias");
  symlinkSync(f.roots.sessionsDir, alias, process.platform === "win32" ? "junction" : "dir");
  const file = session(f.dir, "renamed", { title: "first" });
  const aliasFile = join(alias, "project", "renamed.jsonl");
  await scan(f);
  const before = statSync(file);
  session(f.dir, "renamed", { title: "other" });
  utimesSync(file, before.atime, before.mtime);
  const changed = await scan(f, { paths: [aliasFile, file], force: true });
  assert.equal(changed.at(-1).complete, true);
  assert.equal(f.sources.get(file).payload.name, "other");
  assert.equal(f.sources.size, 1, "an alias must never create a second source row");
  assert.deepEqual(changed.flatMap(batch => batch.updates).map(update => update.path), [file]);
  rmSync(file);
  const missing = await scan(f, { paths: [aliasFile], force: true });
  assert.equal(missing.at(-1).complete, false);
  assert.deepEqual(missing.at(-1).staleSources, [file]);
  assert.equal(f.sources.get(file).payload.name, "other", "a missing targeted source is not deletion proof");
  await scan(f);
  assert.equal(f.sources.size, 0);
});

test("targeted paths through a native-root link cannot ingest an outside source", async (t) => {
  const f = fixture(t);
  const outside = join(f.roots.agentDir, "outside");
  mkdirSync(outside);
  session(outside, "outside");
  const escape = join(f.roots.sessionsDir, "escape");
  symlinkSync(outside, escape, process.platform === "win32" ? "junction" : "dir");
  const batches = await scan(f, { paths: [join(escape, "outside.jsonl")], force: true });
  assert.equal(f.sources.size, 0);
  assert.deepEqual(batches.flatMap(batch => batch.updates), []);
});

test("retains malformed sources and removes missing rows only after complete inventory", async (t) => {
  const f = fixture(t);
  const retained = session(f.dir, "retained");
  const deleted = session(f.dir, "deleted");
  await scan(f);
  writeFileSync(retained, "malformed\n");
  rmSync(deleted);
  const targeted = await scan(f, { paths: [retained, deleted], force: true });
  assert.equal(f.sources.get(retained).payload.id, "retained");
  assert.ok(f.sources.has(deleted), "a failed stat is not deletion proof");
  assert.equal(targeted.at(-1).complete, false);
  const full = await scan(f);
  assert.equal(f.sources.has(deleted), false);
  assert.equal(f.sources.get(retained).payload.id, "retained");
  assert.ok(full.at(-1).staleSources.includes(retained));
});

test("a failed directory inventory cannot delete previously indexed sessions", async (t) => {
  const f = fixture(t);
  const file = session(f.dir, "retained");
  await scan(f);
  renameSync(f.roots.sessionsDir, `${f.roots.sessionsDir}-saved`);
  writeFileSync(f.roots.sessionsDir, "not a directory");
  const results = await scan(f);
  assert.equal(results.at(-1).complete, false);
  assert.ok(f.sources.has(file));
  assert.deepEqual(results.flatMap(r => r.removedPaths ?? []), []);
});

test("force invalidation reads equal-stamp rewrites instead of trusting persisted payload", async (t) => {
  const f = fixture(t);
  const file = session(f.dir, "same", { title: "first" });
  await scan(f);
  const before = statSync(file);
  const nativeStat = fs.statSync;
  session(f.dir, "same", { title: "other" });
  utimesSync(file, before.atime, before.mtime);
  const mock = t.mock.method(fs, "statSync", (path, ...args) => path === file ? before : nativeStat(path, ...args));
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const isolated = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
  const { scanNativeIndexBatch: scanBatch } = await isolated.import("./native-index.ts");
  await scan(f, { paths: [file] }, [], scanBatch);
  assert.equal(f.sources.get(file).payload.name, "first", "positive control: the equal physical stamp preserves the old projection without force");
  await scan(f, { paths: [file], force: true }, [], scanBatch);
  assert.equal(f.sources.get(file).payload.name, "other");
});

test("a file that changes between before/after versions retains its last successful payload", async (t) => {
  const f = fixture(t);
  const file = session(f.dir, "changing", { title: "before" });
  await scan(f);
  const nativeStat = fs.statSync;
  let reads = 0;
  const mock = t.mock.method(fs, "statSync", (path, ...args) => {
    if (path === file && ++reads === 2) appendFileSync(file, "\n");
    return nativeStat(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const isolated = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
  const { scanNativeIndexBatch: scanBatch } = await isolated.import("./native-index.ts");
  const results = await scan(f, { paths: [file], force: true }, [], scanBatch);
  assert.ok(reads >= 2, "positive control: the real file changed during scanner version checks");
  assert.equal(f.sources.get(file).payload.name, "before");
  assert.ok(results.at(-1).staleSources.includes(file));
});

test("worker-safe project resolution groups live and removed worktrees without grouping repo subdirectories", async (t) => {
  const f = fixture(t);
  const repo = join(f.roots.agentDir, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", repo]);
  execFileSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
  const worktree = join(`${repo}-worktrees`, "feature");
  execFileSync("git", ["-C", repo, "worktree", "add", "-b", "feature", worktree]);
  const sub = join(repo, "sub");
  mkdirSync(sub);
  session(f.dir, "live", { cwd: worktree });
  session(f.dir, "sub", { cwd: sub });
  session(f.dir, "removed", { cwd: join(`${repo}-worktrees`, "removed") });
  await scan(f, {}, [{ path: repo }]);
  const byId = new Map([...f.sources.values()].map(s => [s.payload.id, s.payload]));
  assert.equal(byId.get("live").projectRoot, fs.realpathSync.native(repo));
  assert.equal(byId.get("live").worktreeBranch, "feature");
  assert.equal(byId.get("sub").projectRoot, fs.realpathSync.native(sub));
  assert.equal(byId.get("removed").projectRoot, fs.realpathSync.native(repo));
});

test("unchanged persisted sources remain no-ops after worker-style payload normalization", async (t) => {
  const f = fixture(t);
  session(f.dir, "stable", { title: "stable title" });
  await scan(f);
  for (const source of f.sources.values()) {
    source.payload = Object.fromEntries(Object.entries(source.payload).reverse());
  }
  const batches = await scan(f);
  assert.deepEqual(batches.flatMap(batch => batch.updates), []);
  assert.equal(batches.at(-1).complete, true);
});

test("unreadable source retains last successful metadata and cannot become a tombstone", async (t) => {
  const f = fixture(t);
  const file = session(f.dir, "denied");
  await scan(f);
  const nativeOpen = fs.openSync;
  let deniedReads = 0;
  const mock = t.mock.method(fs, "openSync", (path, ...args) => {
    if (path === file) {
      deniedReads++;
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    }
    return nativeOpen(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const isolated = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
  const { scanNativeIndexBatch: scanBatch } = await isolated.import("./native-index.ts");
  const batches = await scan(f, { paths: [file], force: true }, [], scanBatch);
  assert.ok(deniedReads > 0, "positive control: actual scanner reads reached the inaccessible native source");
  assert.equal(f.sources.get(file).payload.id, "denied");
  assert.equal(batches.at(-1).complete, false);
  assert.ok(batches.at(-1).staleSources.includes(file));
  assert.deepEqual(batches.flatMap(batch => batch.removedPaths ?? []), []);
});

test("empty fresh installations complete successfully without creating a native sessions directory", async (t) => {
  const f = fixture(t);
  rmSync(f.roots.sessionsDir, { recursive: true });
  const batches = await scan(f);
  assert.equal(batches.at(-1).complete, true);
  assert.equal(fs.existsSync(f.roots.sessionsDir), false);
});

test("deletions preserve the inventory's original CAS base across later projection commits", async (t) => {
  const f = fixture(t);
  const file = session(f.dir, "removed");
  await scan(f);
  const initialStamp = f.sources.get(file).stamp;
  rmSync(file);
  let result = await scanNativeIndexBatch({}, f.roots, [], [...f.sources.values()]);
  f.sources.get(file).stamp = "newer-committed-source";
  while (result.nextScanToken) {
    result = await scanNativeIndexBatch({ scanToken: result.nextScanToken }, f.roots, [], [...f.sources.values()]);
  }
  assert.deepEqual(result.removedPaths, [file]);
  assert.equal(result.expectedSources[file], initialStamp);
});

test("repeated source failures retain stable stale coverage throughout the next inventory", async (t) => {
  const f = fixture(t);
  const a = session(f.dir, "broken-a");
  const b = session(f.dir, "broken-b");
  await scan(f);
  writeFileSync(a, "broken\n");
  writeFileSync(b, "broken\n");
  await scan(f);
  const batches = await scan(f);
  for (const batch of batches) assert.deepEqual(batch.staleSources, [a, b]);
  assert.deepEqual(batches.flatMap(batch => batch.updates), []);
});

test("targeted success cannot erase a prior failed directory inventory", async (t) => {
  const f = fixture(t);
  const file = session(f.dir, "healthy");
  await scan(f);
  const health = { complete: false, staleSources: [f.roots.sessionsDir], warnings: ["inventory unavailable"] };
  let result = await scanNativeIndexBatch({ paths: [file], force: true }, f.roots, [], [...f.sources.values()], health);
  apply(f, result);
  while (result.nextScanToken) {
    result = await scanNativeIndexBatch({ scanToken: result.nextScanToken }, f.roots, [], [...f.sources.values()], health);
    apply(f, result);
  }
  assert.equal(result.complete, false);
  assert.deepEqual(result.staleSources, [f.roots.sessionsDir]);
  assert.deepEqual(result.warnings, ["inventory unavailable"]);
});

test("final health publication carries each source version actually observed by the scan", async (t) => {
  const f = fixture(t);
  const file = session(f.dir, "observed");
  await scan(f);
  const initialStamp = f.sources.get(file).stamp;
  let result = await scanNativeIndexBatch({}, f.roots, [], [...f.sources.values()]);
  while (result.nextScanToken) {
    result = await scanNativeIndexBatch({ scanToken: result.nextScanToken }, f.roots, [], [...f.sources.values()]);
  }
  assert.equal(result.complete, true);
  assert.equal(result.expectedSources[file], initialStamp, "a concurrent stale/error update must reject this healthy completion");
});
