import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { FOX_REPORT_MESSAGE, FOX_REPORT_OUTBOX } from "./omp/fox-reports.mjs";

const jiti = createJiti(import.meta.url, { tryNative: false });
const m = await jiti.import("./fox-report-store.ts");
const { foxWorkspaceDir } = await jiti.import("./fox-workspace.ts");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "fox-report-store-"));
  const parentFile = join(root, "parent.jsonl");
  const parentId = "parent-one";
  const header = (id, cwd, parentSession) => ({ type: "session", version: 3, id, cwd, ...(parentSession ? { parentSession } : {}), timestamp: new Date().toISOString() });
  const write = (file, entries) => writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  write(parentFile, [header(parentId, foxWorkspaceDir())]);
  const delivered = [];
  const deliver = async (report) => {
    delivered.push(report.id);
    appendFileSync(parentFile, JSON.stringify({ type: "custom_message", customType: FOX_REPORT_MESSAGE, details: { report } }) + "\n");
  };
  m.configureFoxReportDelivery(deliver);
  t.after(async () => {
    await m.stopFoxReportDelivery();
    globalThis.__foxReportRelay = undefined;
    rmSync(root, { recursive: true, force: true });
  });
  const worker = (id = "worker-one", sequence = 1, summary = "Verified fixture result") => {
    const file = join(root, `${id}.jsonl`);
    const cwd = join(root, id);
    const report = {
      version: 1, id: `${id}:${sequence}`, sequence, sourceSessionId: id, parentSessionId: parentId,
      cwd, at: new Date().toISOString(), status: "result", source: "agent", summary, evidence: ["Fixture check passed"],
    };
    const sessionHeader = header(id, cwd, parentFile);
    write(file, [sessionHeader, { type: "custom", customType: FOX_REPORT_OUTBOX, data: report }]);
    return { file, report, sessionHeader };
  };
  return { root, parentFile, parentId, worker, write, delivered, deliver };
}

test("a busy coordinator retains the native outbox and gets exactly one receipt after settlement", async (t) => {
  const f = fixture(t);
  const w = f.worker();
  let busy = true;
  m.configureFoxReportDelivery(async (report) => {
    if (busy) throw new Error("FOX is busy");
    await f.deliver(report);
  });
  await m.acceptFoxReport(w.file, w.report);
  await m.flushFoxReports();
  assert.equal((await m.foxWorkerReportView(w.file)).delivery, "pending");
  assert.equal(f.delivered.length, 0);
  busy = false;
  m.wakeFoxReportDelivery(f.parentId);
  await m.flushFoxReports();
  assert.equal((await m.foxWorkerReportView(w.file)).delivery, "received");
  await m.recoverFoxWorkerReports(w.file);
  await m.flushFoxReports();
  assert.deepEqual(f.delivered, [w.report.id]);
});

test("a newly persisted worker result clears parent busy retry instead of inheriting its delay", async (t) => {
  const f = fixture(t);
  const first = f.worker("worker-one");
  let busy = true;
  m.configureFoxReportDelivery(async (report) => {
    if (busy) throw new Error("FOX is busy");
    await f.deliver(report);
  });
  await m.acceptFoxReport(first.file, first.report);
  await m.flushFoxReports();
  assert.equal(f.delivered.length, 0);
  busy = false;
  const next = f.worker("worker-two");
  await m.acceptFoxReport(next.file, next.report);
  await m.flushFoxReports();
  assert.deepEqual(new Set(f.delivered), new Set([first.report.id, next.report.id]));
});

test("delivery survives a service restart and a lost acknowledgement without another status database", async (t) => {
  const f = fixture(t);
  const w = f.worker();
  await m.stopFoxReportDelivery();
  globalThis.__foxReportRelay = undefined;
  m.configureFoxReportDelivery(async (report) => {
    await f.deliver(report);
    throw new Error("The acknowledgement connection closed");
  });
  await m.recoverFoxWorkerReports(w.file);
  await m.flushFoxReports();
  assert.equal(f.delivered.length, 1);
  await m.stopFoxReportDelivery();
  globalThis.__foxReportRelay = undefined;
  m.configureFoxReportDelivery(f.deliver);
  await m.recoverFoxWorkerReports(w.file);
  await m.flushFoxReports();
  assert.equal((await m.foxWorkerReportView(w.file)).delivery, "received");
  assert.equal(f.delivered.length, 1);
});

test("a forged recipient, source or non-durable notification cannot enter the inbox", async (t) => {
  const f = fixture(t);
  const w = f.worker();
  await assert.rejects(m.acceptFoxReport(w.file, { ...w.report, parentSessionId: "another-fox" }), /native session and parent/);
  await assert.rejects(m.acceptFoxReport(w.file, { ...w.report, id: "other-worker:1", sourceSessionId: "other-worker" }), /native session and parent/);
  await assert.rejects(m.acceptFoxReport(w.file, { ...w.report, summary: "Not actually on disk" }), /durably recorded/);
  assert.deepEqual(f.delivered, []);
});

test("older native reports cannot replace the latest worker summary", async (t) => {
  const f = fixture(t);
  const w = f.worker("worker-one", 2, "Newest result");
  appendFileSync(w.file, JSON.stringify({ type: "custom", customType: FOX_REPORT_OUTBOX, data: { ...w.report, id: "worker-one:1", sequence: 1, summary: "Old progress", status: "progress" } }) + "\n");
  await m.recoverFoxWorkerReports(w.file);
  await m.flushFoxReports();
  const view = await m.foxWorkerReportView(w.file);
  assert.equal(view.report.sequence, 2);
  assert.equal(view.report.summary, "Newest result");
  assert.equal(view.delivery, "received");
});

for (const reference of ["path", "id"]) {
  test(`worker and coordinator native continuations preserve original routing and receipts (${reference})`, async (t) => {
    const f = fixture(t);
    const w = f.worker("worker-original", 12);
    const movedWorker = join(f.root, "worker-continued.jsonl");
    const movedParent = join(f.root, "parent-continued.jsonl");
    const workerHeader = { ...w.sessionHeader, id: "worker-continued", parentSession: reference === "id" ? w.sessionHeader.id : w.file, continuationOf: w.sessionHeader.id };
    const report = { ...w.report, id: "worker-continued:1", sourceSessionId: workerHeader.id, sequence: 1, summary: "Result after restart" };
    f.write(movedWorker, [
      workerHeader,
      { type: "custom", customType: FOX_REPORT_OUTBOX, data: w.report },
      { type: "custom", customType: FOX_REPORT_OUTBOX, data: report },
    ]);
    const parentHeader = JSON.parse(readFileSync(f.parentFile, "utf8").trim());
    f.write(movedParent, [{ ...parentHeader, id: "parent-continued", parentSession: reference === "id" ? f.parentId : f.parentFile, continuationOf: f.parentId }]);
    m.configureFoxReportDelivery(async (item, parentFile) => {
      assert.equal(parentFile, f.parentFile);
      appendFileSync(movedParent, JSON.stringify({ type: "custom_message", customType: FOX_REPORT_MESSAGE, details: { report: item } }) + "\n");
    });
    assert.equal(m.foxWorkerParent(movedWorker).parent.id, f.parentId);
    await m.acceptFoxReport(movedWorker, report);
    await m.flushFoxReports();
    const view = await m.foxWorkerReportView(movedWorker);
    assert.equal(view.report.id, report.id);
    assert.equal(view.report.parentSessionId, f.parentId);
    assert.equal(view.delivery, "received");
    assert.equal((await m.readFoxReportJournal(f.parentFile)).received.size, 2);
  });
}

test("native ID continuations reject ambiguous, mismatched, missing and cyclic sources", async (t) => {
  const f = fixture(t);
  const w = f.worker();
  const copy = join(f.root, "copy-worker.jsonl");
  const header = { ...w.sessionHeader, id: "copy-worker", parentSession: w.sessionHeader.id, continuationOf: w.sessionHeader.id };
  f.write(copy, [header]);
  assert.equal(m.foxWorkerParent(copy).parent.id, f.parentId);
  const duplicate = join(f.root, "renamed-duplicate.jsonl");
  f.write(duplicate, [w.sessionHeader]);
  assert.equal(m.foxWorkerParent(copy), null);
  rmSync(duplicate);
  for (const change of [
    { parentSession: "other-worker" },
    { parentSession: "missing-worker", continuationOf: "missing-worker" },
    { cwd: join(f.root, "another-project") },
    { continuationOf: undefined },
  ]) {
    f.write(copy, [{ ...header, ...change }]);
    assert.equal(m.foxWorkerParent(copy), null);
  }
  f.write(copy, [header]);
  f.write(w.file, [{ ...w.sessionHeader, parentSession: header.id, continuationOf: header.id }]);
  assert.equal(m.foxWorkerParent(copy), null);
});

test("an independent fork is not a continuation or a replacement report recipient", async (t) => {
  const f = fixture(t);
  const w = f.worker();
  const fork = join(f.root, "fork-worker.jsonl");
  f.write(fork, [{ ...w.sessionHeader, id: "fork-worker", parentSession: w.file }]);
  assert.equal(m.foxWorkerParent(fork), null);
  const otherFox = join(f.root, "new-fox.jsonl");
  const header = JSON.parse(readFileSync(f.parentFile, "utf8").trim());
  f.write(otherFox, [
    { ...header, id: "new-fox-parent", parentSession: f.parentFile },
    { type: "custom_message", customType: FOX_REPORT_MESSAGE, details: { report: w.report } },
  ]);
  assert.equal((await m.readFoxReportJournal(f.parentFile)).received.size, 0);
  f.write(fork, [{ ...w.sessionHeader, id: "fork-worker", parentSession: w.file, continuationOf: "not-the-worker" }]);
  assert.equal(m.foxWorkerParent(fork), null);
});

test("a missing outbox must not starve independent workers reporting to the same parent", async (t) => {
  const f = fixture(t);
  await m.stopFoxReportDelivery();
  const missing = f.worker("worker-missing", 10);
  const healthy = f.worker("worker-healthy");
  await m.recoverFoxWorkerReports(missing.file);
  await m.recoverFoxWorkerReports(healthy.file);
  f.write(missing.file, [missing.sessionHeader]);
  m.startFoxReportDelivery();
  await m.flushFoxReports();
  assert.equal((await m.foxWorkerReportView(healthy.file)).delivery, "received");
  assert.equal((await m.foxWorkerReportView(missing.file)).delivery, "unavailable");
});

test("a large failed outbox cannot monopolize the parent's delivery batch", async (t) => {
  const f = fixture(t);
  await m.stopFoxReportDelivery();
  const missing = f.worker("worker-backlog");
  const healthy = f.worker("worker-healthy");
  f.write(missing.file, [
    missing.sessionHeader,
    ...Array.from({ length: 75 }, (_, index) => ({
      type: "custom", customType: FOX_REPORT_OUTBOX,
      data: { ...missing.report, sequence: index + 10, id: `${missing.report.sourceSessionId}:${index + 10}` },
    })),
  ]);
  await m.recoverFoxWorkerReports(missing.file);
  await m.recoverFoxWorkerReports(healthy.file);
  f.write(missing.file, [missing.sessionHeader]);
  m.startFoxReportDelivery();
  await m.flushFoxReports();
  await m.flushFoxReports();
  assert.equal((await m.foxWorkerReportView(healthy.file)).delivery, "received");
});

test("conflicting receipts for one worker leave independent reports deliverable", async (t) => {
  const f = fixture(t);
  await m.stopFoxReportDelivery();
  const broken = f.worker("worker-conflict");
  const healthy = f.worker("worker-healthy");
  for (const report of [broken.report, { ...broken.report, summary: "Conflicting evidence" }]) {
    appendFileSync(f.parentFile, JSON.stringify({ type: "custom_message", customType: FOX_REPORT_MESSAGE, details: { report } }) + "\n");
  }
  await m.recoverFoxWorkerReports(broken.file);
  await m.recoverFoxWorkerReports(healthy.file);
  m.startFoxReportDelivery();
  await m.flushFoxReports();
  assert.equal((await m.foxWorkerReportView(broken.file)).delivery, "unavailable");
  assert.equal((await m.foxWorkerReportView(healthy.file)).delivery, "received");
});

test("native metadata scanning skips large transcript messages without losing subsequent reports", async (t) => {
  const f = fixture(t);
  const w = f.worker();
  const reportLine = readFileSync(w.file, "utf8").trim().split("\n").at(-1);
  f.write(w.file, [w.sessionHeader, { type: "message", message: { role: "user", content: "x".repeat(600_000) } }]);
  appendFileSync(w.file, reportLine + "\n");
  await m.recoverFoxWorkerReports(w.file);
  await m.flushFoxReports();
  assert.equal((await m.foxWorkerReportView(w.file)).delivery, "received");
});
