import { randomUUID } from "node:crypto";
import type { FoxWorkerReport } from "../fox-report-types";
import type { RpcAvailableSlashCommand } from "../pi-types";
import { RpcCommandTimeoutError, type RpcFrame, type RpcProcess } from "./rpc-process";
import { FOX_REPORT_COMMAND, FOX_REPORT_REPLY_PREFIX } from "./fox-reports.mjs";

export function isFoxReportReply(frame: RpcFrame): boolean {
  return frame.type === "extension_ui_request" && frame.method === "notify"
    && typeof frame.message === "string" && frame.message.startsWith(FOX_REPORT_REPLY_PREFIX);
}

export class FoxReportAgentInvocationError extends Error {
  constructor() {
    super("An OMP input hook started the model instead of receiving the worker report");
  }
}

export async function deliverNativeFoxReport(
  proc: Pick<RpcProcess, "sendCommand" | "onFrame">,
  report: FoxWorkerReport,
  parentFile: string,
  timeoutMs = 10_000,
): Promise<void> {
  const catalog = await proc.sendCommand<{ commands?: RpcAvailableSlashCommand[] }>({ type: "get_available_commands" }, timeoutMs);
  if (!Array.isArray(catalog?.commands) || !catalog.commands.some((command) => command.name === FOX_REPORT_COMMAND && command.source === "extension")) {
    throw new Error("Native worker reporting is unavailable in this FOX runtime; restart it when idle");
  }
  const requestId = randomUUID();
  const reply = Promise.withResolvers<void>();
  const invocation = Promise.withResolvers<never>();
  let persistenceError: Error | null = null;
  let agentStarted = false;
  const timer = setTimeout(() => reply.reject(new RpcCommandTimeoutError(FOX_REPORT_COMMAND, timeoutMs)), timeoutMs);
  timer.unref?.();
  const unsubscribe = proc.onFrame((frame) => {
    if (frame.type === "agent_start") {
      agentStarted = true;
      invocation.reject(new FoxReportAgentInvocationError());
      reply.reject(new FoxReportAgentInvocationError());
    } else if (frame.type === "notice" && frame.source === "session-persistence" && frame.level === "error") {
      persistenceError = new Error(typeof frame.message === "string" ? frame.message : "OMP could not persist the worker report");
    } else if (isFoxReportReply(frame)) {
      let result;
      try { result = JSON.parse((frame.message as string).slice(FOX_REPORT_REPLY_PREFIX.length)); } catch { return; }
      if (result?.requestId !== requestId) return;
      if (typeof result.error === "string") reply.reject(new Error(result.error));
      else if (result.sessionId !== report.parentSessionId || result.reportId !== report.id) reply.reject(new Error("The report receipt has the wrong identity"));
      else reply.resolve();
    }
  });
  void reply.promise.catch(() => {});
  void invocation.promise.catch(() => {});
  try {
    const ack = await Promise.race([proc.sendCommand<{ agentInvoked?: boolean }>({
      type: "prompt", message: `/${FOX_REPORT_COMMAND} ${JSON.stringify({ requestId, sessionId: report.parentSessionId, parentFile, report })}`,
    }, timeoutMs), invocation.promise]);
    if (agentStarted || ack?.agentInvoked === true) throw new FoxReportAgentInvocationError();
    await reply.promise;
    if (persistenceError) throw persistenceError;
    if (agentStarted) throw new FoxReportAgentInvocationError();
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}
