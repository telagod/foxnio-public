import type { Briefing, BriefingItem, FoxDispatchBrief, FoxDispatchState, LiveSessionState } from "./briefing";
import type { ChiefApproval, ChiefState, ChiefTicket } from "./chief-store";
import { comparableProjectPath } from "./comparable-path";

export type FoxWorkStatus = "pending" | "running" | "waiting" | "review" | "ended" | "updated" | "failed" | "done" | "dropped";

export interface FoxWork {
  id: string;
  title: string;
  projectKey: string;
  projectName: string;
  sessionId?: string;
  status: FoxWorkStatus;
  at: string;
  ticket?: ChiefTicket;
  dispatches: FoxDispatchBrief[];
}

export interface FoxAttention {
  id: string;
  title: string;
  projectKey: string;
  projectName: string;
  at: string;
  kind: "approval" | "error" | "input" | "blocked" | "review";
  approval?: ChiefApproval;
  signal?: BriefingItem;
  work?: FoxWork;
}

export type FoxSelection = { kind: "attention" | "work"; id: string };

export function shortFoxTitle(text: string): string {
  const line = text.trim().split(/\r?\n/, 1)[0].replace(/\s+/g, " ");
  return line.length > 84 ? `${line.slice(0, 83)}…` : line;
}

export function foxDispatchState(
  record: { status: "started" | "sent" | "waited" | "failed"; at: string },
  live: Pick<LiveSessionState, "running" | "pendingInput" | "lastRunError"> | undefined,
  lastActivity: string | null | undefined,
): FoxDispatchState {
  if (live?.lastRunError || record.status === "failed") return "failed";
  if (live?.pendingInput) return "waiting";
  if (live?.running) return "running";
  if (record.status === "waited") return "waited";
  if (lastActivity && Date.parse(lastActivity) > Date.parse(record.at)) return "updated";
  return record.status;
}

export function foxServiceHealth(
  status: { config: { enabled: boolean }; lastTickAt: string | null } | null,
  failed: boolean,
  now: number,
): "loading" | "unavailable" | "manual" | "starting" | "checking" | "stale" {
  if (failed) return "unavailable";
  if (!status) return "loading";
  if (!status.config.enabled) return "manual";
  if (!status.lastTickAt) return "starting";
  const at = Date.parse(status.lastTickAt);
  return Number.isFinite(at) && now - at < 150_000 && at <= now + 60_000 ? "checking" : "stale";
}

function dispatchStatus(state: FoxDispatchState): FoxWorkStatus {
  if (state === "started" || state === "sent") return "pending";
  if (state === "done" || state === "waited") return "ended";
  return state;
}

function ticketStatus(ticket: ChiefTicket): FoxWorkStatus {
  if (ticket.state === "working") return "running";
  if (ticket.state === "waiting_human") return "waiting";
  if (ticket.state === "review" || ticket.state === "done" || ticket.state === "dropped") return ticket.state;
  return "pending";
}

export function buildFoxWorkbench(briefing: Briefing | null, chief: ChiefState | null, projectKey = "") {
  const projects = briefing?.projects ?? [];
  const signals = [...(briefing?.active ?? []), ...(briefing?.needsYou ?? []), ...(briefing?.recent ?? [])];
  const signalBySession = new Map(signals.map((item) => [item.sessionId, item]));
  const work: FoxWork[] = [];
  const workerBySession = new Map<string, FoxWork>();
  const workByTicket = new Map<string, FoxWork>();
  const orderedDispatches = [...(briefing?.dispatches ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  for (const dispatch of orderedDispatches) {
    const previous = workerBySession.get(dispatch.targetSessionId);
    if (previous) {
      previous.dispatches.push(dispatch);
      continue;
    }
    const matches = projects.filter((project) => project.name === dispatch.projectName);
    const key = dispatch.projectKey ?? signalBySession.get(dispatch.targetSessionId)?.projectKey
      ?? (matches.length === 1 ? matches[0].key : "");
    const item: FoxWork = {
      id: `worker:${dispatch.targetSessionId}`,
      title: dispatch.sessionName || dispatch.task,
      projectKey: comparableProjectPath(key),
      projectName: dispatch.projectName,
      sessionId: dispatch.targetSessionId,
      status: dispatchStatus(dispatch.state),
      at: dispatch.at,
      dispatches: [dispatch],
    };
    work.push(item);
    workerBySession.set(dispatch.targetSessionId, item);
  }
  for (const ticket of chief?.tickets ?? []) {
    const worker = ticket.assigneeSessionId ? workerBySession.get(ticket.assigneeSessionId) : undefined;
    if (worker && !worker.ticket) {
      worker.ticket = ticket;
      if (["done", "dropped", "review", "waiting_human"].includes(ticket.state)) worker.status = ticketStatus(ticket);
      workByTicket.set(ticket.id, worker);
      continue;
    }
    const item: FoxWork = {
      id: `ticket:${ticket.id}`,
      title: ticket.title,
      projectKey: comparableProjectPath(ticket.projectRef),
      projectName: ticket.projectName,
      sessionId: ticket.assigneeSessionId,
      status: ticketStatus(ticket),
      at: ticket.updatedAt,
      ticket,
      dispatches: [],
    };
    work.push(item);
    workByTicket.set(ticket.id, item);
  }
  const attention: FoxAttention[] = [];
  for (const item of work) {
    if (!item.sessionId) continue;
    const needsInput = briefing?.needsYou.find((signal) => signal.sessionId === item.sessionId && signal.kind === "input");
    const failed = briefing?.needsYou.some((signal) => signal.sessionId === item.sessionId && signal.kind === "error");
    if (needsInput) item.status = "waiting";
    else if (failed) item.status = "failed";
    else if (briefing?.active?.some((signal) => signal.sessionId === item.sessionId)) item.status = "running";
  }
  const approvalTickets = new Set<string>();
  for (const approval of chief?.approvals ?? []) {
    if (approval.state !== "pending") continue;
    approvalTickets.add(approval.ticketId);
    attention.push({
      id: `approval:${approval.id}`, title: approval.title, kind: "approval",
      projectKey: comparableProjectPath(approval.projectRef), projectName: approval.projectName,
      at: approval.createdAt, approval, work: workByTicket.get(approval.ticketId),
    });
  }
  const attentionSessions = new Set<string>();
  for (const signal of briefing?.needsYou ?? []) {
    attentionSessions.add(signal.sessionId);
    attention.push({
      id: `signal:${signal.id}`, title: signal.sessionName || signal.detail || signal.sessionId,
      projectKey: comparableProjectPath(signal.projectKey), projectName: signal.projectName,
      at: signal.at, kind: signal.kind === "activity" ? "input" : signal.kind,
      signal, work: workerBySession.get(signal.sessionId),
    });
  }
  for (const item of work) {
    if (!item.ticket || approvalTickets.has(item.ticket.id) || (item.sessionId && attentionSessions.has(item.sessionId))) continue;
    if (item.status !== "waiting" && item.status !== "review") continue;
    attention.push({
      id: `ticket:${item.ticket.id}`, title: item.title, projectKey: item.projectKey,
      projectName: item.projectName, at: item.at,
      kind: item.status === "review" ? "review" : "blocked", work: item,
    });
  }
  const matchesProject = (item: { projectKey: string }) => !projectKey || comparableProjectPath(item.projectKey) === comparableProjectPath(projectKey);
  const ownedSessions = new Set(work.flatMap((item) => item.sessionId ? [item.sessionId] : []));
  const priority = { approval: 0, input: 1, error: 2, blocked: 3, review: 4 };
  attention.sort((a, b) => priority[a.kind] - priority[b.kind] || Date.parse(a.at) - Date.parse(b.at));
  work.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return {
    attention: attention.filter(matchesProject),
    work: work.filter(matchesProject),
    otherActive: (briefing?.active ?? []).filter((item) => !ownedSessions.has(item.sessionId) && matchesProject(item)),
    recent: (briefing?.recent ?? []).filter((item) => !ownedSessions.has(item.sessionId) && !attentionSessions.has(item.sessionId) && matchesProject(item)),
  };
}
