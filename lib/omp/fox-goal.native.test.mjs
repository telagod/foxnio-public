import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createJiti } from "jiti";
import { nativeEnvironment, writeInertAgentConfig } from "../../tests/omp-native-env.mjs";

const options = {
  skip: process.env.OMP_WEB_TEST_NATIVE_FOX_GOAL !== "1" && "set OMP_WEB_TEST_NATIVE_FOX_GOAL=1 for isolated real OMP goal acceptance",
  timeout: 180_000,
};

function toolText(message) {
  if (typeof message?.content === "string") return message.content;
  return (message?.content ?? []).map((part) => part.text ?? "").join("\n");
}
function jsonResult(message) {
  try { return JSON.parse(toolText(message)); } catch { return null; }
}

test("authorized native goal verifies, reworks and completes across project workers with no browser", options, async (t) => {
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { resolveOmpBin } = await jiti.import("./omp-cli.ts");
  const binary = process.env.OMP_WEB_OMP_BIN || resolveOmpBin();
  assert.ok(binary);
  const root = mkdtempSync(join(tmpdir(), "fox-goal-acceptance-"));
  const agentDir = join(root, "agent");
  const isolated = nativeEnvironment(root, agentDir);
  for (const key of Object.keys(process.env)) if (key !== "NODE_TEST_CONTEXT") delete process.env[key];
  Object.assign(process.env, isolated, { OMP_WEB_OMP_BIN: binary });
  const provider = "fox-goal-fixture", model = "local";
  writeInertAgentConfig(agentDir, { provider, model, api: "openai-completions", apiKey: "inert-fixture-key" });
  const project = join(root, "project");
  mkdirSync(project);
  const artifact = join(project, "answer.json");
  const check = `node -e ${JSON.stringify(`const assert=require('node:assert/strict');const fs=require('node:fs');assert.equal(JSON.parse(fs.readFileSync(${JSON.stringify(artifact)},'utf8')).answer,42);console.log('verified answer=42')`)}`;
  const item = "Deliver verified answer";
  const phases = [{ phase: "Delivery", items: [item] }];
  let stage = "authorize", snapshot = null, workerId = null, verifierId = null;
  let expectedTool = null, expectedToolId = null, sequence = 0, confirmations = 0, userPrompts = 0;
  let failedCheckObserved = false, passedCheckObserved = false;
  const modelErrors = [];
  const settled = new Set();
  const calls = [];
  const coord = (purpose) => {
    assert.ok(snapshot?.grant?.goalId, JSON.stringify(snapshot));
    const task = snapshot.todoPhases[0].tasks[0];
    return {
      grantEntryId: snapshot.grant.id, nativeGoalId: snapshot.grant.goalId,
      planItemRef: task.id || JSON.stringify([snapshot.planEntryId, snapshot.todoPhases[0].name, task.content]),
      purpose, criterionIds: ["answer"],
    };
  };
  const action = (name, args) => ({ name, args });
  function workerAction(body) {
    const messages = body.messages ?? [];
    const last = messages.at(-1);
    const prompt = messages.filter((m) => m.role === "user").map(toolText).join("\n");
    const verify = prompt.includes("VERIFY_FIXTURE");
    const rework = prompt.includes("REWORK_FIXTURE");
    const lastTool = last?.role === "tool" ? messages.slice(0, -1).findLast((m) => m.role === "assistant" && m.tool_calls)?.tool_calls?.at(-1)?.function?.name : null;
    if (lastTool === "report_to_parent") return null;
    if (lastTool === "write") return action("report_to_parent", { status: "result", summary: rework ? "Rework written" : "Implementation written", audience: "coordinator", evidence: [artifact] });
    if (lastTool === "bash") {
      const output = toolText(last);
      const passed = /^verified answer=42\s*$/m.test(output);
      if (passed) passedCheckObserved = true; else failedCheckObserved = true;
      return action("report_to_parent", {
        status: passed ? "result" : "failed", audience: "coordinator",
        summary: passed ? "Verification passed" : "Verification failed: answer is not 42",
        structuredEvidence: [{ kind: "check", reference: check, observed: passed ? "verified answer=42" : "assertion failed: answer is not 42" }],
      });
    }
    return verify ? action("bash", { command: check }) : action("write", { path: artifact, content: JSON.stringify({ answer: rework ? 42 : 0 }) + "\n" });
  }
  function coordinatorAction(body) {
    const last = expectedToolId ? body.messages?.findLast((message) => message.role === "tool" && message.tool_call_id === expectedToolId) : null;
    const completedTool = last ? expectedTool : null;
    if (last && expectedTool) {
      const result = jsonResult(last);
      if (toolText(last).includes("Error:") || last.is_error) modelErrors.push(toolText(last));
      if (expectedTool === "fox_goal" && result?.grant) snapshot = result;
      if (expectedTool === "new_session" && result?.sessionId) {
        if (stage === "wait-implementation") workerId = result.sessionId;
        else if (stage === "wait-verification") verifierId = result.sessionId;
      }
      if (expectedTool === "send_to_session" && result?.targetSessionId) {
        if (stage === "wait-rework") workerId = result.targetSessionId;
        if (stage === "wait-final-verification") verifierId = result.targetSessionId;
      }
      expectedTool = null;
      expectedToolId = null;
    }
    if (stage === "authorize") {
      stage = "authorized";
      return action("fox_goal", { op: "authorize", terms: {
        objective: "Deliver answer.json with answer 42 and verify it; repair a failed check within scope.",
        projects: [project], criteria: [{ id: "answer", text: "A real Node assertion verifies answer equals 42" }],
        operations: ["implementation", "verification"], maxWorkers: 4, maxDispatches: 64, maxRework: 3, tokenBudget: 500000,
      } });
    }
    if (stage === "authorized") stage = "plan";
    if (stage === "plan") { stage = "get-initial"; return action("todo", { op: "init", list: phases }); }
    if (stage === "get-initial") { stage = "dispatch-implementation"; return action("fox_goal", { op: "get" }); }
    if (stage === "dispatch-implementation") {
      stage = "wait-implementation";
      return action("new_session", { cwd: project, name: "Goal fixture implementation", provider, modelId: model,
        prompt: "IMPLEMENT_FIXTURE: write the requested artifact, then report; coordinator will verify.", coordination: coord("implementation") });
    }
    if (["wait-implementation", "wait-verification", "wait-rework", "wait-final-verification"].includes(stage)) {
      if (completedTool !== "fox_goal") return action("fox_goal", { op: "get" });
      const implementation = snapshot?.reports?.findLast((r) => r.sourceSessionId === workerId && r.status === "result");
      const verification = snapshot?.reports?.findLast((r) => r.sourceSessionId === verifierId && ["result", "failed"].includes(r.status));
      const ready = stage === "wait-implementation" ? implementation
        : stage === "wait-verification" ? verification
        : stage === "wait-rework" ? implementation?.summary.includes("Rework") && implementation
        : verification?.status === "result" && verification;
      if (!ready) {
        if (snapshot?.todoPhases?.[0]?.tasks?.[0]?.status !== "blocked") return action("todo", { op: "block", task: item, reason: "Waiting for exact assigned worker report" });
        return null;
      }
      const assignment = snapshot.assignments.find((entry) => entry.id === ready.assignmentId)
        ?? snapshot.assignments.findLast((entry) => entry.workerSessionId === ready.sourceSessionId);
      if (assignment && !["settled", "closed"].includes(assignment.state)) {
        return action("fox_goal", { op: "settle", grantEntryId: snapshot.grant.id, nativeGoalId: snapshot.grant.goalId,
          admissionId: assignment.id, state: "settled" });
      }
      if (stage === "wait-implementation") stage = "dispatch-verification";
      else if (stage === "wait-verification") stage = "reject-review";
      else if (stage === "wait-rework") stage = "dispatch-final-verification";
      else stage = "accept-review";
      return action("todo", { op: "unblock", task: item });
    }
    if (stage === "dispatch-verification") {
      stage = "wait-verification";
      return action("new_session", { cwd: project, name: "Goal fixture verification", provider, modelId: model,
        prompt: "VERIFY_FIXTURE: run the provided Node assertion and report actual result.", coordination: coord("verification") });
    }
    if (stage === "reject-review") {
      stage = "dispatch-rework";
      const report = snapshot.reports.findLast((r) => r.sourceSessionId === verifierId && r.status === "failed");
      return action("fox_goal", { op: "review", grantEntryId: snapshot.grant.id, nativeGoalId: snapshot.grant.goalId,
        review: { criterionId: "answer", decision: "reject", reportIds: [report.id], evidence: [{ kind: "check", reference: check, observed: "assertion failed: answer is not 42" }] } });
    }
    if (stage === "dispatch-rework") {
      stage = "wait-rework";
      return action("send_to_session", { sessionId: workerId, cwd: project, message: "REWORK_FIXTURE: correct answer to42 then report.", coordination: coord("rework") });
    }
    if (stage === "dispatch-final-verification") {
      stage = "wait-final-verification";
      return action("send_to_session", { sessionId: verifierId, cwd: project, message: "VERIFY_FIXTURE: rerun the Node assertion after the repair.", coordination: coord("verification") });
    }
    if (stage === "accept-review") {
      stage = "settle";
      const report = snapshot.reports.findLast((r) => r.sourceSessionId === verifierId && r.status === "result");
      return action("fox_goal", { op: "review", grantEntryId: snapshot.grant.id, nativeGoalId: snapshot.grant.goalId,
        review: { criterionId: "answer", decision: "accept", reportIds: [report.id], evidence: [{ kind: "check", reference: check, observed: "verified answer=42" }] } });
    }
    if (stage === "settle") {
      const assignment = snapshot.assignments.find((a) => !settled.has(a.id) && !["settled", "closed"].includes(a.state));
      if (assignment) {
        settled.add(assignment.id);
        return action("fox_goal", { op: "settle", grantEntryId: snapshot.grant.id, nativeGoalId: snapshot.grant.goalId, admissionId: assignment.id, state: "settled" });
      }
      stage = "complete";
      return action("todo", { op: "done", task: item });
    }
    if (stage === "complete") { stage = "finished"; return action("goal", { op: "complete" }); }
    return null;
  }
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      if (!request.url.endsWith("/chat/completions")) { response.writeHead(404); response.end(); return; }
      if (!body.tools?.length) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "fixture-title", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "Goal fixture" }, finish_reason: "stop" }] }));
        return;
      }
      const worker = body.tools?.some((tool) => tool.function?.name === "report_to_parent");
      const next = worker ? workerAction(body) : coordinatorAction(body);
      if (!worker && next) { expectedTool = next.name; expectedToolId = `call-${sequence + 1}`; }
      calls.push({ worker, stage, tool: next?.name ?? null });
      response.writeHead(200, { "content-type": "text/event-stream" });
      const base = { id: `goal-fixture-${++sequence}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
      const emit = (choice) => response.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
      emit({ index: 0, delta: next ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${sequence}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] } : { role: "assistant", content: worker ? "Worker turn finished." : "Waiting for the native workflow." }, finish_reason: null });
      emit({ index: 0, delta: {}, finish_reason: next ? "tool_calls" : "stop" });
      response.end("data: [DONE]\n\n");
    } catch (error) {
      modelErrors.push(String(error));
      response.writeHead(500); response.end(String(error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const modelFile = join(agentDir, "models.yml");
  writeFileSync(modelFile, readFileSync(modelFile, "utf8").replace("http://127.0.0.1:1/v1", `http://127.0.0.1:${server.address().port}/v1`).replace("8192", "131072"));
  const rpc = await jiti.import("../rpc-manager.ts");
  const { ensureFoxWorkspace } = await jiti.import("../fox-workspace.ts");
  const pointer = await jiti.import("../fox-session.ts");
  const service = await jiti.import("../fox-goal-service.ts");
  const reports = await jiti.import("../fox-report-store.ts");
  const reader = await jiti.import("../session-reader.ts");
  const { saveWebServerSettings } = await jiti.import("../web-settings.ts");
  const { closeStorage } = await jiti.import("../storage/client.ts");
  const { drainNotificationWrites } = await jiti.import("../notification-hub.ts");
  const { stopSessionIndex } = await jiti.import("../session-index.ts");
  let stopping = false;
  t.after(async () => {
    stopping = true;
    await reports.stopFoxReportDelivery();
    await Promise.all([...new Set(globalThis.__ompSessions?.values() ?? [])].map((session) => session.destroyAndWait()));
    await drainNotificationWrites();
    await stopSessionIndex();
    await closeStorage();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  saveWebServerSettings({ agentToolsEnabled: true, autoResumeSessions: false });
  const foxCwd = ensureFoxWorkspace();
  const { session: fox } = await rpc.startRpcSession(`__new__${randomUUID()}`, "", foxCwd);
  await pointer.writeFoxSessionId(fox.sessionId);
  await fox.send({ type: "set_model", provider, modelId: model });
  fox.onEvent((event) => {
    if (event.type === "extension_ui_request" && event.method === "confirm") {
      confirmations++;
      void fox.send({ type: "extension_ui_response", id: event.id, confirmed: true });
    }
    if (event.type === "tool_execution_end" && event.isError) modelErrors.push(JSON.stringify(event));
  });
  userPrompts++;
  await fox.send({ type: "prompt", message: "Authorize the fixture goal, implement and verify it. Repair failures within scope without asking again." });
  const deadline = Date.now() + 140_000;
  const completion = (async () => {
    while (!stopping) {
      if (Date.now() >= deadline) throw new Error("Native closed-loop delivery deadline exceeded");
      reader.invalidateSessionListCache();
      await reports.reconcileFoxReports(await reader.listAllSessions());
      if (stopping) return;
      await service.reconcileFoxGoal();
      if (stopping) return;
      const current = await service.getFoxGoalSnapshot();
      if (current.goal?.goal.status === "complete") { snapshot = current; break; }
      if (modelErrors.length) throw new Error(JSON.stringify({ stage, modelErrors, calls: calls.slice(-15) }));
      await delay(100);
    }
  })();
  try { await completion; }
  catch (error) {
    stopping = true;
    throw new Error(`${error.message}\n${JSON.stringify({ stage, modelErrors, calls: calls.slice(-20), snapshot })}`);
  }
  assert.equal(userPrompts, 1);
  assert.equal(confirmations, 1);
  assert.equal(failedCheckObserved, true);
  assert.equal(passedCheckObserved, true);
  assert.equal(snapshot.goal.goal.tokenBudget, 500000);
  assert.deepEqual(JSON.parse(readFileSync(artifact, "utf8")), { answer: 42 });
  assert.equal(snapshot.reviews.find((review) => review.criterionId === "answer").decision, "accept");
  assert.ok(snapshot.assignments.every((assignment) => ["settled", "closed"].includes(assignment.state)));
  assert.equal(existsSync(join(agentDir, "omp-web", "chief.db")), false);
  assert.equal(existsSync(join(foxCwd, "dispatches.json")), false);
});
