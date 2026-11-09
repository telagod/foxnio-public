import type { FoxWorkerBrief, LiveSessionState } from "./briefing";
import { comparableProjectPath } from "./comparable-path";
import type { SessionInfo } from "./types";
import type { FoxReportView } from "./fox-report-types";

export function nativeFoxWorkers(sessions: readonly SessionInfo[], live: readonly LiveSessionState[], foxSessionId: string | ReadonlySet<string> | null, reports: ReadonlyMap<string, FoxReportView> = new Map()): FoxWorkerBrief[] {
  if (!foxSessionId) return [];
  const liveById = new Map(live.map((session) => [session.id, session]));
  return sessions.filter((session) => session.parentSessionId && (typeof foxSessionId === "string" ? session.parentSessionId === foxSessionId : foxSessionId.has(session.parentSessionId))).map((session): FoxWorkerBrief => {
    const state = liveById.get(session.id);
    const project = session.projectRoot || session.cwd;
    const title = session.name || session.firstMessage.replace(/^\[From session [^\]]+ via foxnio agent tools\]:\s*/, "") || session.id;
    const view = reports.get(session.id);
    const report = view?.report && (view.report.sourceSessionId === session.id || view.sourceSessionIds?.includes(view.report.sourceSessionId))
      && view.report.parentSessionId === session.parentSessionId ? view.report : undefined;
    return {
      sessionId: session.id,
      parentSessionId: session.parentSessionId!,
      title: title.replace(/^FOX\s*[·:—-]\s*/i, "").replace(/\s+/g, " ").trim(),
      cwd: session.cwd,
      projectKey: comparableProjectPath(project),
      projectName: project.replace(/\\/g, "/").split("/").filter(Boolean).pop() || project,
      state: state?.pendingInput ? "waiting" : state?.running ? "running" : state?.lastRunError ? "error" : "idle",
      ...(state?.pendingInputDetail ? { detail: state.pendingInputDetail } : state?.lastRunError && !state.running ? { detail: state.lastRunError } : {}),
      at: session.lastMessageAt || session.modified || session.created,
      messageCount: session.messageCount,
      ...(report ? { report } : {}),
      ...(view ? { reportDelivery: view.delivery, ...(view.error ? { reportError: view.error } : {}) } : {}),
    };
  }).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}
