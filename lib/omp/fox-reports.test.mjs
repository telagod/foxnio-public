import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import {
  FOX_REPORT_COMMAND, FOX_REPORT_EVENT_PREFIX, FOX_REPORT_MESSAGE, FOX_REPORT_OUTBOX, FOX_REPORT_RECEIPT,
  FOX_REPORT_TOOL, foxReportFromEntry, parseFoxReport, parseFoxReportInput,
} from "./fox-reports.mjs";
const { registerFoxReports } = await createJiti(import.meta.url, { tryNative: false }).import("./fox-report-extension.mjs");

function fixture() {
  const entries = [];
  const notices = [];
  const handlers = {};
  const commands = {};
  let sessionId = "worker-one";
  const parent = { sessionId: "fox-parent", file: "/fox/session.jsonl" };
  const ctx = {
    cwd: "/project", isIdle: () => true,
    sessionManager: {
      ensureOnDisk: async () => {}, getSessionId: () => sessionId,
      getEntries: () => entries, getRecordedCwd: () => "/project",
    },
    ui: { notify: (message) => notices.push(message) },
  };
  registerFoxReports({
    on: (name, handler) => { handlers[name] = handler; },
    registerCommand: (name, command) => { commands[name] = command.handler; },
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    sendMessage: (message) => entries.push({ type: "custom_message", ...message }),
  }, { parentOf: () => sessionId === "worker-one" ? parent : null, coordinator: () => sessionId === "fox-parent" });
  return { entries, notices, handlers, commands, ctx, asParent: () => { sessionId = "fox-parent"; } };
}

test("reports validate their content and cannot supply another recipient", async () => {
  assert.throws(() => parseFoxReportInput({ status: "completed", summary: "done" }));
  assert.throws(() => parseFoxReportInput({ status: "progress", summary: "x".repeat(8001) }));
  assert.throws(() => parseFoxReportInput({ status: "result", summary: "result", evidence: [5] }));
  const f = fixture();
  await f.handlers.tool_call({ toolName: FOX_REPORT_TOOL, toolCallId: "call-one", input: { status: "progress", summary: "Milestone", parentSessionId: "forged-parent" } }, f.ctx);
  const report = foxReportFromEntry(f.entries[0]);
  assert.equal(report.parentSessionId, "fox-parent");
  assert.equal(report.sourceSessionId, "worker-one");
  assert.equal(report.source, "agent");
  assert.equal(report.toolCallId, "call-one");
  assert.equal(parseFoxReport({ ...report, id: "wrong-id" }), null);
  assert.equal(parseFoxReport({ ...report, sequence: -1 }), null);
  assert.ok(f.notices.some((notice) => notice.startsWith(FOX_REPORT_EVENT_PREFIX)));
});

test("native hooks publish acceptance, unanswered questions and a final result without scraping", async () => {
  const f = fixture();
  const prompt = await f.handlers.before_agent_start({ systemPrompt: ["base"] }, f.ctx);
  assert.match(prompt.systemPrompt.at(-1), /report_to_parent/);
  await f.handlers.tool_call({ toolName: "ask", input: { question: "Choose the target", options: ["one", "two"] } }, f.ctx);
  await f.handlers.agent_end({ messages: [{ role: "assistant", content: [{ type: "text", text: "Changed A, test B passed." }], stopReason: "stop" }] }, f.ctx);
  const reports = f.entries.map(foxReportFromEntry);
  assert.deepEqual(reports.map((report) => report.status), ["accepted", "needs_input", "result"]);
  assert.deepEqual(reports.map((report) => report.sequence), [1, 2, 3]);
  assert.match(reports[1].summary, /Choose the target/);
  assert.equal(reports[2].summary, "Changed A, test B passed.");
});

test("intermediate settles do not report completion and explicit results suppress redundant final reports", async () => {
  const f = fixture();
  const message = { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" };
  await f.handlers.agent_end({ willContinue: true, messages: [message] }, f.ctx);
  await f.handlers.agent_end({ awaitingAsyncWork: true, messages: [message] }, f.ctx);
  await f.handlers.agent_end({ isTerminal: false, messages: [message] }, f.ctx);
  assert.equal(f.entries.length, 0);
  await f.handlers.tool_call({ toolName: FOX_REPORT_TOOL, toolCallId: "final", input: { status: "result", summary: "Verified result" } }, f.ctx);
  await f.handlers.agent_end({ messages: [message] }, f.ctx);
  assert.equal(f.entries.length, 1);
  await f.handlers.agent_end({ messages: [{ ...message, stopReason: "error", errorMessage: "Provider failed" }] }, f.ctx);
  assert.equal(foxReportFromEntry(f.entries.at(-1)).status, "failed");
});

test("a worker cannot bypass FOX by delegating or sending untrusted instructions", async () => {
  const f = fixture();
  for (const toolName of ["new_session", "send_to_session"]) {
    assert.equal((await f.handlers.tool_call({ toolName }, f.ctx)).block, true);
  }
  assert.equal(await f.handlers.tool_call({ toolName: "task" }, f.ctx), undefined);
});

test("an explicit decision request is not overwritten by the worker's final text", async () => {
  const f = fixture();
  await f.handlers.tool_call({ toolName: FOX_REPORT_TOOL, input: { status: "needs_input", summary: "The owner must choose the target" } }, f.ctx);
  await f.handlers.agent_end({ messages: [{ role: "assistant", content: [{ type: "text", text: "Waiting for your decision." }], stopReason: "stop" }] }, f.ctx);
  assert.deepEqual(f.entries.map(foxReportFromEntry).map((report) => report.status), ["needs_input"]);
  await f.handlers.tool_call({ toolName: "ask", input: { questions: [{ question: "Choose", options: [{ label: "One" }, null] }] } }, f.ctx);
  await f.handlers.agent_end({ messages: [{ role: "assistant", content: [{ type: "text", text: "The chosen work was checked." }], stopReason: "stop" }] }, f.ctx);
  assert.equal(foxReportFromEntry(f.entries.at(-1)).status, "result");
});

test("receipt uses native messages, deduplicates replay, and records delayed reports without regressing the visible result", async () => {
  const f = fixture();
  for (const summary of ["Old progress", "Result"]) await f.handlers.tool_call({
    toolName: FOX_REPORT_TOOL, input: { status: "result", summary },
  }, f.ctx);
  const [old, latest] = f.entries.map(foxReportFromEntry);
  assert.equal(f.entries.every((entry) => entry.customType === FOX_REPORT_OUTBOX), true);
  f.asParent();
  const receive = (report) => f.commands[FOX_REPORT_COMMAND](JSON.stringify({ requestId: report.id, sessionId: "fox-parent", report }), f.ctx);
  await receive(latest);
  await receive(latest);
  await receive(old);
  assert.equal(f.entries.filter((entry) => entry.customType === FOX_REPORT_MESSAGE).length, 1);
  assert.equal(f.entries.filter((entry) => entry.customType === FOX_REPORT_RECEIPT).length, 1);
  await receive({ ...latest, summary: "Conflicting content" });
  assert.match(f.notices.at(-1), /different report/);
  await receive({ ...latest, parentSessionId: "other-fox" });
  assert.match(f.notices.at(-1), /does not match/);
});
