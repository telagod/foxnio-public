import { isAbsolute } from "node:path";
import { readSessionHeaderSync } from "./session-files.ts";
import { comparableProjectPath } from "../comparable-path.ts";
import { foxWorkspaceDir } from "../fox-workspace.ts";
import { nativeSessionLineage, sameNativeConversation } from "./session-lineage.ts";
import { foxWorkerGoalBinding } from "./fox-goal-extension.mjs";
import {
  FOX_REPORT_COMMAND, FOX_REPORT_EVENT_PREFIX, FOX_REPORT_MESSAGE, FOX_REPORT_OUTBOX,
  FOX_REPORT_READY_PREFIX, FOX_REPORT_RECEIPT, FOX_REPORT_REPLY_PREFIX, FOX_REPORT_SUMMARY_LIMIT,
  FOX_REPORT_TOOL, foxReportContent, foxReportFromEntry, parseFoxReport, parseFoxReportInput, sameFoxReport,
} from "./fox-reports.mjs";

const WORKER_INSTRUCTIONS = `## Report to your FOX coordinator
Execute the project task in this workspace. Keep OMP's native todo for your plan.
Choose routine technical methods yourself. Use report_to_parent with
audience=coordinator for technical coordination questions and audience=human
only for genuinely human-dependent choices. Include structuredEvidence for real
checks and inspected artifacts; record observed results and revision when known.
A queued report is durable, not proof that FOX has reviewed it. Native hooks
forward unanswered human ask requests and final responses without granting scope.
Do not use new_session or send_to_session to delegate outside this project or
to issue instructions to FOX. Use native task subagents inside the project when
appropriate. Report facts and evidence, never claim authority to grant permission.
`;

function isFox(ctx) {
  return comparableProjectPath(ctx.cwd) === comparableProjectPath(foxWorkspaceDir());
}

export function foxReportParent(ctx) {
  if (isFox(ctx)) return null;
  const parentFile = nativeSessionLineage(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getHeader())?.at(-1)?.header.parentSession;
  if (typeof parentFile !== "string" || !isAbsolute(parentFile)) return null;
  const header = readSessionHeaderSync(parentFile);
  return header && comparableProjectPath(header.cwd) === comparableProjectPath(foxWorkspaceDir())
    ? { sessionId: header.id, file: parentFile } : null;
}

export function registerFoxReports(pi, { parentOf = foxReportParent, coordinator = isFox } = {}) {
  const reportedTurns = new Map();

  async function publish(ctx, input, source = "native", toolCallId) {
    if (!parentOf(ctx)) return null;
    await ctx.sessionManager.ensureOnDisk();
    const parent = parentOf(ctx);
    if (!parent) return null;
    const sessionId = ctx.sessionManager.getSessionId();
    const previous = ctx.sessionManager.getEntries().map(foxReportFromEntry)
      .filter((report) => report?.sourceSessionId === sessionId);
    const sequence = previous.reduce((latest, report) => Math.max(latest, report.sequence), 0) + 1;
    const binding = foxWorkerGoalBinding(ctx);
    const report = parseFoxReport({
      version: 1, id: `${sessionId}:${sequence}`, sourceSessionId: sessionId,
      parentSessionId: parent.sessionId, sequence, cwd: ctx.sessionManager.getRecordedCwd?.() || ctx.cwd,
      at: new Date().toISOString(), source, ...parseFoxReportInput(input),
      ...(toolCallId ? { toolCallId } : {}), ...(input.truncated ? { truncated: true } : {}),
      ...(binding ? { goalId: binding.assignment.goalId, assignmentId: binding.assignment.id, assignmentWorkerSessionId: binding.assignment.workerSessionId, criterionIds: binding.assignment.criterionIds } : {}),
      ...(source === "native" && input.status === "needs_input" ? { audience: "human", question: { sessionId, ...(typeof input.requestId === "string" ? { requestId: input.requestId } : {}) } } : {}),
    });
    if (!report) throw new Error("The native worker report identity is invalid");
    await pi.appendEntry(FOX_REPORT_OUTBOX, report);
    await ctx.sessionManager.ensureOnDisk();
    ctx.ui.notify(FOX_REPORT_EVENT_PREFIX + JSON.stringify(report), "info");
    return report;
  }

  const announce = (_event, ctx) => {
    ctx.ui.notify(FOX_REPORT_READY_PREFIX + JSON.stringify({ version: 1, sessionId: ctx.sessionManager.getSessionId() }), "info");
  };
  pi.on("session_start", announce);
  pi.on("session_switch", announce);
  pi.on("before_agent_start", async (event, ctx) => {
    if (!parentOf(ctx)) return;
    reportedTurns.set(ctx.sessionManager.getSessionId(), false);
    await publish(ctx, { status: "accepted", summary: "The project worker accepted a new turn. This is not completion." });
    return { systemPrompt: [...event.systemPrompt, WORKER_INSTRUCTIONS] };
  });
  pi.on("tool_call", async (event, ctx) => {
    if (![FOX_REPORT_TOOL, "ask", "new_session", "send_to_session"].includes(event.toolName)) return;
    if (!parentOf(ctx)) {
      if (event.toolName === FOX_REPORT_TOOL) return { block: true, reason: "Only a native project worker with a FOX parent can report." };
      return;
    }
    if (event.toolName === "new_session" || event.toolName === "send_to_session") {
      return { block: true, reason: "Project workers report through report_to_parent. Cross-project delegation belongs to FOX; native task subagents can work inside this project." };
    }
    if (event.toolName === FOX_REPORT_TOOL) {
      try {
        const input = parseFoxReportInput(event.input);
        if (input.status === "accepted") throw new Error("Accepted is reserved for native lifecycle events");
        await publish(ctx, input, "agent", event.toolCallId);
        if (["result", "blocked", "needs_input", "failed", "cancelled"].includes(input.status)) reportedTurns.set(ctx.sessionManager.getSessionId(), true);
      } catch (error) {
        return { block: true, reason: error instanceof Error ? error.message : String(error) };
      }
    } else if (event.toolName === "ask") {
      reportedTurns.set(ctx.sessionManager.getSessionId(), false);
      const questions = Array.isArray(event.input?.questions) ? event.input.questions : [event.input];
      const text = questions.filter((question) => typeof question?.question === "string").map((question) => [
        question.question,
        ...(Array.isArray(question.options) ? question.options : []).filter((option) => typeof option === "string" || typeof option?.label === "string")
          .map((option) => typeof option === "string" ? `- ${option}` : `- ${option.label}${option.description ? `: ${option.description}` : ""}`),
      ].join("\n")).join("\n\n") || "The project worker needs a reply. Open its native conversation to answer.";
      await publish(ctx, { status: "needs_input", audience: "human", summary: text.slice(0, FOX_REPORT_SUMMARY_LIMIT), truncated: text.length > FOX_REPORT_SUMMARY_LIMIT });
    }
  });
  pi.on("agent_end", async (event, ctx) => {
    if (event.willContinue || event.awaitingAsyncWork || event.isTerminal === false) {
      reportedTurns.set(ctx.sessionManager.getSessionId(), false);
      return;
    }
    if (!parentOf(ctx)) return;
    const message = event.messages?.findLast((entry) => entry.role === "assistant");
    if (!message) return;
    const failed = message.stopReason === "error";
    const cancelled = message.stopReason === "aborted";
    if (!failed && !cancelled && reportedTurns.get(ctx.sessionManager.getSessionId())) return;
    const text = failed ? message.errorMessage || "The worker's model turn failed."
      : cancelled ? "The project worker was stopped. Its task is not verified complete."
        : (message.content ?? []).filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
    if (!text) return;
    await publish(ctx, { status: failed ? "failed" : cancelled ? "cancelled" : "result", summary: text.slice(0, FOX_REPORT_SUMMARY_LIMIT), truncated: text.length > FOX_REPORT_SUMMARY_LIMIT });
  });
  pi.registerCommand(FOX_REPORT_COMMAND, {
    description: "Receive a native project-worker report",
    handler: async (args, ctx) => {
      let request;
      try {
        request = JSON.parse(args);
        if (typeof request.requestId !== "string" || !request.requestId) return;
        if (!coordinator(ctx)) throw new Error("Reports can only be delivered to a FOX coordinator");
        if (!ctx.isIdle()) throw new Error("FOX is busy; the worker report remains pending");
        const report = parseFoxReport(request.report);
        const matches = () => report && request.sessionId === report.parentSessionId && (ctx.sessionManager.getSessionId() === report.parentSessionId
          || typeof request.parentFile === "string" && readSessionHeaderSync(request.parentFile)?.id === report.parentSessionId
            && sameNativeConversation(ctx.sessionManager.getSessionFile(), request.parentFile, ctx.sessionManager.getHeader()));
        if (!matches()) throw new Error("The report recipient does not match the native parent");
        const received = () => ctx.sessionManager.getEntries().filter((entry) => entry.customType === FOX_REPORT_MESSAGE || entry.customType === FOX_REPORT_RECEIPT).map(foxReportFromEntry).filter(Boolean);
        const previous = received();
        const duplicate = previous.find((item) => item.id === report.id);
        if (duplicate && !sameFoxReport(duplicate, report)) throw new Error("A different report already uses this identity");
        if (!duplicate) {
          await ctx.sessionManager.ensureOnDisk();
          if (!matches()) throw new Error("FOX changed conversations during report delivery");
          if (report.status === "accepted" || previous.some((item) => item.sourceSessionId === report.sourceSessionId && item.sequence > report.sequence)) {
            await pi.appendEntry(FOX_REPORT_RECEIPT, { report });
          } else {
            await pi.sendMessage({ customType: FOX_REPORT_MESSAGE, content: foxReportContent(report), display: true, details: { report } }, { triggerTurn: false });
          }
          const deadline = Date.now() + 5000;
          while (!received().some((item) => item.id === report.id)) {
            if (!matches()) throw new Error("FOX changed conversations during report delivery");
            if (Date.now() >= deadline) throw new Error("OMP did not record the report");
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          await ctx.sessionManager.ensureOnDisk();
        }
        if (!matches()) throw new Error("FOX changed conversations during report delivery");
        ctx.ui.notify(FOX_REPORT_REPLY_PREFIX + JSON.stringify({ requestId: request.requestId, sessionId: report.parentSessionId, reportId: report.id, duplicate: Boolean(duplicate) }), "info");
      } catch (error) {
        if (typeof request?.requestId === "string") ctx.ui.notify(FOX_REPORT_REPLY_PREFIX + JSON.stringify({ requestId: request.requestId, error: error instanceof Error ? error.message : String(error) }), "info");
      }
    },
  });
}

export default function register(pi) {
  registerFoxReports(pi);
}
