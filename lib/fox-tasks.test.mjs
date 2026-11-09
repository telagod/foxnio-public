import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { foxDispatchPath, isFoxDispatchTarget, readFoxDispatches, recordFoxDispatch, selectFoxDispatches } = await jiti.import("./fox-tasks.ts");

test("records FOX dispatches latest-first and sanitizes the task", () => {
  const home = mkdtempSync(join(tmpdir(), "fox-tasks-"));
  try {
    recordFoxDispatch({
      kind: "send_to_session",
      sourceSessionId: "fox",
      targetSessionId: "session-a",
      targetCwd: "/work/phone",
      task: "Fix the\n  authentication bug",
      delivery: "followUp",
      status: "sent",
    }, home);
    recordFoxDispatch({
      kind: "new_session",
      sourceSessionId: "fox",
      targetSessionId: "session-b",
      targetCwd: "/work/foxnio",
      task: "Investigate the flaky test",
      status: "started",
    }, home);

    const records = readFoxDispatches(home);
    assert.equal(records.length, 2);
    assert.equal(records[0].targetSessionId, "session-b");
    assert.equal(records[0].kind, "new_session");
    assert.equal(records[0].taskId, records[0].id);
    assert.equal(records[1].targetSessionId, "session-a");
    assert.equal(records[1].task, "Fix the authentication bug");
    assert.equal(records[1].delivery, "followUp");
    assert.equal(records[1].status, "sent");
    assert.equal(isFoxDispatchTarget(records[0].id, "session-b", home), true);
    assert.equal(isFoxDispatchTarget(records[0].id, "session-a", home), false);
    assert.equal(isFoxDispatchTarget(records[1].id, "session-a", home), false);
    assert.equal(isFoxDispatchTarget(undefined, "session-b", home), false);
    assert.equal(isFoxDispatchTarget("project-session-not-created-by-fox", "session-b", home), false);
    assert.deepEqual(selectFoxDispatches(records).map((record) => record.targetSessionId), ["session-b"]);

    const raw = JSON.parse(readFileSync(foxDispatchPath(home), "utf8"));
    assert.equal(raw.length, 2);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a send-only legacy record never authorizes or displays a target", () => {
  const home = mkdtempSync(join(tmpdir(), "fox-tasks-legacy-"));
  try {
    recordFoxDispatch({
      kind: "send_to_session",
      sourceSessionId: "fox",
      targetSessionId: "legacy-project-session",
      targetCwd: "/work/phone",
      task: "Old arbitrary dispatch",
      delivery: "followUp",
      status: "sent",
    }, home);

    assert.equal(isFoxDispatchTarget(undefined, "legacy-project-session", home), false);
    assert.deepEqual(selectFoxDispatches(readFoxDispatches(home)), []);

    recordFoxDispatch({
      kind: "new_session",
      sourceSessionId: "fox",
      targetSessionId: "fox-worker",
      targetCwd: "/work/phone",
      task: "New worker task",
      status: "started",
    }, home);

    const worker = readFoxDispatches(home).find((record) => record.kind === "new_session");
    assert.ok(worker);
    assert.equal(isFoxDispatchTarget(worker.id, "fox-worker", home), true);
    assert.deepEqual(
      selectFoxDispatches(readFoxDispatches(home)).map((record) => record.targetSessionId),
      ["fox-worker"],
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("follow-up records keep the worker task id", () => {
  const home = mkdtempSync(join(tmpdir(), "fox-tasks-followup-"));
  try {
    recordFoxDispatch({
      kind: "new_session",
      sourceSessionId: "fox",
      targetSessionId: "worker",
      task: "Original task",
      status: "started",
    }, home);
    const worker = readFoxDispatches(home)[0];
    recordFoxDispatch({
      kind: "send_to_session",
      sourceSessionId: "fox",
      targetSessionId: "worker",
      taskId: worker.id,
      task: "Follow up",
      delivery: "followUp",
      status: "sent",
    }, home);
    const followUp = readFoxDispatches(home).find((record) => record.kind === "send_to_session");
    assert.equal(followUp?.taskId, worker.id);
    assert.equal(isFoxDispatchTarget(worker.id, "worker", home), true);
    assert.equal(isFoxDispatchTarget(followUp?.id, "worker", home), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ignores a corrupt dispatch ledger", () => {
  const home = mkdtempSync(join(tmpdir(), "fox-tasks-bad-"));
  try {
    const path = foxDispatchPath(home);
    mkdirSync(join(home, ".omp", "agent", "omp-web", "fox"), { recursive: true });
    writeFileSync(path, "{not json", "utf8");
    assert.deepEqual(readFoxDispatches(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
