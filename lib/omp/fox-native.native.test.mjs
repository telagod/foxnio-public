import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";
import { nativeEnvironment, within, writeInertAgentConfig } from "../../tests/omp-native-env.mjs";

const options = {
  skip: process.env.OMP_WEB_TEST_NATIVE_FOX !== "1" && "set OMP_WEB_TEST_NATIVE_FOX=1 to exercise native FOX with an isolated local provider",
  timeout: 120_000,
};

test("native FOX confirms, delegates, follows up, and persists native plans without a parallel ledger", options, async (t) => {
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { resolveOmpBin } = await jiti.import("./omp-cli.ts");
  const binary = process.env.OMP_WEB_OMP_BIN || resolveOmpBin();
  assert.ok(binary);
  const root = mkdtempSync(join(tmpdir(), "fox-native-acceptance-"));
  const agentDir = join(root, "agent");
  const isolated = nativeEnvironment(root, agentDir);
  for (const key of Object.keys(process.env)) if (key !== "NODE_TEST_CONTEXT") delete process.env[key];
  Object.assign(process.env, isolated, { OMP_WEB_OMP_BIN: binary });
  const provider = "fox-native-acceptance";
  const model = "offline-fixture";
  writeInertAgentConfig(agentDir, { provider, model, api: "openai-completions", apiKey: "inert-fixture-key" });
  const project = join(root, "project");
  mkdirSync(project);
  let action = { name: "new_session", args: { cwd: project, prompt: "Fixture project work only", name: "FOX · Fixture worker", provider, modelId: model } };
  let providerCalls = 0;
  const modelCalls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    if (!request.url.endsWith("/chat/completions")) { response.writeHead(404); response.end(); return; }
    providerCalls += 1;
    const last = (body.messages || []).at(-1);
    const workerModel = body.tools?.some((tool) => tool.function?.name === "report_to_parent");
    modelCalls.push({ role: last?.role, tools: body.tools?.map((tool) => tool.function?.name) });
    const sourceUser = (body.messages || []).findLast((message) => message.role === "user");
    const sourceText = typeof sourceUser?.content === "string" ? sourceUser.content : JSON.stringify(sourceUser?.content);
    const finalText = workerModel && sourceText?.includes("Fixture follow-up")
      ? "Fixture follow-up received by the exact worker." : "Fixture result available. No project files were changed.";
    const callTool = last?.role === "user" && Array.isArray(body.tools) && body.tools.length > 0;
    const selectedAction = workerModel ? { name: "report_to_parent", args: { status: "result", summary: finalText, evidence: ["Isolated fixture result; no project commands were run."] } } : action;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: `fixture-${providerCalls}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
    const emit = (choice) => response.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
    emit({ index: 0, delta: callTool
      ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${providerCalls}`, type: "function", function: { name: selectedAction.name, arguments: JSON.stringify(selectedAction.args) } }] }
      : { role: "assistant", content: finalText }, finish_reason: null });
    emit({ index: 0, delta: {}, finish_reason: callTool ? "tool_calls" : "stop" });
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const modelFile = join(agentDir, "models.yml");
  writeFileSync(modelFile, readFileSync(modelFile, "utf8")
    .replace("http://127.0.0.1:1/v1", `http://127.0.0.1:${server.address().port}/v1`).replace("8192", "131072"));

  const rpc = await jiti.import("../rpc-manager.ts");
  const { RpcProcess } = await jiti.import("./rpc-process.ts");
  const reports = await jiti.import("../fox-report-store.ts");
  const reader = await jiti.import("../session-reader.ts");
  const { ensureFoxWorkspace } = await jiti.import("../fox-workspace.ts");
  const config = await jiti.import("../fox-service-config.ts");
  const pointer = await jiti.import("../fox-session.ts");
  const { saveWebServerSettings } = await jiti.import("../web-settings.ts");
  const shadows = [];
  t.after(async () => {
    await reports.stopFoxReportDelivery();
    await Promise.all([...new Set([...globalThis.__ompSessions?.values() ?? [], ...shadows])].map((session) => session.destroyAndWait()));
    globalThis.__ompNotificationStore?.db.close();
    globalThis.__ompNotificationStore = undefined;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  });
  saveWebServerSettings({ agentToolsEnabled: true, autoResumeSessions: false });
  const foxCwd = ensureFoxWorkspace();
  let { session: fox } = await rpc.startRpcSession(`__new__${randomUUID()}`, "", foxCwd);
  pointer.writeFoxSessionId(fox.sessionId);
  await fox.send({ type: "set_model", provider, modelId: model });
  let allow = true;
  let confirmations = 0;
  const events = [];
  const observe = (event) => {
    events.push(event);
    if (event.type === "extension_ui_request" && event.method === "confirm") {
      confirmations += 1;
      void fox.send({ type: "extension_ui_response", id: event.id, confirmed: allow });
    }
  };
  fox.onEvent(observe);
  async function turn(message) {
    const start = events.length;
    await within(fox.send({ type: "prompt", message }), 20_000, "FOX prompt");
    const deadline = Date.now() + 20_000;
    while (!events.slice(start).some((event) => event.type === "agent_end" && event.isTerminal !== false)) {
      if (Date.now() > deadline) throw new Error(`FOX did not end: ${JSON.stringify(events.slice(start).filter((event) => event.type === "prompt_error"))}`);
      await delay(40);
    }
    await delay(80);
  }
  async function workers() {
    reader.invalidateSessionListCache();
    return (await reader.listAllSessions()).filter((session) => session.parentSessionId === fox.sessionId);
  }

  await turn("Delegate the isolated fixture task.");
  assert.equal(confirmations, 1);
  let children = await workers();
  assert.equal(children.length, 1, JSON.stringify(events.filter((event) => event.type === "tool_execution_end")));
  const worker = children[0];
  assert.equal(reader.readSessionHeader(worker.path).parentSession, fox.sessionFile);
  await within((async () => {
    while (true) {
      const view = await reports.foxWorkerReportView(worker.path);
      if (view.report?.status === "result" && view.delivery === "received") break;
      await delay(40);
    }
  })(), 15_000, "native worker report receipt");
  const received = await reports.readFoxReportJournal(fox.sessionFile);
  assert.ok([...received.received.values()].some((report) => report.sourceSessionId === worker.id && report.status === "result" && report.source === "agent"), JSON.stringify({
    modelCalls, reports: [...received.received.values()],
    workerResults: readFileSync(worker.path, "utf8").split("\n").flatMap((line) => { try { const entry = JSON.parse(line); return entry.message?.role === "toolResult" ? [entry.message] : []; } catch { return []; } }),
  }));

  action = { name: "send_to_session", args: { cwd: project, sessionId: worker.id, message: "Fixture follow-up", wait: true, waitTimeoutMs: 5000 } };
  await turn("Follow up the exact native child.");
  assert.equal(confirmations, 2);
  const followup = events.findLast((event) => event.type === "tool_execution_end" && event.toolName === "send_to_session");
  assert.equal(followup.isError, false, JSON.stringify(followup));
  assert.match(followup.result.content[0].text, /Fixture follow-up received by the exact worker/);
  assert.ok(readFileSync(worker.path, "utf8").trim().split("\n").map(JSON.parse).some((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("Fixture follow-up")));

  action = { name: "new_session", args: { cwd: project, prompt: "Another fixture task", provider, modelId: model } };
  allow = false;
  await turn("The user will decline this dispatch.");
  assert.equal(confirmations, 3);
  assert.equal((await workers()).length, 1);
  allow = true;
  await turn("[FOX proactive check] Observe only.");
  assert.equal(confirmations, 3);
  assert.equal((await workers()).length, 1);

  const policy = config.readFoxServiceConfig();
  config.writeFoxServiceConfig({ ...policy, dispatchPolicies: { [project]: "observe" } });
  await turn("Attempt an observation-only dispatch.");
  assert.equal(confirmations, 3);
  assert.equal((await workers()).length, 1);
  config.writeFoxServiceConfig({ ...policy, dispatchPolicies: { [project]: "auto" } });
  await turn("Dispatch under the explicitly configured automatic policy.");
  assert.equal(confirmations, 3);
  children = await workers();
  assert.equal(children.length, 2);

  const independent = await rpc.startRpcSession(`__new__${randomUUID()}`, "", project);
  await independent.session.send({ type: "set_model", provider, modelId: model });
  await independent.session.send({ type: "prompt", message: "[From session fixture via foxnio agent tools]: Independent fixture conversation" });
  await independent.session.waitForTurnEnd(10_000);
  reader.invalidateSessionListCache();
  const unrelatedBefore = (await reader.listAllSessions()).find((session) => session.id === independent.session.sessionId).messageCount;
  action = { name: "send_to_session", args: { cwd: project, sessionId: independent.session.sessionId, message: "This follow-up must not execute" } };
  await turn("Attempt to follow up an unrelated conversation.");
  reader.invalidateSessionListCache();
  assert.equal((await reader.listAllSessions()).find((session) => session.id === independent.session.sessionId).messageCount, unrelatedBefore);
  assert.ok(events.some((event) => event.type === "tool_execution_end" && JSON.stringify(event).includes("FOX can only follow up direct workers")));
  assert.equal(confirmations, 3);

  const phases = [{ name: "Coordinate", tasks: [{ content: "Review the native worker result", status: "pending" }] }];
  await fox.send({ type: "set_todos", phases });
  const file = fox.sessionFile;
  const id = fox.sessionId;
  await fox.destroyAndWait();
  const resumed = await rpc.startRpcSession(id, file, foxCwd);
  assert.deepEqual((await resumed.session.send({ type: "get_state" })).todoPhases, phases);
  fox = resumed.session;
  fox.onEvent(observe);
  await reports.stopFoxReportDelivery();
  const deliver = globalThis.__foxReportRelay.deliver;
  const firstWorker = rpc.getRpcSession(worker.id);
  await firstWorker.destroyAndWait();
  const restoredWorker = (await rpc.startRpcSession(worker.id, worker.path, project)).session;
  await restoredWorker.send({ type: "prompt", message: "Fixture follow-up after restarting the worker" });
  await restoredWorker.waitForTurnEnd(10_000);
  const movedWorker = restoredWorker.sessionFile;
  assert.equal(reports.foxWorkerParent(movedWorker).parent.id, id);
  globalThis.__foxReportRelay = undefined;
  reports.configureFoxReportDelivery(deliver);
  await reports.recoverFoxWorkerReports(movedWorker);
  await within((async () => {
    while ((await reports.foxWorkerReportView(movedWorker)).delivery !== "received") {
      reports.wakeFoxReportDelivery(id);
      await reports.flushFoxReports();
      await delay(40);
    }
  })(), 15_000, "report delivery after both native processes and relay restart");
  assert.equal(pointer.readFoxSessionId(), fox.sessionId);
  action = { name: "send_to_session", args: { cwd: project, sessionId: restoredWorker.sessionId, message: "Fixture follow-up after coordinator continuation", wait: true, waitTimeoutMs: 5000 } };
  await turn("Follow up the original worker after both processes resumed.");
  assert.equal(events.findLast((event) => event.type === "tool_execution_end" && event.toolName === "send_to_session").isError, false);
  await reports.flushFoxReports();
  await fox.destroyAndWait();
  const reset = pointer.clearFoxSessionId();
  const replacement = (await rpc.startRpcSession(`__new__${randomUUID()}`, "", foxCwd)).session;
  await replacement.send({ type: "set_model", provider, modelId: model });
  await replacement.send({ type: "set_session_name", name: "Replacement FOX" });
  assert.ok(pointer.compareAndSetFoxSessionId(replacement.sessionId, reset));
  fox = replacement;
  fox.onEvent(observe);
  await turn("The new conversation must not adopt the old worker.");
  assert.equal(events.findLast((event) => event.type === "tool_execution_end" && event.toolName === "send_to_session").isError, true);
  await reports.stopFoxReportDelivery();
  await restoredWorker.send({ type: "prompt", message: "Fixture follow-up with a late report after FOX reset" });
  await restoredWorker.waitForTurnEnd(10_000);
  const late = (await reports.foxWorkerReportView(restoredWorker.sessionFile)).report;
  reports.startFoxReportDelivery();
  reports.wakeFoxReportDelivery(id);
  await reports.recoverFoxWorkerReports(restoredWorker.sessionFile);
  await within((async () => {
    while ((await reports.foxWorkerReportView(restoredWorker.sessionFile)).delivery !== "received") {
      reports.wakeFoxReportDelivery(id);
      await reports.flushFoxReports();
      await delay(40);
    }
  })(), 15_000, "late report to the original coordinator");
  assert.equal((await reports.readFoxReportJournal(replacement.sessionFile)).received.has(late.id), false);
  assert.equal(pointer.readFoxSessionId(), replacement.sessionId);
  await reports.stopFoxReportDelivery();
  async function shadow(source, coordinator = false) {
    const extensions = ["fox-report-extension.mjs", ...(coordinator ? ["fox-native-extension.mjs"] : [])];
    const proc = new RpcProcess({
      cwd: source.cwd,
      extraArgs: [...rpc.buildSessionSpawnArgs(source.sessionFile), ...extensions.flatMap((name) => ["--extension", fileURLToPath(new URL(name, import.meta.url))])],
    });
    const copy = new rpc.AgentSessionWrapper(proc, source.cwd, source.cwd, "inherit", source.sessionId);
    shadows.push(copy);
    copy.start();
    await copy.waitUntilReady();
    await copy.send({ type: "set_host_tools", tools: [] });
    return copy;
  }
  const workerCopy = await shadow(restoredWorker);
  await restoredWorker.send({ type: "set_todos", phases: [{ name: "Ownership fixture", tasks: [{ content: "Keep the original writer alive", status: "pending" }] }] });
  const workerCopyEnd = workerCopy.waitForTurnEnd(10_000);
  await workerCopy.send({ type: "prompt", message: "Fixture follow-up from a native continuation" });
  await workerCopyEnd;
  assert.notEqual(workerCopy.sessionId, restoredWorker.sessionId);
  assert.equal(reader.readSessionHeader(workerCopy.sessionFile).continuationOf, restoredWorker.sessionId);
  const copiedView = await reports.foxWorkerReportView(workerCopy.sessionFile);
  assert.ok(copiedView.report, JSON.stringify({
    copiedView, header: reader.readSessionHeader(workerCopy.sessionFile),
    sourceFile: restoredWorker.sessionFile, sourceHeader: reader.readSessionHeader(restoredWorker.sessionFile),
  }));
  const copiedReport = copiedView.report;
  assert.equal(copiedReport.sourceSessionId, workerCopy.sessionId);
  assert.equal(copiedReport.parentSessionId, id);
  const original = rpc.getRpcSession(id);
  const parentCopy = await shadow(original, true);
  await original.send({ type: "set_todos", phases: [{ name: "Ownership fixture", tasks: [{ content: "Retain the coordinator writer", status: "pending" }] }] });
  const callsBeforeReceipt = providerCalls;
  await parentCopy.receiveFoxReport(copiedReport, file);
  assert.notEqual(parentCopy.sessionId, original.sessionId);
  assert.equal(reader.readSessionHeader(parentCopy.sessionFile).continuationOf, original.sessionId);
  assert.equal(providerCalls, callsBeforeReceipt);
  assert.equal((await reports.foxWorkerReportView(workerCopy.sessionFile)).delivery, "received");
  assert.equal(pointer.readFoxSessionId(), replacement.sessionId);
  assert.equal(existsSync(join(agentDir, "omp-web", "chief.db")), false);
  assert.equal(existsSync(join(foxCwd, "dispatches.json")), false);
});
