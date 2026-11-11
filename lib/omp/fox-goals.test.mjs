import assert from "node:assert/strict";
import test from "node:test";
import {
  FOX_GOAL_ENTRY, parseFoxGoalTerms, projectFoxGoal, validateFoxGoalDispatch,
  validateFoxGoalReview, assertFoxGoalComplete, resolveFoxGoalHandoff,
} from "./fox-goals.mjs";
import { foxActionFingerprint } from "./fox-dispatch-guard.mjs";

const terms = { objective: "Ship fix", projects: ["/work/project"], criteria: [{ id: "works", text: "Regression passes" }], operations: ["implementation", "verification"], maxWorkers: 4, maxDispatches: 64, maxRework: 3 };
const native = { enabled: true, mode: "active", goal: { id: "native-one", objective: "Ship fix", status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 } };
const todos = [{ name: "Deliver", tasks: [{ id: "item-one", content: "Fix", status: "in_progress" }] }];
const record = (id, op, data = {}) => ({ type: "custom", customType: FOX_GOAL_ENTRY, id, timestamp: "2026-11-11T10:00:00Z", data: { version: 1, op, sessionId: "fox-parent", epoch: "epoch-one", grantEntryId: "consent-one", ...data } });
const initial = () => [record("consent-one", "consent", { terms }), record("bind-one", "bind", { goalId: "native-one", objective: "Ship fix" })];
const coordination = { grantEntryId: "consent-one", nativeGoalId: "native-one", planItemRef: "item-one", purpose: "implementation", criterionIds: ["works"] };
const dispatch = (snapshot, changes = {}, input = {}) => validateFoxGoalDispatch(snapshot, { ...coordination, ...changes }, { toolName: "new_session", projectKey: "/work/project", input: { cwd: "/work/project", prompt: "Fix regression", ...input } });
const admission = (n, patch = {}) => record(`admit-${n}`, "admit", { goalId: "native-one", coordination, cwd: "/work/project", toolName: "new_session", toolCallId: `call-${n}`, fingerprint: "a".repeat(64), ...patch });

// Missing monotonic journal controls would revive permission after branch rewind.
test("complete-journal revocation and consumed admissions survive rewind and duplicate replay", () => {
  const entries = [...initial(), admission(1), record("revoke-one", "control", { action: "revoke" }), ...initial()];
  const snapshot = projectFoxGoal(entries, native, todos);
  assert.equal(snapshot.grant.revoked, true);
  assert.equal(snapshot.dispatchesUsed, 1);
  assert.throws(() => dispatch(snapshot), /revoked/);
  const conflicting = projectFoxGoal([...initial(), record("consent-one", "consent", { terms: { ...terms, objective: "Different" } })], native, todos);
  assert.equal(conflicting.supported, false);
});

test("terms and dispatch reject changed goal, cwd, criterion, permission and ambiguous plan", () => {
  assert.throws(() => parseFoxGoalTerms({ ...terms, projects: ["../project"] }));
  assert.throws(() => parseFoxGoalTerms({ ...terms, criteria: [terms.criteria[0], terms.criteria[0]] }));
  const snapshot = projectFoxGoal(initial(), native, todos);
  assert.equal(dispatch(snapshot).cwd, "/work/project");
  for (const change of [{ nativeGoalId: "wrong" }, { grantEntryId: "wrong" }, { criterionIds: ["wrong"] }, { planItemRef: "missing" }]) assert.throws(() => dispatch(snapshot, change));
  assert.throws(() => dispatch(snapshot, {}, { cwd: "/work/other" }));
  assert.throws(() => dispatch(projectFoxGoal(initial(), { ...native, goal: { ...native.goal, objective: "Different" } }, todos)));
  assert.throws(() => dispatch(projectFoxGoal(initial(), native, [{ name: "Ambiguous", tasks: [...todos[0].tasks, ...todos[0].tasks] }])));
});

test("64 durable logical admissions cannot be refunded by settlement or failures", () => {
  const entries = initial();
  for (let n = 0; n < 64; n++) {
    assert.equal(dispatch(projectFoxGoal(entries, native, todos)).cwd, "/work/project");
    entries.push(admission(n), record(`settled-${n}`, "settle", { admissionId: `admit-${n}`, state: "closed" }));
  }
  const snapshot = projectFoxGoal(entries, native, todos);
  assert.equal(snapshot.dispatchesUsed, 64);
  assert.throws(() => dispatch(snapshot), /dispatch.*limit/i);
});

test("three rework admissions per exact item remain spent after closure", () => {
  const entries = initial();
  for (let n = 0; n < 3; n++) {
    dispatch(projectFoxGoal(entries, native, todos), { purpose: "rework" });
    entries.push(admission(n, { coordination: { ...coordination, purpose: "rework" } }), record(`closed-${n}`, "settle", { admissionId: `admit-${n}`, state: "closed" }));
  }
  assert.throws(() => dispatch(projectFoxGoal(entries, native, todos), { purpose: "rework" }), /rework.*limit/i);
});

test("reservations occupy four slots and writers exclude revision verification in same cwd", () => {
  assert.throws(() => dispatch(projectFoxGoal([...initial(), admission(1)], native, todos)), /mutating|writer/i);
  assert.throws(() => dispatch(projectFoxGoal([...initial(), admission(1)], native, todos), { purpose: "verification" }), /writer|revision/i);
  const entries = initial();
  for (let n = 0; n < 4; n++) entries.push(admission(n, { coordination: { ...coordination, purpose: "evidence" } }));
  assert.throws(() => dispatch(projectFoxGoal(entries, native, todos), { purpose: "evidence" }), /worker.*limit/i);
});

const evidence = { kind: "check", reference: "npm test -- regression", observed: "1 test passed, 0 failed", revision: "abc123" };
const report = { version: 1, id: "worker-one:1", sequence: 1, sourceSessionId: "worker-one", parentSessionId: "fox-parent", cwd: "/work/project", at: "2026-11-11T10:01:00Z", source: "agent", status: "result", audience: "coordinator", summary: "Regression passed", evidence: [], structuredEvidence: [evidence], goalId: "native-one", assignmentId: "admit-1", criterionIds: ["works"] };
const received = (value = report) => ({ id: `receipt-${value.id}`, type: "custom", customType: "fox-worker-report-receipt", data: { report: value } });
const bound = () => [...initial(), admission(1), record("assignment-one", "assignment", { admissionId: "admit-1", workerSessionId: "worker-one", workerFile: "/sessions/worker.jsonl" }), record("settled-one", "settle", { admissionId: "admit-1", state: "settled" })];
const review = { criterionId: "works", decision: "accept", reportIds: [report.id], evidence: [evidence] };

test("completion requires received matching evidence, settled assignments and all accepted criteria", () => {
  assert.throws(() => assertFoxGoalComplete(projectFoxGoal(initial(), native, todos)), /criterion|review/i);
  assert.throws(() => validateFoxGoalReview(projectFoxGoal(bound(), native, todos), review), /received/i);
  const entries = [...bound(), received()];
  assert.deepEqual(validateFoxGoalReview(projectFoxGoal(entries, native, todos), review), review);
  assert.throws(() => validateFoxGoalReview(projectFoxGoal(entries, native, todos), { ...review, evidence: [{ ...evidence, observed: "made up" }] }), /observed|evidence/i);
  entries.push(record("review-one", "review", { review }));
  assert.doesNotThrow(() => assertFoxGoalComplete(projectFoxGoal(entries, native, [{ name: "Deliver", tasks: [{ ...todos[0].tasks[0], status: "completed" }] }])));
  assert.throws(() => assertFoxGoalComplete(projectFoxGoal([...entries, admission(2)], native, todos)), /assignment|settled/i);
  const changed = { ...report, id: "worker-one:2", sequence: 2, structuredEvidence: [{ ...evidence, revision: "def456" }] };
  assert.throws(() => assertFoxGoalComplete(projectFoxGoal([...entries, received(changed)], native, todos)), /stale|review|criterion/i);
});

test("outbox-only reports and legacy final text never confer evidence acceptance", () => {
  const outbox = { ...received(), customType: "fox-worker-report" , data: report };
  assert.throws(() => validateFoxGoalReview(projectFoxGoal([...bound(), outbox], native, todos), review), /received/i);
  const legacy = { ...report, structuredEvidence: undefined };
  assert.throws(() => validateFoxGoalReview(projectFoxGoal([...bound(), received(legacy)], native, todos), review), /evidence/i);
});

test("native completed persistence survives RPC null while ordinary drop never implies completion", () => {
  const completed = { type: "mode_change", id: "complete-one", mode: "goal", data: { goal: { ...native.goal, status: "complete" } } };
  const exit = { type: "mode_change", id: "exit-one", mode: "none" };
  const receipt = { type: "custom", customType: "goal-completed", data: { objective: "Ship fix", tokensUsed: 10, timeUsedSeconds: 2 } };
  const snapshot = projectFoxGoal([...initial(), completed, exit, receipt], null, todos);
  assert.equal(snapshot.goal.goal.status, "complete");
  assert.equal(snapshot.goal.enabled, false);
  assert.equal(projectFoxGoal([...initial(), { ...completed, data: { goal: { ...native.goal, status: "dropped" } } }, exit], null).goal, null);
});

test("recorded handoff consumes a report batch and absent native delivery stays uncertain", () => {
  const handoff = record("handoff-one", "handoff", { goalId: "native-one", batchId: "batch-one", reportIds: [report.id] });
  const entries = [...bound(), received(), handoff];
  assert.equal(projectFoxGoal(entries, native, todos).recovery, "uncertain");
  assert.deepEqual(projectFoxGoal(entries, native, todos).handledReportIds, []);
  entries.push({ type: "custom_message", id: "handoff-message", customType: "fox-goal-handoff", details: { handoffEntryId: "handoff-one", batchId: "batch-one", reportIds: [report.id] } });
  const snapshot = projectFoxGoal([...entries, handoff], native, todos);
  assert.deepEqual(snapshot.handledReportIds, ["worker-one:1"]);
  assert.equal(snapshot.recovery, "next");
});

test("legacy reports need an explicit matching inspected excerpt, never an automatic accepted result", () => {
  const legacy = { ...report, structuredEvidence: undefined, summary: "Regression test ran: 1 passed, 0 failed" };
  const snapshot = projectFoxGoal([...bound(), received(legacy)], native, todos);
  const inspected = { ...review, evidence: [{ kind: "artifact", reference: "report:worker-one:1", observed: "1 passed, 0 failed" }] };
  assert.deepEqual(validateFoxGoalReview(snapshot, inspected), inspected);
  assert.equal(snapshot.reviews.length, 0);
  assert.throws(() => validateFoxGoalReview(snapshot, { ...inspected, evidence: [{ ...inspected.evidence[0], observed: "Independent deployment passed" }] }), /evidence|excerpt/i);
});

test("rebind cannot refund rework or reset consumed dispatches", () => {
  const entries = initial();
  for (let n = 0; n < 3; n++) entries.push(admission(n, { coordination: { ...coordination, purpose: "rework" } }), record(`done-${n}`, "settle", { admissionId: `admit-${n}`, state: "closed" }));
  entries.push(record("rebind-one", "rebind", { admissionId: "admit-2", planItemRef: "item-renamed" }));
  const snapshot = projectFoxGoal(entries, native, [{ name: "Deliver", tasks: [{ id: "item-renamed", content: "Fix", status: "pending" }] }]);
  assert.equal(snapshot.dispatchesUsed, 3);
  assert.throws(() => dispatch(snapshot, { purpose: "rework", planItemRef: "item-renamed" }), /rework.*limit/i);
});

test("status-only native todo updates preserve exact established references but renames do not", () => {
  const first = { type: "custom", customType: "user_todo_edit", id: "plan-one", data: { phases: [{ name: "Deliver", tasks: [{ content: "Fix", status: "pending" }] }] } };
  const blocked = { ...first, id: "plan-two", data: { phases: [{ name: "Deliver", tasks: [{ content: "Fix", status: "blocked" }] }] } };
  const reference = '["plan-one","Deliver","Fix"]';
  const snapshot = projectFoxGoal([...initial(), first, blocked], native);
  assert.equal(dispatch(snapshot, { planItemRef: reference }).planItemRef, reference);
  assert.throws(() => dispatch(snapshot, { planItemRef: '["forged-plan","Deliver","Fix"]' }));
  const renamed = { ...blocked, id: "plan-three", data: { phases: [{ name: "Deliver", tasks: [{ content: "Different", status: "pending" }] }] } };
  assert.throws(() => dispatch(projectFoxGoal([...initial(), first, renamed], native), { planItemRef: reference }));
  assert.throws(() => dispatch(snapshot, { planItemRef: reference }, { wait: true }), /must not wait/);
});

test("host rechecks the same 64th admission without consuming another slot or permitting changed args", () => {
  const entries = initial();
  for (let n = 0; n < 63; n++) entries.push(admission(n), record(`closed-${n}`, "settle", { admissionId: `admit-${n}`, state: "closed" }));
  const action = { sessionId: "fox-parent", toolCallId: "call-63", toolName: "new_session", projectKey: "/work/project", input: { cwd: "/work/project", prompt: "Fix", coordination } };
  entries.push(admission(63, { fingerprint: foxActionFingerprint(action) }));
  const snapshot = projectFoxGoal(entries, native, todos);
  assert.equal(validateFoxGoalDispatch(snapshot, coordination, { ...action, admissionId: "admit-63" }).cwd, "/work/project");
  assert.throws(() => validateFoxGoalDispatch(snapshot, coordination, { ...action, input: { ...action.input, prompt: "Different" }, admissionId: "admit-63" }), /exact pending action/);
  assert.throws(() => dispatch(snapshot), /dispatch.*limit/i);
});

test("malformed authority namespaces and conflicting epochs fail closed", () => {
  const invalidNamespace = { ...record("bad-entry", "control", { action: "revoke" }), type: "custom_message" };
  assert.equal(projectFoxGoal([...initial(), invalidNamespace], native, todos).supported, false);
  const badEpoch = record("bad-entry", "control", { action: "revoke", epoch: "different-epoch" });
  assert.equal(projectFoxGoal([...initial(), badEpoch], native, todos).supported, false);
  assert.equal(projectFoxGoal([...initial(), { ...admission(1), id: "not:a:native:id" }], native, todos).supported, false);
});

test("new consent never refunds this conversation's daily notification receipts", () => {
  const entries = [...initial(), record("notice-one", "notification", { key: "native-one:outcome", day: "2026-11-11", at: "2026-11-11T10:01:00Z" }), record("revoke-one", "control", { action: "revoke" }),
    record("consent-two", "consent", { grantEntryId: "consent-two", epoch: "epoch-two", terms })];
  const snapshot = projectFoxGoal(entries, null, []);
  assert.equal(snapshot.grant.id, "consent-two");
  assert.deepEqual(snapshot.notifications, [{ key: "native-one:outcome", day: "2026-11-11", at: "2026-11-11T10:01:00Z" }]);
});

test("old received evidence cannot be reapproved after another mutating admission", () => {
  const entries = [...bound(), received(), record("review-first", "review", { review }), admission(2), record("second-closed", "settle", { admissionId: "admit-2", state: "closed" })];
  const snapshot = projectFoxGoal(entries, native, todos);
  assert.equal(snapshot.reviews[0].decision, "reject");
  assert.throws(() => validateFoxGoalReview(snapshot, review), /stale/);
});

test("user pause, native pause and expiry deny dispatch without refunding prior admissions", () => {
  const spent = [...initial(), admission(1), record("closed-one", "settle", { admissionId: "admit-1", state: "closed" })];
  const paused = [...spent, record("pause-one", "control", { action: "pause" })];
  assert.throws(() => dispatch(projectFoxGoal(paused, native, todos)), /paused/);
  const resumed = projectFoxGoal([...paused, record("resume-one", "control", { action: "resume" })], native, todos);
  assert.equal(resumed.dispatchesUsed, 1);
  assert.equal(dispatch(resumed).cwd, "/work/project");
  assert.throws(() => dispatch(projectFoxGoal(spent, { ...native, enabled: false, goal: { ...native.goal, status: "paused" } }, todos)), /not active/);
  const expired = initial();
  expired[0].data.terms = { ...terms, expiresAt: "2000-01-01T00:00:00Z" };
  assert.throws(() => dispatch(projectFoxGoal(expired, native, todos)), /expired/);
});

test("settled paused native absence proof releases an undelivered report batch without granting delivery", () => {
  const handoff = record("handoff-one", "handoff", { goalId: "native-one", batchId: "batch-one", reportIds: [report.id] });
  const entries = [...bound(), received(), handoff];
  assert.throws(() => resolveFoxGoalHandoff(entries, "handoff-one", { idle: false, pending: false, paused: true }), /settled|busy/);
  assert.throws(() => resolveFoxGoalHandoff(entries, "handoff-one", { idle: true, pending: false, paused: false }));
  const proof = resolveFoxGoalHandoff(entries, "handoff-one", { idle: true, pending: false, paused: true });
  assert.equal(proof.resolution, "not-delivered");
  entries.push(record("resolved-one", "handoff-resolve", { handoffEntryId: "handoff-one", ...proof }));
  const snapshot = projectFoxGoal(entries, native, todos);
  assert.equal(snapshot.supported, true);
  assert.equal(snapshot.handoffs[0].state, "not-delivered");
  assert.deepEqual(snapshot.handledReportIds, []);
  assert.notEqual(snapshot.recovery, "uncertain");
});

test("ambiguous turn admission after a handoff marker cannot be guessed not delivered", () => {
  const entries = [...bound(), received(), record("handoff-one", "handoff", { goalId: "native-one", batchId: "batch-one", reportIds: [report.id] }),
    { id: "assistant-after-marker", type: "message", message: { role: "assistant", content: [] } }];
  assert.throws(() => resolveFoxGoalHandoff(entries, "handoff-one", { idle: true, pending: false, paused: true }), /uncertain|admission/);
  assert.deepEqual(projectFoxGoal(entries, native, todos).handledReportIds, []);
});

test("durable handoff message proof resolves delivered once even after restart", () => {
  const entries = [...bound(), received(), record("handoff-one", "handoff", { goalId: "native-one", batchId: "batch-one", reportIds: [report.id] }),
    { id: "native-handoff", type: "custom_message", customType: "fox-goal-handoff", details: { handoffEntryId: "handoff-one", batchId: "batch-one", reportIds: [report.id] } }];
  assert.equal(resolveFoxGoalHandoff(entries, "handoff-one", { idle: true, pending: false, paused: true }).resolution, "delivered");
  assert.deepEqual(projectFoxGoal(entries, native, todos).handledReportIds, [report.id]);
});

test("durably confirmed unbound consent retains activation obligation without inventing a goal", () => {
  const snapshot = projectFoxGoal(initial().slice(0, 1), null, []);
  assert.equal(snapshot.grant.goalId, null);
  assert.equal(snapshot.goal, null);
  assert.equal(snapshot.recovery, "next");
});

test("replacement metadata must trace an exact revoked and settled prior grant", () => {
  const replacement = record("consent-two", "consent", { grantEntryId: "consent-two", epoch: "epoch-two", terms, replacesGoalId: "native-one" });
  assert.equal(projectFoxGoal([...initial(), replacement], native, todos).supported, false);
  const revoked = [...initial(), record("revoked-old", "control", { action: "revoke" })];
  assert.equal(projectFoxGoal([...revoked, replacement], native, todos).grant.replacesGoalId, "native-one");
  assert.equal(projectFoxGoal([...initial(), admission(1), record("revoked-old", "control", { action: "revoke" }), replacement], native, todos).supported, false);
  assert.equal(projectFoxGoal([...revoked, { ...replacement, data: { ...replacement.data, replacesGoalId: "unrelated-goal" } }], native, todos).supported, false);
});

test("verified continuation copies do not turn the same interrupted handoff into a second admission", () => {
  const entries = [...bound(), received(), record("handoff-one", "handoff", { goalId: "native-one", batchId: "batch-one", reportIds: [report.id] })];
  const proof = resolveFoxGoalHandoff([...entries, ...entries], "handoff-one", { idle: true, pending: false, paused: true });
  assert.equal(proof.resolution, "not-delivered");
});

test("a new genuine human status question and its native descendants do not poison handoff absence proof", () => {
  const entries = [...bound(), received(), record("handoff-one", "handoff", { goalId: "native-one", batchId: "batch-one", reportIds: [report.id] }),
    { id: "status-question", parentId: "handoff-one", type: "message", message: { role: "user", attribution: "user", content: "What is the status?" } },
    { id: "status-answer", parentId: "status-question", type: "message", message: { role: "assistant", content: [] } },
    { id: "status-read", parentId: "status-answer", type: "custom", customType: "tool_execution_start", data: { toolName: "read", toolCallId: "status-call" } },
    { id: "status-result", parentId: "status-read", type: "message", message: { role: "toolResult", toolName: "read", content: [] } }];
  assert.equal(resolveFoxGoalHandoff(entries, "handoff-one", { idle: true, pending: false, paused: true }).resolution, "not-delivered");
});

test("a later human question cannot erase earlier unexplained handoff turn evidence", () => {
  const entries = [...bound(), received(), record("handoff-one", "handoff", { goalId: "native-one", batchId: "batch-one", reportIds: [report.id] }),
    { id: "unknown-answer", parentId: "handoff-one", type: "message", message: { role: "assistant", content: [] } },
    { id: "status-question", parentId: "unknown-answer", type: "message", message: { role: "user", attribution: "user", content: "Status?" } }];
  assert.throws(() => resolveFoxGoalHandoff(entries, "handoff-one", { idle: true, pending: false, paused: true }), /uncertain/);
});

test("synthetic input and unrelated branch descendants cannot establish a human handoff boundary", () => {
  for (const kind of ["synthetic", "agent", "wrong-parent", "continuation", "same-batch"]) {
    const entries = [...bound(), received(), record("handoff-one", "handoff", { goalId: "native-one", batchId: "batch-one", reportIds: [report.id] }),
      { id: "status-question", parentId: "handoff-one", type: "message", message: { role: "user", attribution: kind === "agent" ? "agent" : "user", content: "Status?", ...(kind === "synthetic" ? { synthetic: true } : {}) } }];
    if (kind === "continuation") entries.push({ id: "auto-input", parentId: "status-question", type: "custom_message", customType: "goal-continuation", content: "Continue" });
    else if (kind === "same-batch") entries.push(record("correlated-admit", "admit", { handoffEntryId: "handoff-one", batchId: "batch-one" }));
    else entries.push({ id: "answer", parentId: kind === "wrong-parent" ? "handoff-one" : "status-question", type: "message", message: { role: "assistant", content: [] } });
    assert.throws(() => resolveFoxGoalHandoff(entries, "handoff-one", { idle: true, pending: false, paused: true }), /uncertain/);
  }
});
