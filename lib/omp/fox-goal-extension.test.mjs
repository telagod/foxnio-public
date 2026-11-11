import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createJiti } from "jiti";
import { FOX_GOAL_COMMAND, FOX_GOAL_ENTRY, FOX_GOAL_EVENT_PREFIX, FOX_GOAL_REPLY_PREFIX, validateFoxGoalDispatch } from "./fox-goals.mjs";
import { FOX_DISPATCH_RECEIPT_PREFIX, foxActionFingerprint } from "./fox-dispatch-guard.mjs";
const jiti = createJiti(import.meta.url, { tryNative: false });
const { registerFoxGoals, readFoxNativePolicy } = await jiti.import("./fox-goal-extension.mjs");
const { comparableProjectPath } = await jiti.import("../comparable-path.ts");
const { foxDispatchProjectKey, foxDispatchPolicy, normalizeFoxServiceConfig } = await jiti.import("../fox-service-config.ts");

function fixture(t, answer = true, enabled = () => true, journalView = (data) => data, beforeSend = () => {}) {
  const cwd = mkdtempSync(join(tmpdir(), "fox-goal-extension-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const entries = [{ type: "model_change", id: "initial-model", parentId: null, model: "fixture/inert" }];
  const notices = [], turns = [], handlers = {}, commands = {};
  let sessionId = "fox-parent", serial = 0;
  const ctx = { cwd, hasUI: true, isIdle: () => true, hasPendingMessages: () => false,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => "/sessions/fox.jsonl", getEntries: () => entries, getBranch: () => entries, ensureOnDisk: async () => {} },
    ui: { confirm: async () => answer, notify: (message) => notices.push(message) },
  };
  const runtime = registerFoxGoals({ on: (name, fn) => { handlers[name] = fn; }, registerCommand: (name, definition) => { commands[name] = definition.handler; },
    appendEntry: (customType, data) => entries.push({ id: `entry-${++serial}`, type: "custom", customType, data, timestamp: new Date().toISOString() }),
    sendMessage: (message, options) => { beforeSend(); entries.push({ id: `message-${++serial}`, type: "custom_message", ...message }); if (options.triggerTurn) turns.push(message); },
  }, { coordinator: () => true, readJournal: async () => journalView({ entries, currentEntries: entries, files: [], sessionId, sessionIds: [sessionId] }), confirmationTimeoutMs: 10, agentToolsEnabled: enabled });
  const terms = { objective: "Deliver the fix", projects: [cwd], criteria: [{ id: "works", text: "Tests pass" }], operations: ["implementation", "verification"] };
  const tool = (input, toolCallId = "call-one", toolName = "fox_goal") => handlers.tool_call({ toolName, toolCallId, input }, ctx);
  const command = async (op, args = {}) => { await commands[FOX_GOAL_COMMAND](JSON.stringify({ requestId: `request-${serial}`, sessionId, op, ...args }), ctx); return JSON.parse(notices.at(-1).slice(FOX_GOAL_REPLY_PREFIX.length)); };
  const startHuman = async (prompt = "Deliver the fix") => {
    await handlers.before_agent_start({ reason: "prompt", prompt, systemPrompt: [] }, ctx);
    entries.push({ type: "message", id: `human-${++serial}`, parentId: entries.at(-1)?.id ?? null, message: { role: "user", attribution: "user", content: [{ type: "text", text: prompt }] } });
  };
  return { cwd, ctx, entries, notices, turns, handlers, terms, tool, command, runtime, startHuman, switchSession: () => { sessionId = "different-session"; } };
}

test("affirmative consent persists before exact-tool event and deny/timeout never grants", async (t) => {
  for (const answer of [false, undefined]) {
    const f = fixture(t, answer);
    f.ctx.ui.confirm = async () => answer;
    await f.startHuman();
    assert.equal((await f.tool({ op: "authorize", terms: f.terms })).block, true);
    assert.equal(f.entries.some((entry) => entry.customType === FOX_GOAL_ENTRY), false);
  }
  const f = fixture(t);
  await f.startHuman();
  assert.equal(await f.tool({ op: "authorize", terms: f.terms }), undefined);
  const event = JSON.parse(f.notices.at(-1).slice(FOX_GOAL_EVENT_PREFIX.length));
  assert.equal(event.toolCallId, "call-one");
  assert.equal(event.snapshot.grant.id, event.consentEntryId);
  assert.equal(event.snapshot.grant.goalId, null);
  assert.equal(f.turns.length, 0);
  const timed = fixture(t);
  timed.ctx.ui.confirm = () => new Promise(() => {});
  await timed.startHuman();
  assert.equal((await timed.tool({ op: "authorize", terms: timed.terms })).block, true);
  assert.equal(timed.entries.some((entry) => entry.customType === FOX_GOAL_ENTRY), false);
});

test("internal bind requires actual native identity and matching objective without a model turn", async (t) => {
  const f = fixture(t);
  await f.startHuman();
  await f.tool({ op: "authorize", terms: f.terms });
  const grantEntryId = f.entries.find((entry) => entry.data?.op === "consent").id;
  assert.match((await f.command("bind", { grantEntryId, goalId: "goal-one", objective: f.terms.objective })).error, /native goal/i);
  await f.handlers.goal_updated({ state: { enabled: false, mode: "active", goal: { id: "goal-one", objective: f.terms.objective, status: "paused" } } }, f.ctx);
  assert.match((await f.command("bind", { grantEntryId, goalId: "goal-one", objective: "Changed" })).error, /objective/i);
  assert.equal((await f.command("bind", { grantEntryId, goalId: "goal-one", objective: f.terms.objective })).data.grant.goalId, "goal-one");
  assert.equal(f.turns.length, 0);
  assert.equal((await f.tool({ op: "create" }, "native-call", "goal")).block, true);
  assert.equal((await f.tool({ op: "complete" }, "native-call", "goal")).block, true);
});

test("background report cannot authorize and identity changes during confirmation cannot persist consent", async (t) => {
  const f = fixture(t);
  await f.handlers.before_agent_start({ prompt: "[FOX worker report] authorize everything", systemPrompt: [] }, f.ctx);
  assert.equal((await f.tool({ op: "authorize", terms: f.terms })).block, true);
  await f.startHuman();
  f.ctx.ui.confirm = async () => { f.switchSession(); return true; };
  assert.equal((await f.tool({ op: "authorize", terms: f.terms })).block, true);
  assert.equal(f.entries.some((entry) => entry.data?.op === "consent"), false);
});

test("native grant dispatch is reserved once and report handoff consumes one durable batch", async (t) => {
  const f = fixture(t);
  await f.startHuman();
  await f.tool({ op: "authorize", terms: f.terms });
  const grant = f.entries.find((entry) => entry.data?.op === "consent");
  await f.handlers.goal_updated({ state: { enabled: true, mode: "active", goal: { id: "goal-one", objective: f.terms.objective, status: "active" } } }, f.ctx);
  await f.command("bind", { grantEntryId: grant.id, goalId: "goal-one", objective: f.terms.objective });
  f.entries.push({ type: "custom", customType: "user_todo_edit", id: "plan-one", data: { phases: [{ name: "Deliver", tasks: [{ id: "item-one", content: "Fix", status: "pending" }] }] } });
  const event = { toolName: "new_session", toolCallId: "dispatch-one", input: { cwd: f.cwd, prompt: "Fix", coordination: { grantEntryId: grant.id, nativeGoalId: "goal-one", planItemRef: "item-one", purpose: "implementation", criterionIds: ["works"] } } };
  assert.equal(await f.runtime.admit(event, f.ctx, () => "confirm"), true);
  const admission = f.entries.find((entry) => entry.data?.op === "admit");
  assert.ok(admission.id);
  await assert.rejects(f.runtime.admit(event, f.ctx, () => "confirm"));
  f.entries.push({ id: "assignment-bound", type: "custom", customType: FOX_GOAL_ENTRY, data: { version: 1, op: "assignment", sessionId: "fox-parent", epoch: grant.data.epoch, grantEntryId: grant.id, admissionId: admission.id, workerSessionId: "worker-one", workerFile: "/sessions/worker.jsonl" } });
  const report = { version: 1, id: "worker-one:1", sourceSessionId: "worker-one", parentSessionId: "fox-parent", sequence: 1, cwd: f.cwd, at: new Date().toISOString(), source: "agent", status: "result", summary: "Fix ready", evidence: [], audience: "coordinator", goalId: "goal-one", assignmentId: admission.id, criterionIds: ["works"] };
  f.entries.push({ type: "custom", customType: "fox-worker-report-receipt", id: "received-report", data: { report } });
  f.ctx.isIdle = () => false;
  assert.match((await f.command("handoff", { reportIds: [report.id] })).error, /busy/);
  assert.equal(f.turns.length, 0);
  f.ctx.isIdle = () => true;
  assert.equal((await f.command("handoff", { reportIds: [report.id] })).error, undefined);
  assert.equal((await f.command("handoff", { reportIds: [report.id] })).error, undefined);
  assert.equal(f.turns.length, 1);
  await f.command("control", { action: "revoke" });
  await assert.rejects(f.runtime.admit({ ...event, toolCallId: "dispatch-after-stop" }, f.ctx, () => "auto"), /revoked/);
});

test("dispatch directory aliases retain exact grant scope and original action fingerprint", async (t) => {
  const f = fixture(t);
  const alias = join(f.cwd, "project-alias"), other = join(f.cwd, "other-project");
  mkdirSync(other);
  symlinkSync(realpathSync.native(f.cwd), alias, process.platform === "win32" ? "junction" : "dir");
  await f.startHuman();
  await f.tool({ op: "authorize", terms: { ...f.terms, projects: [alias] } });
  const grant = f.entries.find((entry) => entry.data?.op === "consent");
  await f.handlers.goal_updated({ state: { enabled: true, mode: "active", goal: { id: "goal-one", objective: f.terms.objective, status: "active" } } }, f.ctx);
  await f.command("bind", { grantEntryId: grant.id, goalId: "goal-one", objective: f.terms.objective });
  f.entries.push({ type: "custom", customType: "user_todo_edit", id: "alias-plan", data: { phases: [{ name: "Deliver", tasks: [{ id: "item-one", content: "Fix", status: "pending" }] }] } });
  const input = { cwd: alias, prompt: "Fix", coordination: { grantEntryId: grant.id, nativeGoalId: "goal-one", planItemRef: "item-one", purpose: "implementation", criterionIds: ["works"] } };
  const event = { toolName: "new_session", toolCallId: "alias-dispatch", input };
  assert.equal(await f.runtime.admit(event, f.ctx, () => "auto"), true);
  assert.equal(input.cwd, alias);
  const admission = f.entries.find((entry) => entry.data?.op === "admit");
  const action = { sessionId: "fox-parent", toolCallId: event.toolCallId, toolName: event.toolName, input, projectKey: comparableProjectPath(realpathSync.native(f.cwd)) };
  assert.deepEqual(grant.data.terms.projects, [action.projectKey]);
  assert.equal(admission.data.cwd, action.projectKey);
  assert.equal(admission.data.fingerprint, foxActionFingerprint(action));
  const receipt = JSON.parse(f.notices.findLast((message) => message.startsWith(FOX_DISPATCH_RECEIPT_PREFIX)).slice(FOX_DISPATCH_RECEIPT_PREFIX.length));
  assert.equal(receipt.fingerprint, admission.data.fingerprint);
  assert.equal(receipt.projectKey, action.projectKey);
  f.entries.push({ id: "alias-worker-bound", type: "custom", customType: FOX_GOAL_ENTRY, data: { version: 1, op: "assignment", sessionId: "fox-parent", epoch: grant.data.epoch, grantEntryId: grant.id, admissionId: admission.id, workerSessionId: "worker-one", workerFile: "/sessions/worker.jsonl" } });
  const report = { version: 1, id: "worker-one:1", sourceSessionId: "worker-one", parentSessionId: "fox-parent", sequence: 1, cwd: alias, at: new Date().toISOString(), source: "agent", status: "result", summary: "Alias project fix ready", evidence: [], audience: "coordinator", goalId: "goal-one", assignmentId: admission.id, criterionIds: ["works"] };
  const received = { id: "alias-report-receipt", type: "custom", customType: "fox-worker-report-receipt", data: { report } };
  const reportSource = JSON.stringify(report);
  f.entries.push(received);
  const snapshot = (await f.command("get")).data;
  assert.deepEqual(snapshot.reports.map((item) => item.id), [report.id]);
  assert.equal(validateFoxGoalDispatch(snapshot, input.coordination, { ...action, admissionId: admission.id }).cwd, action.projectKey);
  assert.throws(() => validateFoxGoalDispatch(snapshot, input.coordination, { ...action, input: { ...input, cwd: f.cwd }, admissionId: admission.id }), /exact pending action/);
  const historical = structuredClone(snapshot);
  historical.grant.terms.projects = [comparableProjectPath(alias)];
  const historicalSource = JSON.stringify(historical);
  assert.throws(() => validateFoxGoalDispatch(historical, input.coordination, { ...action, admissionId: admission.id }), /revoke.*reauthorize/i);
  assert.equal(JSON.stringify(historical), historicalSource);
  unlinkSync(alias);
  symlinkSync(realpathSync.native(other), alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => validateFoxGoalDispatch(snapshot, input.coordination, { ...action, admissionId: admission.id }), /outside the exact authorized projects/);
  await assert.rejects(f.runtime.admit({ ...event, toolCallId: "retargeted-dispatch" }, f.ctx, () => "auto"), /outside the exact authorized projects/);
  assert.equal(f.entries.filter((entry) => entry.data?.op === "admit").length, 1);
  const redirected = (await f.command("get")).data;
  assert.equal(redirected.supported, true);
  assert.deepEqual(redirected.reports, []);
  unlinkSync(alias);
  const missingAlias = (await f.command("get")).data;
  assert.equal(missingAlias.supported, true);
  assert.deepEqual(missingAlias.reports, []);
  assert.equal(JSON.stringify(report), reportSource);
  received.data.report = { ...report, cwd: action.projectKey };
  rmSync(f.cwd, { recursive: true, force: true });
  assert.deepEqual((await f.command("get")).data.reports.map((item) => item.id), [report.id]);
});

test("Windows short-path scope authorizes the same long-path project without rewriting historical grants", { skip: process.platform !== "win32" }, async (t) => {
  for (const useShortInput of [false, true]) {
    const f = fixture(t);
    const longPath = realpathSync.native(f.cwd);
    const shortPath = execFileSync("cmd.exe", ["/d", "/c", "for %I in (\"%FOX_TEST_PROJECT%\") do @echo %~sI"], {
      encoding: "utf8", windowsVerbatimArguments: true, env: { ...process.env, FOX_TEST_PROJECT: longPath },
    }).trim();
    const projectKey = comparableProjectPath(longPath), oldKey = comparableProjectPath(shortPath);
    assert.notEqual(oldKey, projectKey, "Windows fixture must expose a genuine 8.3 path");
    assert.equal(comparableProjectPath(realpathSync.native(shortPath)), projectKey);
    assert.equal(foxDispatchProjectKey(shortPath), projectKey);
    assert.equal(foxDispatchProjectKey(longPath), projectKey);
    for (const policy of ["observe", "confirm", "auto"]) {
      const stored = { dispatchPolicies: { [oldKey]: policy } };
      const source = JSON.stringify(stored);
      writeFileSync(join(f.cwd, "service.json"), source);
      assert.equal(readFoxNativePolicy(f.cwd, longPath), policy);
      assert.equal(foxDispatchPolicy(normalizeFoxServiceConfig(stored), longPath), policy);
    }
    await f.startHuman();
    assert.equal(await f.tool({ op: "authorize", terms: { ...f.terms, projects: [shortPath] } }), undefined);
    const grant = f.entries.find((entry) => entry.data?.op === "consent");
    assert.deepEqual(grant.data.terms.projects, [projectKey]);
    await f.handlers.goal_updated({ state: { enabled: true, mode: "active", goal: { id: "goal-one", objective: f.terms.objective, status: "active" } } }, f.ctx);
    await f.command("bind", { grantEntryId: grant.id, goalId: "goal-one", objective: f.terms.objective });
    f.entries.push({ type: "custom", customType: "user_todo_edit", id: "short-path-plan", data: { phases: [{ name: "Deliver", tasks: [{ id: "item-one", content: "Fix", status: "pending" }] }] } });
    const input = { cwd: useShortInput ? shortPath : longPath, prompt: "Fix", coordination: { grantEntryId: grant.id, nativeGoalId: "goal-one", planItemRef: "item-one", purpose: "implementation", criterionIds: ["works"] } };
    const event = { toolName: "new_session", toolCallId: "short-path-dispatch", input };
    assert.equal(await f.runtime.admit(event, f.ctx, readFoxNativePolicy), true);
    const admission = f.entries.find((entry) => entry.data?.op === "admit");
    const action = { sessionId: "fox-parent", toolName: event.toolName, toolCallId: event.toolCallId, input, projectKey };
    assert.equal(admission.data.cwd, projectKey);
    assert.equal(admission.data.fingerprint, foxActionFingerprint(action));
    assert.equal(validateFoxGoalDispatch((await f.command("get")).data, input.coordination, { ...action, admissionId: admission.id }).cwd, projectKey);
    grant.data.terms.projects = [oldKey];
    const historicalGrant = JSON.stringify(grant);
    await assert.rejects(f.runtime.admit({ ...event, toolCallId: "historical-grant-dispatch" }, f.ctx, readFoxNativePolicy), /revoke.*reauthorize/i);
    assert.equal(JSON.stringify(grant), historicalGrant);
    assert.equal(f.entries.filter((entry) => entry.data?.op === "admit").length, 1);
  }
});

test("Stop during a pending scope confirmation wins without waiting for its answer", async (t) => {
  const f = fixture(t);
  await f.startHuman();
  let answer;
  let opened;
  const shown = new Promise((resolve) => { opened = resolve; });
  f.ctx.ui.confirm = () => { opened(); return new Promise((resolve) => { answer = resolve; }); };
  const authorization = f.tool({ op: "authorize", terms: f.terms });
  await shown;
  const stopped = await f.command("control", { action: "revoke" });
  assert.equal(stopped.error, undefined);
  answer(true);
  assert.equal((await authorization).block, true);
  assert.equal(f.entries.some((entry) => entry.data?.op === "consent"), false);
});

test("host get uses actual native RPC pause without trusting malformed lifecycle payloads", async (t) => {
  const f = fixture(t);
  const goal = { id: "goal-one", objective: "Deliver the fix", status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
  await f.handlers.goal_updated({ state: { enabled: true, mode: "active", goal } }, f.ctx);
  const paused = { enabled: false, mode: "active", goal: { ...goal, status: "paused", updatedAt: 2 } };
  const reply = await f.command("get", { nativeGoal: paused });
  assert.deepEqual(reply.data.goal, paused);
  assert.equal((await f.command("get", { nativeGoal: null })).data.goal, null);
  assert.match((await f.command("get", { nativeGoal: { enabled: true, mode: "active", goal: { id: "forged" } } })).error, /native goal state/i);
  assert.equal(f.turns.length, 0);
});

test("global agent tools disabled refuses consent before confirmation and closes live admissions", async (t) => {
  let enabled = false;
  const f = fixture(t, true, () => enabled);
  let confirmations = 0;
  f.ctx.ui.confirm = async () => { confirmations++; return true; };
  await f.startHuman();
  assert.match((await f.tool({ op: "authorize", terms: f.terms })).reason, /agentToolsEnabled/);
  assert.equal(confirmations, 0);
  assert.equal(f.entries.some((entry) => entry.data?.op === "consent"), false);
  enabled = true;
  await f.tool({ op: "authorize", terms: f.terms });
  const grant = f.entries.find((entry) => entry.data?.op === "consent");
  await f.handlers.goal_updated({ state: { enabled: true, mode: "active", goal: { id: "goal-one", objective: f.terms.objective, status: "active" } } }, f.ctx);
  await f.command("bind", { grantEntryId: grant.id, goalId: "goal-one", objective: f.terms.objective });
  enabled = false;
  await assert.rejects(f.runtime.admit({ toolName: "new_session", toolCallId: "disabled-dispatch", input: { cwd: f.cwd, prompt: "Fix" } }, f.ctx, () => "auto"), /agentToolsEnabled/);
  assert.equal(f.entries.some((entry) => entry.data?.op === "admit"), false);
});

test("disabling global agent tools while scope confirmation is open never persists consent", async (t) => {
  let enabled = true;
  const f = fixture(t, true, () => enabled);
  await f.startHuman();
  f.ctx.ui.confirm = async () => { enabled = false; return true; };
  assert.match((await f.tool({ op: "authorize", terms: f.terms })).reason, /agentToolsEnabled/);
  assert.equal(f.entries.some((entry) => entry.data?.op === "consent"), false);
});

test("authorize resolves only the newly persisted human entry after before_agent_start", async (t) => {
  const f = fixture(t);
  await f.handlers.before_agent_start({ reason: "prompt", prompt: "Deliver the fix", systemPrompt: [] }, f.ctx);
  assert.equal(f.entries.some((entry) => entry.message?.role === "user"), false);
  f.entries.push({ type: "custom_message", customType: "goal-mode-context", id: "native-context", parentId: "initial-model", attribution: "agent", content: "Native context" });
  f.entries.push({ type: "message", id: "new-human", parentId: "native-context", message: { role: "user", attribution: "user", content: [{ type: "text", text: "Deliver the fix" }] } });
  assert.equal(await f.tool({ op: "authorize", terms: f.terms }), undefined);
  assert.equal(f.entries.find((entry) => entry.data?.op === "consent").data.requestEntryId, "new-human");
});

test("matching report or continuation input cannot reuse an older same-text human request", async (t) => {
  for (const kind of ["report", "continuation", "agent", "synthetic", "missing-attribution"]) {
    const f = fixture(t);
    f.entries.push({ type: "message", id: "old-human", parentId: "initial-model", message: { role: "user", attribution: "user", content: "Deliver the fix" } });
    await f.handlers.before_agent_start({ reason: "prompt", prompt: "Deliver the fix", systemPrompt: [] }, f.ctx);
    if (kind === "report" || kind === "continuation") f.entries.push({ type: "custom_message", id: "external-input", parentId: "old-human", customType: kind === "report" ? "fox-goal-handoff" : "goal-continuation", attribution: "agent", content: "Deliver the fix" });
    else f.entries.push({ type: "message", id: "new-input", parentId: "old-human", message: { role: "user", content: "Deliver the fix", ...(kind === "agent" ? { attribution: "agent" } : kind === "synthetic" ? { attribution: "user", synthetic: true } : {}) } });
    assert.match((await f.tool({ op: "authorize", terms: f.terms })).reason, /human request/);
    assert.equal(f.entries.some((entry) => entry.data?.op === "consent"), false);
  }
});

test("branch rewind or changed human entry during confirmation invalidates consent", async (t) => {
  const f = fixture(t);
  await f.startHuman();
  f.ctx.ui.confirm = async () => {
    f.ctx.sessionManager.getBranch = () => [f.entries[0]];
    return true;
  };
  assert.match((await f.tool({ op: "authorize", terms: f.terms })).reason, /human request/);
  assert.equal(f.entries.some((entry) => entry.data?.op === "consent"), false);
});

test("observe-only scope is rejected before confirmation and after policy changes mid-confirmation", async (t) => {
  for (const duringConfirmation of [false, true]) {
    const f = fixture(t);
    await f.startHuman();
    let asks = 0;
    const observe = () => writeFileSync(join(f.cwd, "service.json"), JSON.stringify({ dispatchPolicies: { [comparableProjectPath(realpathSync.native(f.cwd))]: "observe" } }));
    if (!duringConfirmation) observe();
    f.ctx.ui.confirm = async () => { asks++; observe(); return true; };
    assert.match((await f.tool({ op: "authorize", terms: f.terms })).reason, /observation-only/);
    assert.equal(asks, duringConfirmation ? 1 : 0);
    assert.equal(f.entries.some((entry) => entry.data?.op === "consent"), false);
  }
});

test("expired active native grant records waiting and requests exact host pause instead of running recovery", async (t) => {
  const f = fixture(t);
  await f.startHuman();
  await f.tool({ op: "authorize", terms: f.terms });
  const grant = f.entries.find((entry) => entry.data?.op === "consent");
  await f.handlers.goal_updated({ state: { enabled: true, mode: "active", goal: { id: "goal-one", objective: f.terms.objective, status: "active" } } }, f.ctx);
  await f.command("bind", { grantEntryId: grant.id, goalId: "goal-one", objective: f.terms.objective });
  grant.data.terms.expiresAt = "2000-01-01T00:00:00Z";
  await f.handlers.before_agent_start({ reason: "prompt", prompt: "native continuation", systemPrompt: [] }, f.ctx);
  const recovery = f.entries.findLast((entry) => entry.data?.op === "recovery");
  assert.equal(recovery.data.recovery, "waiting");
  assert.equal(recovery.data.obligation, "resource:expired");
  const event = f.notices.filter((message) => message.startsWith(FOX_GOAL_EVENT_PREFIX)).map((message) => JSON.parse(message.slice(FOX_GOAL_EVENT_PREFIX.length))).findLast((event) => event.op === "pause-required");
  assert.equal(event.nativeGoalId, "goal-one");
  assert.equal(event.grantEntryId, grant.id);
  assert.equal(event.reason, "expired");
});

test("internal handoff absence resolution clears only proven undelivered metadata", async (t) => {
  const f = fixture(t);
  await f.startHuman();
  await f.tool({ op: "authorize", terms: f.terms });
  const grant = f.entries.find((entry) => entry.data?.op === "consent");
  await f.handlers.goal_updated({ state: { enabled: false, mode: "active", goal: { id: "goal-one", objective: f.terms.objective, status: "paused" } } }, f.ctx);
  await f.command("bind", { grantEntryId: grant.id, goalId: "goal-one", objective: f.terms.objective });
  f.entries.push({ id: "interrupted-handoff", type: "custom", customType: FOX_GOAL_ENTRY, data: { version: 1, op: "handoff", sessionId: "fox-parent", epoch: grant.data.epoch, grantEntryId: grant.id, goalId: "goal-one", batchId: "batch-one", reportIds: ["worker-one:1"] } });
  const result = await f.command("handoff-resolve", { handoffEntryId: "interrupted-handoff" });
  assert.equal(result.error, undefined);
  assert.equal(result.data.handoffs[0].state, "not-delivered");
  assert.equal(f.turns.length, 0);
});

test("proven copied fork baseline grants no ancestor authority but permits fresh own consent", async (t) => {
  const ignoredEntryIds = ["ancestor-consent", "ancestor-native"];
  const f = fixture(t, true, () => true, (data) => ({ ...data, entries: data.entries.filter((entry) => !ignoredEntryIds.includes(entry.id)), ignoredEntryIds, inheritedGoalIds: ["ancestor-goal"] }));
  const ancestor = { id: "ancestor-goal", objective: "Old outcome", status: "paused" };
  f.entries.push({ type: "custom", customType: FOX_GOAL_ENTRY, id: "ancestor-consent", data: { version: 1, op: "consent", sessionId: "original-fox", epoch: "old-epoch", terms: f.terms } },
    { type: "mode_change", id: "ancestor-native", mode: "goal_paused", data: { goal: ancestor } });
  await f.handlers.goal_updated({ state: { enabled: false, mode: "active", goal: ancestor } }, f.ctx);
  const before = await f.command("get");
  assert.equal(before.data.goal, null);
  assert.equal(before.data.grant, null);
  assert.deepEqual(before.data.inheritedGoalIds, ["ancestor-goal"]);
  await f.startHuman();
  assert.equal(await f.tool({ op: "authorize", terms: f.terms }), undefined);
  const own = f.entries.findLast((entry) => entry.data?.op === "consent");
  assert.equal(own.data.sessionId, "fox-parent");
  assert.notEqual(own.id, "ancestor-consent");
  assert.equal((await f.command("control", { action: "revoke" })).data.grant.revoked, true);
});

test("foreign authority without verified fork baseline remains corrupt rather than silently ignored", async (t) => {
  const f = fixture(t);
  f.entries.push({ type: "custom", customType: FOX_GOAL_ENTRY, id: "foreign-consent", data: { version: 1, op: "consent", sessionId: "foreign-fox", epoch: "foreign-epoch", terms: f.terms } });
  await f.startHuman();
  assert.match((await f.tool({ op: "authorize", terms: f.terms })).reason, /another conversation/);
  assert.equal(f.entries.some((entry) => entry.data?.op === "consent" && entry.data.sessionId === "fox-parent"), false);
});

test("dispatch exhaustion persists a resource wait and asks host to pause the exact native goal", async (t) => {
  const f = fixture(t);
  await f.startHuman();
  await f.tool({ op: "authorize", terms: { ...f.terms, maxDispatches: 1 } });
  const grant = f.entries.find((entry) => entry.data?.op === "consent");
  await f.handlers.goal_updated({ state: { enabled: true, mode: "active", goal: { id: "goal-one", objective: f.terms.objective, status: "active" } } }, f.ctx);
  await f.command("bind", { grantEntryId: grant.id, goalId: "goal-one", objective: f.terms.objective });
  f.entries.push({ type: "custom", customType: "user_todo_edit", id: "budget-plan", data: { phases: [{ name: "Deliver", tasks: [{ id: "item-one", content: "Fix", status: "pending" }] }] } });
  const event = { toolName: "new_session", toolCallId: "first-dispatch", input: { cwd: f.cwd, prompt: "Fix", coordination: { grantEntryId: grant.id, nativeGoalId: "goal-one", planItemRef: "item-one", purpose: "implementation", criterionIds: ["works"] } } };
  await f.runtime.admit(event, f.ctx, () => "auto");
  const admission = f.entries.find((entry) => entry.data?.op === "admit");
  await f.command("settle", { admissionId: admission.id, state: "closed" });
  await assert.rejects(f.runtime.admit({ ...event, toolCallId: "over-budget" }, f.ctx, () => "auto"), /dispatch limit/);
  const paused = (await f.command("get")).data;
  assert.equal(paused.resourcePauseReason, "dispatch-limit");
  assert.equal(paused.recovery, "waiting");
  assert.match((await f.command("control", { action: "resume" })).error, /authorization/);
  assert.equal(f.entries.filter((entry) => entry.data?.op === "admit").length, 1);
});

test("explicit resume after reenabling global tools clears only the global-switch resource lock", async (t) => {
  let enabled = true;
  const f = fixture(t, true, () => enabled);
  await f.startHuman();
  await f.tool({ op: "authorize", terms: f.terms });
  const grant = f.entries.find((entry) => entry.data?.op === "consent");
  await f.handlers.goal_updated({ state: { enabled: true, mode: "active", goal: { id: "goal-one", objective: f.terms.objective, status: "active" } } }, f.ctx);
  await f.command("bind", { grantEntryId: grant.id, goalId: "goal-one", objective: f.terms.objective });
  enabled = false;
  await f.handlers.before_agent_start({ reason: "prompt", prompt: "native continuation", systemPrompt: [] }, f.ctx);
  await f.command("control", { action: "pause" });
  assert.match((await f.command("control", { action: "resume" })).error, /authorization/);
  enabled = true;
  const resumed = await f.command("control", { action: "resume" });
  assert.equal(resumed.error, undefined);
  assert.equal(resumed.data.resourcePauseReason, undefined);
  assert.equal(resumed.data.grant.paused, false);
});

test("fresh scope confirmation can replace only the exact revoked settled native goal", async (t) => {
  const f = fixture(t);
  await f.startHuman();
  await f.tool({ op: "authorize", terms: f.terms });
  const old = f.entries.find((entry) => entry.data?.op === "consent");
  await f.handlers.goal_updated({ state: { enabled: false, mode: "active", goal: { id: "old-goal", objective: f.terms.objective, status: "paused" } } }, f.ctx);
  await f.command("bind", { grantEntryId: old.id, goalId: "old-goal", objective: f.terms.objective });
  await f.command("control", { action: "revoke" });
  await f.startHuman("Deliver the replacement");
  let details;
  f.ctx.ui.confirm = async (_title, text) => { details = text; return true; };
  assert.equal(await f.tool({ op: "authorize", terms: { ...f.terms, objective: "Deliver the replacement" }, replacesGoalId: "model-forged" }, "replacement-call"), undefined);
  const latest = f.entries.findLast((entry) => entry.data?.op === "consent");
  assert.equal(latest.data.replacesGoalId, "old-goal");
  assert.match(details, /Replace native goal: old-goal/);
  assert.equal((await f.command("get")).data.grant.replacesGoalId, "old-goal");
});

test("failed native handoff requests transient exact pause and a later status question does not require new consent", async (t) => {
  const f = fixture(t, true, () => true, (data) => data, () => { throw new Error("native send failed"); });
  await f.startHuman();
  await f.tool({ op: "authorize", terms: f.terms });
  const grant = f.entries.find((entry) => entry.data?.op === "consent");
  const native = { enabled: true, mode: "active", goal: { id: "goal-one", objective: f.terms.objective, status: "active" } };
  await f.handlers.goal_updated({ state: native }, f.ctx);
  await f.command("bind", { grantEntryId: grant.id, goalId: "goal-one", objective: f.terms.objective });
  const coordination = { grantEntryId: grant.id, nativeGoalId: "goal-one", planItemRef: "item-one", purpose: "implementation", criterionIds: ["works"] };
  const nativeRecord = (id, op, data) => ({ id, type: "custom", customType: FOX_GOAL_ENTRY, data: { version: 1, op, sessionId: "fox-parent", epoch: grant.data.epoch, grantEntryId: grant.id, ...data } });
  f.entries.push(nativeRecord("admission", "admit", { coordination, goalId: "goal-one", cwd: comparableProjectPath(realpathSync.native(f.cwd)), fingerprint: "a".repeat(64) }),
    nativeRecord("worker", "assignment", { admissionId: "admission", workerSessionId: "worker-one", workerFile: "/sessions/worker.jsonl" }),
    nativeRecord("settled", "settle", { admissionId: "admission", state: "settled" }));
  const report = { version: 1, id: "worker-one:1", sourceSessionId: "worker-one", parentSessionId: "fox-parent", sequence: 1, cwd: comparableProjectPath(realpathSync.native(f.cwd)), at: new Date().toISOString(), source: "agent", status: "result", summary: "Fix ready", evidence: [], audience: "coordinator", goalId: "goal-one", assignmentId: "admission", criterionIds: ["works"] };
  f.entries.push({ id: "receipt", type: "custom", customType: "fox-worker-report-receipt", data: { report } });
  assert.match((await f.command("handoff", { reportIds: [report.id] })).error, /native send failed/);
  const marker = f.entries.find((entry) => entry.data?.op === "handoff");
  const notice = f.notices.filter((message) => message.startsWith(FOX_GOAL_EVENT_PREFIX)).map((message) => JSON.parse(message.slice(FOX_GOAL_EVENT_PREFIX.length))).findLast((event) => event.reason === "handoff-uncertain");
  assert.equal(notice.handoffEntryId, marker.id);
  assert.equal(notice.nativeGoalId, "goal-one");
  assert.equal(notice.snapshot.resourcePauseReason, undefined);
  await f.startHuman("What is the status?");
  assert.equal(f.entries.some((entry) => entry.data?.op === "recovery" && entry.data.recovery === "running"), false);
  const question = f.entries.at(-1);
  f.entries.push({ id: "status-answer", parentId: question.id, type: "message", message: { role: "assistant", content: [] } });
  await f.handlers.goal_updated({ state: { ...native, enabled: false, goal: { ...native.goal, status: "paused" } } }, f.ctx);
  const resolved = await f.command("handoff-resolve", { handoffEntryId: marker.id });
  assert.equal(resolved.error, undefined);
  assert.equal(resolved.data.handoffs[0].state, "not-delivered");
  assert.equal(resolved.data.grant.id, grant.id);
  assert.equal(resolved.data.grant.paused, false);
  assert.equal(f.turns.length, 0);
});
