import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "fox-goal-host-"));
process.env.PI_CODING_AGENT_DIR = root;
const jiti = createJiti(import.meta.url);
const { AgentSessionWrapper, startRpcSession } = await jiti.import("./rpc-manager.ts");
const { foxWorkspaceDir } = await jiti.import("./fox-workspace.ts");
const { getTodoPhasesFromEntries } = await jiti.import("./session-context.ts");
const { projectFoxGoal } = await import("./omp/fox-goals.mjs");
const { shouldRecoverFoxGoal, invalidateFoxGoalPolicy, controlFoxGoal } = await jiti.import("./fox-goal-service.ts");
const { saveWebServerSettings } = await jiti.import("./web-settings.ts");
const { writeFoxSessionId, clearFoxSessionId } = await jiti.import("./fox-session.ts");
mkdirSync(foxWorkspaceDir(), { recursive: true });
test.after(() => { globalThis.__ompNotificationStore?.db.close(); rmSync(root, { recursive: true, force: true }); });

function runtime(t, send) {
  const listeners = new Set();
  const frames = [];
  const file = join(root, `session-${Math.random()}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "fox", cwd: foxWorkspaceDir() }) + "\n");
  const state = { sessionId: "fox", sessionFile: file, isStreaming: false, isCompacting: false, isSettled: true, queuedMessageCount: 0, todoPhases: [] };
  const emit = (frame) => { for (const listener of listeners) listener(frame); };
  const commands = [];
  const proc = { isAlive: true, onFrame(fn) { listeners.add(fn); return () => listeners.delete(fn); }, sendFrame(frame) { frames.push(frame); }, dispose: async () => {},
    async sendCommand(command) {
      commands.push(command);
      if (command.type === "get_state") return state;
      if (command.type === "get_available_commands") return { commands: [{ name: "omp-web-fox-goal", source: "extension" }, { name: "omp-web-fox-report", source: "extension" }] };
      return send?.(command, emit, state) ?? {};
    },
  };
  const wrapper = new AgentSessionWrapper(proc, foxWorkspaceDir(), null, "inherit", "fox", 0);
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());
  return { wrapper, state, commands, frames, emit };
}

test("native todo projection retains exact native item and phase identity", () => {
  assert.deepEqual(getTodoPhasesFromEntries([{ type: "custom", id: "plan", parentId: null, customType: "user_todo_edit", data: { phases: [{ id: "phase-1", name: "Ship", tasks: [{ id: "item-1", content: "Verify", status: "blocked", blocker: "assignment-1" }] }] } }]), [{ id: "phase-1", name: "Ship", tasks: [{ id: "item-1", content: "Verify", status: "blocked", blocker: "assignment-1" }] }]);
});

test("authorization without a native confirmation event cannot create a goal", async (t) => {
  const r = runtime(t);
  await r.wrapper.send({ type: "get_state" });
  r.emit({ type: "host_tool_call", id: "host-call", toolCallId: "model-call", toolName: "fox_goal", arguments: { op: "authorize", terms: { objective: "forged" } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.frames.at(-1)?.isError, true);
  assert.equal(r.commands.some((c) => c.type === "goal"), false);
});

test("internal native command correlates reply while a model host tool is pending", async (t) => {
  const r = runtime(t, (command, emit) => {
    if (command.type !== "prompt") return {};
    const payload = JSON.parse(command.message.slice(command.message.indexOf(" ") + 1));
    emit({ type: "extension_ui_request", method: "notify", message: `foxnio:goal-reply:${JSON.stringify({ requestId: "stale", sessionId: "fox", data: {} })}` });
    emit({ type: "extension_ui_request", method: "notify", message: `foxnio:goal-reply:${JSON.stringify({ requestId: payload.requestId, sessionId: "fox", data: projectFoxGoal([]) })}` });
    return { agentInvoked: false };
  });
  await r.wrapper.send({ type: "get_state" });
  r.emit({ type: "agent_start" });
  const result = await r.wrapper.foxGoalCommand("get");
  assert.equal(result.grant, null);
  assert.equal(r.wrapper.isRunning(), true, "metadata command does not clear the pending model turn");
});

test("internal native command rejects a reply for a different conversation", async (t) => {
  const r = runtime(t, (command, emit) => {
    if (command.type !== "prompt") return {};
    const payload = JSON.parse(command.message.slice(command.message.indexOf(" ") + 1));
    emit({ type: "extension_ui_request", method: "notify", message: `foxnio:goal-reply:${JSON.stringify({ requestId: payload.requestId, sessionId: "other", data: projectFoxGoal([]) })}` });
    return {};
  });
  await r.wrapper.send({ type: "get_state" });
  await assert.rejects(r.wrapper.foxGoalCommand("get"), /identity|conversation/i);
});

test("recovery never retries unknown delivery, user pause, native limits, or awaiting-event", () => {
  const snapshot = { ...projectFoxGoal([]), supported: true, grant: { id: "g", goalId: "n", revoked: false, paused: false, terms: { objective: "deliver" } }, goal: { enabled: true, mode: "paused", goal: { id: "n", objective: "deliver", status: "paused", tokensUsed: 0 } }, recovery: "next", assignments: [] };
  assert.equal(shouldRecoverFoxGoal(snapshot), true);
  assert.equal(shouldRecoverFoxGoal({ ...snapshot, recovery: "waiting" }), false);
  assert.equal(shouldRecoverFoxGoal({ ...snapshot, grant: { ...snapshot.grant, paused: true } }), false);
  assert.equal(shouldRecoverFoxGoal({ ...snapshot, assignments: [{ state: "uncertain" }] }), false);
  assert.equal(shouldRecoverFoxGoal({ ...snapshot, goal: { ...snapshot.goal, reason: "token_budget" } }), false);
});

test("handoff refuses busy or queued user work without issuing a prompt", async (t) => {
  const r = runtime(t);
  await r.wrapper.send({ type: "get_state" });
  r.state.queuedMessageCount = 1;
  await assert.rejects(r.wrapper.foxGoalCommand("handoff", { reportIds: ["report"] }), /busy|pending/i);
  assert.equal(r.commands.some((c) => c.type === "prompt"), false);
});

test("native goal state is forwarded without inventing enabled or budget values", async (t) => {
  const r = runtime(t);
  const goal = { enabled: false, mode: "active", goal: { id: "goal", objective: "deliver", status: "paused", tokenBudget: 500, tokensUsed: 48, timeUsedSeconds: 2, createdAt: 1, updatedAt: 2 } };
  r.emit({ type: "goal_updated", goal: goal.goal, state: goal });
  assert.deepEqual((await r.wrapper.send({ type: "get_state" })).goal, goal);
});

test("Stop immediately rejects an admission reserved before the control", async (t) => {
  const r = runtime(t);
  r.wrapper.closeFoxGoalAdmission();
  await assert.rejects(r.wrapper.recheckFoxGoalDispatch({ admissionId: "admitted-before-stop" }), /closed before the side effect/);
  assert.equal(r.commands.length, 0);
});

test("native control transport is not reachable through an ordinary prompt", async (t) => {
  const r = runtime(t);
  await assert.rejects(r.wrapper.send({ type: "prompt", message: '/omp-web-fox-goal {"op":"control","action":"resume"}' }), /not a public prompt API/);
  assert.equal(r.commands.length, 0);
});

test("a missing internal reply rejects when the owning runtime closes", async (t) => {
  const r = runtime(t);
  await r.wrapper.send({ type: "get_state" });
  const command = r.wrapper.foxGoalCommand("get");
  const rejected = assert.rejects(command, /closed before native goal acknowledgement/);
  await new Promise((resolve) => setImmediate(resolve));
  await r.wrapper.destroyAndWait();
  await rejected;
});

test("confirmed authorization creates, pauses and binds the exact native objective before replying", async (t) => {
  saveWebServerSettings({ agentToolsEnabled: true });
  t.after(() => saveWebServerSettings({ agentToolsEnabled: false }));
  const terms = { objective: "ship exactly this", projects: ["/project"], criteria: [{ id: "criterion", text: "verified" }], operations: ["implementation", "verification"], maxWorkers: 4, maxDispatches: 64, maxRework: 3 };
  const consent = { ...projectFoxGoal([]), grant: { id: "grant", goalId: null, terms, epoch: "epoch", createdAt: new Date().toISOString(), paused: false, revoked: false } };
  let goal = null;
  const r = runtime(t, (command, emit) => {
    if (command.type === "goal") {
      if (command.op === "create") goal = { id: "native", objective: command.objective, status: "active" };
      if (command.op === "pause") goal = { ...goal, status: "paused" };
      return { goal, state: goal ? { goal, enabled: goal.status === "active", mode: "active" } : null };
    }
    if (command.type === "prompt") {
      const payload = JSON.parse(command.message.slice(command.message.indexOf(" ") + 1));
      assert.equal(payload.op, "bind");
      assert.equal(payload.objective, terms.objective);
      assert.equal(goal.status, "paused");
      emit({ type: "extension_ui_request", method: "notify", message: `foxnio:goal-reply:${JSON.stringify({ requestId: payload.requestId, sessionId: "fox", data: { ...consent, grant: { ...consent.grant, goalId: "native" } } })}` });
      return { agentInvoked: false };
    }
    return {};
  });
  await r.wrapper.send({ type: "get_state" });
  r.emit({ type: "extension_ui_request", method: "notify", message: `foxnio:goal-event:${JSON.stringify({ sessionId: "fox", toolCallId: "authorized", op: "authorize", consentEntryId: "grant", snapshot: consent })}` });
  r.emit({ type: "host_tool_call", id: "host-authorized", toolCallId: "authorized", toolName: "fox_goal", arguments: { op: "authorize", terms } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(r.commands.filter((command) => command.type === "goal").map((command) => command.op), ["get", "create", "pause"]);
  assert.equal(r.frames.at(-1)?.isError, false);
});

test("a bound native goal cannot fall back to manual dispatch without coordination metadata", async (t) => {
  saveWebServerSettings({ agentToolsEnabled: true });
  t.after(() => saveWebServerSettings({ agentToolsEnabled: false }));
  const snapshot = { ...projectFoxGoal([]), grant: { id: "grant", goalId: "native", revoked: false } };
  const r = runtime(t, (command, emit) => {
    if (command.type === "goal") return { goal: { id: "native" }, state: { enabled: true, mode: "active", goal: { id: "native" } } };
    if (command.type !== "prompt") return {};
    const payload = JSON.parse(command.message.slice(command.message.indexOf(" ") + 1));
    emit({ type: "extension_ui_request", method: "notify", message: `foxnio:goal-reply:${JSON.stringify({ requestId: payload.requestId, sessionId: "fox", data: snapshot })}` });
    return {};
  });
  await r.wrapper.send({ type: "get_state" });
  await r.wrapper.foxGoalCommand("get");
  r.emit({ type: "host_tool_call", id: "missing-metadata", toolCallId: "model-dispatch", toolName: "new_session", arguments: { cwd: root, prompt: "implement" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.frames.at(-1)?.isError, true);
  assert.match(r.frames.at(-1).result.content[0].text, /requires explicit coordination metadata/);
});

test("automatic activation defers busy or queued native work without losing explicit Resume errors", async (t) => {
  const r = runtime(t);
  await r.wrapper.send({ type: "get_state" });
  r.emit({ type: "agent_start" });
  assert.equal(await r.wrapper.activateFoxGoal(), false);
  await assert.rejects(r.wrapper.activateFoxGoal(true), { code: "session_busy" });
  r.emit({ type: "agent_end", isTerminal: true });
  r.state.queuedMessageCount = 1;
  assert.equal(await r.wrapper.activateFoxGoal(), false);
  assert.equal(r.commands.some((command) => command.type === "goal" || command.type === "prompt"), false);
});

test("concurrent activation callers share one native transaction and the same authoritative failure", async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const r = runtime(t, async (command, emit) => {
    if (command.type === "goal") {
      entered.resolve();
      await release.promise;
      return { goal: null, state: null };
    }
    if (command.type === "prompt") {
      const payload = JSON.parse(command.message.slice(command.message.indexOf(" ") + 1));
      emit({ type: "extension_ui_request", method: "notify", message: `foxnio:goal-reply:${JSON.stringify({ requestId: payload.requestId, sessionId: "fox", data: projectFoxGoal([]) })}` });
    }
    return {};
  });
  await r.wrapper.send({ type: "get_state" });
  const first = r.wrapper.activateFoxGoal();
  await entered.promise;
  const second = r.wrapper.activateFoxGoal();
  const results = Promise.allSettled([first, second]);
  release.resolve();
  const settled = await results;
  assert.equal(r.commands.filter((command) => command.type === "goal").length, 1);
  assert.equal(settled[0].status, "rejected");
  assert.equal(settled[1].status, "rejected");
  assert.equal(settled[0].reason, settled[1].reason);
  assert.match(settled[0].reason.message, /grant cannot safely resume/);
});

test("a restarting registry owner cannot be replaced under either its id or exact session file", async (t) => {
  const file = join(root, "restarting-owner.jsonl");
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "restarting-owner", cwd: foxWorkspaceDir() }) + "\n");
  const owner = { sessionId: "restarting-owner", sessionFile: file, cwd: foxWorkspaceDir(), isAlive: () => false, isRestarting: () => true };
  globalThis.__ompSessions ??= new Map();
  globalThis.__ompSessions.set(owner.sessionId, owner);
  t.after(() => globalThis.__ompSessions.delete(owner.sessionId));
  await assert.rejects(startRpcSession(owner.sessionId, file, owner.cwd), { code: "session_restarting" });
  await assert.rejects(startRpcSession("another-alias", file, owner.cwd), { code: "session_restarting" });
  assert.equal(globalThis.__ompSessions.get(owner.sessionId), owner);
  assert.equal(globalThis.__ompSessions.has("another-alias"), false);
});

test("project policy invalidation closes admission synchronously, revokes and pauses without aborting workers", async (t) => {
  let revoked = false;
  let goal = { id: "policy-goal", objective: "deliver", status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
  const snapshot = () => ({ ...projectFoxGoal([]), goal: { enabled: goal.status === "active", mode: "active", goal }, grant: { id: "policy-grant", goalId: goal.id, terms: { objective: goal.objective, projects: [root] }, revoked, paused: false }, assignments: [] });
  const r = runtime(t, (command, emit) => {
    if (command.type === "goal") {
      if (command.op === "pause") goal = { ...goal, status: "paused" };
      return { goal, state: snapshot().goal };
    }
    if (command.type === "prompt") {
      const payload = JSON.parse(command.message.slice(command.message.indexOf(" ") + 1));
      if (payload.op === "control") { assert.equal(payload.action, "revoke"); revoked = true; }
      emit({ type: "extension_ui_request", method: "notify", message: `foxnio:goal-reply:${JSON.stringify({ requestId: payload.requestId, sessionId: "fox", data: snapshot() })}` });
    }
    return {};
  });
  await r.wrapper.send({ type: "get_state" });
  writeFoxSessionId("policy-fox-session");
  globalThis.__ompSessions ??= new Map();
  globalThis.__ompSessions.set("policy-fox-session", r.wrapper);
  t.after(() => { globalThis.__ompSessions.delete("policy-fox-session"); clearFoxSessionId(); });
  const invalidation = invalidateFoxGoalPolicy([root]);
  await assert.rejects(r.wrapper.recheckFoxGoalDispatch({}), /closed before the side effect/);
  const result = await invalidation;
  assert.equal(result.grant.revoked, true);
  assert.equal(result.goal.goal.status, "paused");
  assert.equal(r.commands.some((command) => command.type === "abort" || command.type === "goal" && command.op === "drop"), false);
  await assert.rejects(controlFoxGoal("resume"), /revoked/);
});

test("recovery retains confirmed unbound consent as setup work without granting dispatch authority", () => {
  const snapshot = { ...projectFoxGoal([]), grant: { id: "confirmed-next", goalId: null, revoked: false, paused: false, terms: { objective: "second delivery" } }, recovery: "next", assignments: [] };
  assert.equal(shouldRecoverFoxGoal(snapshot), true);
  assert.equal(shouldRecoverFoxGoal({ ...snapshot, grant: { ...snapshot.grant, revoked: true } }), false);
  assert.equal(shouldRecoverFoxGoal({ ...snapshot, recovery: "waiting" }), false);
});

test("native resource exhaustion pauses the exact grant without dropping or aborting its workers", async (t) => {
  let paused = false;
  let goal = { id: "limited-goal", objective: "deliver", status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 };
  const snapshot = () => ({ ...projectFoxGoal([]), goal: { enabled: goal.status === "active", mode: "active", goal }, grant: { id: "limited-grant", goalId: goal.id, terms: { objective: goal.objective }, revoked: false, paused }, assignments: [] });
  const r = runtime(t, (command, emit) => {
    if (command.type === "goal") {
      if (command.op === "pause") goal = { ...goal, status: "paused" };
      return { goal, state: snapshot().goal };
    }
    if (command.type === "prompt") {
      const payload = JSON.parse(command.message.slice(command.message.indexOf(" ") + 1));
      if (payload.op === "control") { assert.equal(payload.action, "pause"); paused = true; }
      if (payload.op === "recovery") assert.equal(payload.obligation, "resource:dispatch-limit");
      emit({ type: "extension_ui_request", method: "notify", message: `foxnio:goal-reply:${JSON.stringify({ requestId: payload.requestId, sessionId: "fox", data: snapshot() })}` });
    }
    return {};
  });
  await r.wrapper.send({ type: "get_state" });
  await r.wrapper.pauseFoxGoalResource("limited-grant", "limited-goal", "dispatch-limit");
  assert.equal(paused, true);
  assert.equal(goal.status, "paused");
  assert.equal(r.commands.some((command) => command.type === "abort" || command.type === "goal" && command.op === "drop"), false);
});

test("handoff absence proof never runs over queued human work", async (t) => {
  const r = runtime(t);
  await r.wrapper.send({ type: "get_state" });
  r.state.queuedMessageCount = 1;
  await assert.rejects(r.wrapper.foxGoalCommand("handoff-resolve", { handoffEntryId: "ambiguous-handoff" }), /busy|pending/i);
  assert.equal(r.commands.some((command) => command.type === "prompt"), false);
});

test("an already scheduled native continuation may start while an internal metadata reply is pending", async (t) => {
  const r = runtime(t, (command, emit) => {
    if (command.type !== "prompt") return {};
    const payload = JSON.parse(command.message.slice(command.message.indexOf(" ") + 1));
    emit({ type: "agent_start" });
    emit({ type: "extension_ui_request", method: "notify", message: `foxnio:goal-reply:${JSON.stringify({ requestId: payload.requestId, sessionId: "fox", data: projectFoxGoal([]) })}` });
    return { agentInvoked: false };
  });
  await r.wrapper.send({ type: "get_state" });
  assert.equal((await r.wrapper.foxGoalCommand("get")).supported, true);
  assert.equal(r.wrapper.isRunning(), true);
});

test("fresh native replacement consent replaces only its proven old goal after durable revocation", async (t) => {
  saveWebServerSettings({ agentToolsEnabled: true });
  t.after(() => saveWebServerSettings({ agentToolsEnabled: false }));
  const terms = { objective: "replacement delivery", projects: [root], criteria: [{ id: "criterion", text: "verified" }], operations: ["implementation"], maxWorkers: 4, maxDispatches: 64, maxRework: 3 };
  let goal = { id: "old-goal", objective: "old delivery", status: "paused" };
  const consent = { ...projectFoxGoal([]), grant: { id: "replacement-grant", goalId: null, replacesGoalId: "old-goal", terms, epoch: "new-epoch", paused: false, revoked: false }, recovery: "next" };
  const r = runtime(t, (command, emit) => {
    if (command.type === "goal") {
      if (command.op === "drop") goal = null;
      if (command.op === "create") { assert.equal(goal, null); goal = { id: "new-goal", objective: command.objective, status: "active" }; }
      if (command.op === "pause") goal = { ...goal, status: "paused" };
      return { goal, state: goal ? { enabled: goal.status === "active", mode: "active", goal } : null };
    }
    if (command.type === "prompt") {
      const payload = JSON.parse(command.message.slice(command.message.indexOf(" ") + 1));
      const data = payload.op === "bind" ? { ...consent, grant: { ...consent.grant, goalId: goal.id } } : consent;
      emit({ type: "extension_ui_request", method: "notify", message: `foxnio:goal-reply:${JSON.stringify({ requestId: payload.requestId, sessionId: "fox", data })}` });
    }
    return {};
  });
  await r.wrapper.send({ type: "get_state" });
  r.wrapper.closeFoxGoalAdmission();
  await r.wrapper.foxGoalCommand("control", { action: "revoke" });
  r.emit({ type: "extension_ui_request", method: "notify", message: `foxnio:goal-event:${JSON.stringify({ sessionId: "fox", toolCallId: "replacement", op: "authorize", consentEntryId: "replacement-grant", snapshot: consent })}` });
  r.emit({ type: "host_tool_call", id: "replacement-host", toolCallId: "replacement", toolName: "fox_goal", arguments: { op: "authorize", terms, replacesGoalId: "forged-model-value" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.frames.at(-1)?.isError, false);
  assert.deepEqual(r.commands.filter((command) => command.type === "goal").map((command) => command.op), ["get", "drop", "create", "pause"]);
  assert.equal(goal.id, "new-goal");
  assert.equal(goal.status, "paused");
});

test("handoff uncertainty pauses only its exact native goal without installing a user or resource pause", async (t) => {
  let goal = { id: "handoff-goal", objective: "review", status: "active" };
  const snapshot = () => ({ ...projectFoxGoal([]), goal: { enabled: goal.status === "active", mode: "active", goal }, grant: { id: "handoff-grant", goalId: goal.id, terms: { objective: goal.objective }, revoked: false, paused: false }, recovery: "uncertain", handoffs: [{ id: "handoff-entry", batchId: "batch", reportIds: ["report"], state: "uncertain" }] });
  const r = runtime(t, (command, emit) => {
    if (command.type === "goal") {
      if (command.op === "pause") goal = { ...goal, status: "paused" };
      return { goal, state: snapshot().goal };
    }
    if (command.type === "prompt") {
      const payload = JSON.parse(command.message.slice(command.message.indexOf(" ") + 1));
      assert.equal(payload.op, "get", "uncertain delivery must not write control pause or resource recovery");
      emit({ type: "extension_ui_request", method: "notify", message: `foxnio:goal-reply:${JSON.stringify({ requestId: payload.requestId, sessionId: "fox", data: snapshot() })}` });
    }
    return {};
  });
  await r.wrapper.send({ type: "get_state" });
  await r.wrapper.pauseFoxGoalHandoff("handoff-grant", "handoff-goal", "handoff-entry");
  assert.equal(goal.status, "paused");
  assert.doesNotThrow(() => r.wrapper.assertFoxGoalAdmissionOpen(root));
  await assert.rejects(r.wrapper.pauseFoxGoalHandoff("handoff-grant", "handoff-goal", "unrelated-entry"), /does not match/);
  assert.equal(r.commands.filter((command) => command.type === "goal" && command.op === "pause").length, 1);
});

test("report ingestion owns metadata admission until receipt identity is verified", async (t) => {
  const receipt = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const r = runtime(t, async (command, emit, state) => {
    if (command.type === "goal") return { goal: null, state: null };
    if (command.type !== "prompt") return {};
    const payload = JSON.parse(command.message.slice(command.message.indexOf(" ") + 1));
    if (command.message.startsWith("/omp-web-fox-report ")) {
      entered.resolve();
      await receipt.promise;
      emit({ type: "agent_start" });
      state.isStreaming = true;
      state.isSettled = false;
      emit({ type: "extension_ui_request", method: "notify", message: `omp-web-fox-report:${JSON.stringify({ requestId: payload.requestId, sessionId: "fox", reportId: payload.report.id })}` });
      return { agentInvoked: false };
    }
    emit({ type: "extension_ui_request", method: "notify", message: `foxnio:goal-reply:${JSON.stringify({ requestId: payload.requestId, sessionId: "fox", data: projectFoxGoal([]) })}` });
    return { agentInvoked: false };
  });
  await r.wrapper.send({ type: "get_state" });
  const report = { version: 1, id: "worker:1", sourceSessionId: "worker", parentSessionId: "fox", sequence: 1, cwd: root, at: new Date().toISOString(), source: "agent", status: "result", summary: "done", evidence: [] };
  const ingestion = r.wrapper.receiveFoxReport(report);
  await entered.promise;
  const snapshot = r.wrapper.getFoxGoalSnapshot();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.commands.some((command) => command.type === "goal"), false, "getSnapshot cannot interleave native goal queries inside receipt ingestion");
  receipt.resolve();
  await ingestion;
  assert.equal((await snapshot).supported, true);
  assert.equal(r.wrapper.isAlive(), true, "independent native continuation must not destroy FOX after receipt");
});
