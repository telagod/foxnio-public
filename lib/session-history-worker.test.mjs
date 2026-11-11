import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const reader = await jiti.import("./session-reader.ts");
const { HistoryWorkerQueue } = await jiti.import("./session-history-queue.ts");
const { getSessionHistoryPage, getSessionContextBoundary, getSessionEntriesForDisplayAsync, SessionFileTooLargeError } = reader;
const workerFile = new URL("./session-history-worker.mjs", import.meta.url);
const entry = (id, parentId, content) => ({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content } });
function fixture(t, entries = [entry("one", null, "first")]) {
  const dir = mkdtempSync(join(tmpdir(), "history-worker-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, [JSON.stringify({ type: "session", version: 3, id: "history", cwd: dir }), ...entries.map(JSON.stringify)].join("\n") + "\n");
  t.after(() => { reader.invalidateSessionCaches(file); rmSync(dir, { recursive: true, force: true }); });
  return file;
}

// Pause a real engine read in the worker, not the main thread. The main loop
// must keep running while that read is blocked. This handshake proves thread
// isolation without depending on file size, host speed, or a latency threshold.
function gatedReader(t, file) {
  const gate = new Int32Array(new SharedArrayBuffer(8));
  let worker;
  const previous = globalThis.__ompHistoryWorkerQueue;
  globalThis.__ompHistoryWorkerQueue = new HistoryWorkerQueue(() => (worker = new Worker(`
    const { workerData } = require("node:worker_threads");
    const fs = require("node:fs");
    const gate = new Int32Array(workerData.gate);
    const fds = new Set();
    const open = fs.openSync, close = fs.closeSync, read = fs.readSync;
    fs.openSync = (file, ...args) => { const fd = open(file, ...args); if (file === workerData.file) fds.add(fd); return fd; };
    fs.closeSync = (fd) => { fds.delete(fd); return close(fd); };
    fs.readSync = (...args) => {
      if (fds.has(args[0]) && Atomics.compareExchange(gate, 0, 0, 1) === 0) {
        Atomics.notify(gate, 0);
        Atomics.wait(gate, 1, 0);
      }
      return read(...args);
    };
    require("node:module").syncBuiltinESMExports();
    import(require("node:url").pathToFileURL(workerData.bootstrap).href).catch((error) => { throw error; });
  `, { eval: true, execArgv: [], workerData: { gate: gate.buffer, file, bootstrap: fileURLToPath(workerFile) } })));
  t.after(async () => {
    Atomics.store(gate, 1, 1); Atomics.notify(gate, 1);
    globalThis.__ompHistoryWorkerQueue = previous;
    if (worker) await worker.terminate();
  });
  return async (read, duringRead = () => {}) => {
    Atomics.store(gate, 0, 0); Atomics.store(gate, 1, 0);
    let settled = false;
    const result = read().then((value) => { settled = true; return value; });
    const reading = Promise.resolve(Atomics.waitAsync(gate, 0, 0, 10_000).value).then(() => {
      assert.equal(Atomics.load(gate, 0), 1, "the actual file read reached the worker gate");
    });
    try {
      await Promise.race([reading, result.then(() => { throw new Error("History completed without an off-thread read"); })]);
      await setImmediate();
      assert.equal(settled, false, "the main event loop advanced while the worker read remained blocked");
      duringRead();
    } finally {
      Atomics.store(gate, 1, 1); Atomics.notify(gate, 1);
    }
    return result;
  };
}

test("cold page, boundary and display parsing yield to the main event loop", async (t) => {
  const file = fixture(t, [entry("e0", null, "first"), entry("e1", "e0", "second")]);
  const assertYields = gatedReader(t, file);
  const page = await assertYields(() => getSessionHistoryPage(file, null, 1));
  assert.deepEqual(page.history.context.entryIds, ["e0"]);
  reader.invalidateSessionCaches(file);
  assert.equal((await assertYields(() => getSessionContextBoundary(file))).entryIds.length, 2);
  reader.invalidateSessionCaches(file);
  assert.equal((await assertYields(() => getSessionEntriesForDisplayAsync(file))).length, 2);
});

test("append and prefix rewrite rebuilds yield without advancing an invalid cursor", async (t) => {
  const file = fixture(t, [entry("one", null, "first"), entry("two", "one", "second")]);
  const assertYields = gatedReader(t, file);
  const first = await assertYields(() => getSessionHistoryPage(file, null, 1));
  appendFileSync(file, JSON.stringify(entry("three", "two", "new")) + "\n");
  const appended = await assertYields(() => getSessionHistoryPage(file, first.history.cursor, 2));
  assert.equal(appended.history.mode, "append");
  assert.deepEqual(appended.history.context.entryIds, ["two", "three"]);
  writeFileSync(file, [JSON.stringify({ type: "session", version: 3, id: "history" }), JSON.stringify(entry("replacement", null, "a changed and extended prefix".repeat(1000)))].join("\n") + "\n");
  const replaced = await assertYields(() => getSessionHistoryPage(file, appended.history.cursor, 1));
  assert.equal(replaced.history.mode, "replace");
  assert.deepEqual(replaced.history.context.entryIds, ["replacement"]);
});

test("a file changed during a worker page read rejects instead of advancing the cursor", async (t) => {
  const file = fixture(t, [entry("one", null, "first"), entry("two", "one", "second")]);
  const read = gatedReader(t, file);
  const first = await read(() => getSessionHistoryPage(file, null, 1));
  await assert.rejects(read(
    () => getSessionHistoryPage(file, first.history.cursor, 1),
    () => appendFileSync(file, JSON.stringify(entry("three", "two", "new")) + "\n"),
  ), /Session changed/);
  const recovered = await read(() => getSessionHistoryPage(file, first.history.cursor, 2));
  assert.equal(recovered.history.mode, "append");
  assert.deepEqual(recovered.history.context.entryIds, ["two", "three"]);
});

test("worker errors preserve the load-ceiling class and do not poison later reads", async (t) => {
  const file = fixture(t);
  const first = await getSessionHistoryPage(file, null, 1);
  truncateSync(file, 1024 * 1024 * 1024 + 1);
  for (const read of [() => getSessionHistoryPage(file, first.history.cursor, 1), () => getSessionContextBoundary(file), () => getSessionEntriesForDisplayAsync(file)]) {
    await assert.rejects(read, (error) => error instanceof SessionFileTooLargeError && error.code === "session_file_too_large");
  }
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "history" }) + "\n" + JSON.stringify(entry("recovered", null, "recovered")) + "\n");
  assert.deepEqual((await getSessionHistoryPage(file, first.history.cursor, 1)).history.context.entryIds, ["recovered"]);
});

test("bounded queue rejects overload, rejects all pending on worker crash, then recovers", async (t) => {
  const file = fixture(t);
  let worker;
  let firstWorker = true;
  const queue = new HistoryWorkerQueue(() => {
    // Hold startup until explicitly terminated; saturation must not depend on
    // how quickly a host can initialize jiti and finish the first request.
    worker = firstWorker
      ? new Worker("const { workerData } = require('node:worker_threads'); Atomics.wait(new Int32Array(workerData), 0, 0);", { eval: true, execArgv: [], workerData: new SharedArrayBuffer(4) })
      : new Worker(workerFile, { execArgv: [] });
    firstWorker = false;
    return worker;
  });
  t.after(async () => { if (worker) await worker.terminate(); });
  const requests = Array.from({ length: 33 }, (_, i) => queue.run({ operation: "page", filePath: file, cursor: null, limit: i + 1 }));
  const settled = Promise.allSettled(requests);
  await assert.rejects(queue.run({ operation: "page", filePath: file, cursor: null, limit: 34 }), { code: "session_history_busy" });
  await worker.terminate();
  const failures = await settled;
  assert.ok(failures.every((result) => result.status === "rejected" && result.reason.code === "session_history_worker_failed"));
  const recovered = await queue.run({ operation: "page", filePath: file, cursor: null, limit: 1 });
  assert.deepEqual(recovered.history.context.entryIds, ["one"]);
});

test("same-request coalescing does not merge different page options", async (t) => {
  const file = fixture(t, [entry("one", null, "first"), entry("two", "one", "second")]);
  const [a, b, c] = await Promise.all([getSessionHistoryPage(file, null, 1), getSessionHistoryPage(file, null, 1), getSessionHistoryPage(file, null, 2)]);
  assert.equal(a, b);
  assert.deepEqual(a.history.context.entryIds, ["one"]);
  assert.deepEqual(c.history.context.entryIds, ["one", "two"]);
});

test("an idle history worker does not keep a Node process alive", async (t) => {
  const file = fixture(t);
  const script = `
    import { createJiti } from "jiti";
    const jiti = createJiti(${JSON.stringify(import.meta.url)});
    const reader = await jiti.import("./session-reader.ts");
    const page = await reader.getSessionHistoryPage(${JSON.stringify(file)}, null, 1);
    console.log(JSON.stringify(page.history.context.entryIds));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), timeout: 15_000,
  });
  assert.deepEqual(JSON.parse(stdout.trim()), ["one"]);
});

test("worker initialization failures reject pending reads and allow a fresh worker", async (t) => {
  const file = fixture(t);
  let worker;
  let initial = true;
  const queue = new HistoryWorkerQueue(() => {
    const bootstrap = initial ? new URL("./missing-history-worker.mjs", import.meta.url) : workerFile;
    initial = false;
    return (worker = new Worker(bootstrap, { execArgv: [] }));
  });
  t.after(async () => { if (worker) await worker.terminate(); });
  const first = queue.run({ operation: "boundary", filePath: file });
  const second = queue.run({ operation: "page", filePath: file, cursor: null, limit: 1 });
  for (const result of await Promise.allSettled([first, second])) {
    assert.equal(result.status, "rejected");
    assert.equal(result.reason.code, "session_history_worker_failed");
  }
  assert.deepEqual(await queue.run({ operation: "boundary", filePath: file }), { entryIds: ["one"] });
});

test("targeted invalidation reaches the worker's raw cache after a same-size mtime-preserving edit", async (t) => {
  const file = fixture(t);
  const mtime = new Date("2026-01-02T00:00:00.000Z");
  utimesSync(file, mtime, mtime);
  const before = statSync(file);
  const first = await reader.getSessionEntries(file);
  assert.equal(first[0].message.content, "first");
  writeFileSync(file, readFileSync(file, "utf8").replace('"content":"first"', '"content":"fresh"'));
  utimesSync(file, mtime, mtime);
  assert.equal(statSync(file).size, before.size);
  assert.equal(statSync(file).mtimeMs, before.mtimeMs);
  reader.invalidateSessionCaches(file);
  assert.equal((await reader.getSessionEntries(file))[0].message.content, "fresh");
});

test("worker pages and full display retain compaction, branch, Unicode and blob semantics", async (t) => {
  const file = fixture(t, [
    entry("old", null, "omitted"),
    entry("image", "old", [{ type: "image", data: `blob:sha256:${"a".repeat(64)}`, mimeType: "image/png" }]),
    { type: "compaction", id: "summary", parentId: "image", firstKeptEntryId: "image", summary: "概要", tokensBefore: 20, timestamp: "2026-01-01T00:00:00.000Z" },
    entry("branch", "summary", "not selected"),
    entry("tip", "summary", "当前分支"),
  ]);
  const agentDir = join(file, "..");
  mkdirSync(join(agentDir, "blobs"));
  writeFileSync(join(agentDir, "blobs", "a".repeat(64)), "image-bytes");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  const display = await reader.getSessionDisplay(file);
  assert.deepEqual(display.context.entryIds, ["summary", "image", "tip"]);
  assert.equal(display.leafId, "tip");
  assert.equal(display.context.messages[0].content, "概要");
  assert.equal(display.context.messages[1].content[0].data, Buffer.from("image-bytes").toString("base64"));
  assert.equal(display.context.messages[2].content, "当前分支");
  const messages = [];
  let cursor = null;
  for (const id of ["summary", "image", "tip"]) {
    const page = await getSessionHistoryPage(file, cursor, 1);
    assert.deepEqual(page.history.context.entryIds, [id]);
    messages.push(...page.history.context.messages);
    cursor = page.history.cursor;
  }
  assert.deepEqual(messages, display.context.messages);
  const branch = await reader.getSessionContextForDisplay(file, "branch");
  assert.deepEqual(branch.entryIds, ["summary", "image", "branch"]);
  assert.equal(branch.messages[2].content, "not selected");
  assert.equal((await reader.getSessionEntries(file))[1].message.content[0].data, `blob:sha256:${"a".repeat(64)}`);
});
