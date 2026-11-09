// Read-only cross-project briefing.
//
// This module is pure: it takes the session list, the live-run snapshot, the
// project registry, and (optionally) notification history, and builds the
// payload used by FOX. It never reads session files again,
// never writes, and never starts an agent. The HTTP route supplies the data;
// the UI only renders this shape.
//
// Signal history is optional and is a `<sessionId>:<type>` replacement ledger,
// not an event stream, so it must never be the only source of "needs you".

import type { NotificationHistoryEntry } from "./notification-events";
import type { ManagedProject, SessionInfo } from "./types";
import type { FoxReportView, FoxWorkerReport } from "./fox-report-types";

export type BriefingItemKind = "error" | "input" | "blocked" | "activity";

export interface BriefingItem {
  /** Stable dedupe key (`<sessionId>:<kind>`). */
  id: string;
  kind: BriefingItemKind;
  sessionId: string;
  sessionName: string | null;
  projectKey: string;
  projectName: string;
  detail?: string;
  /** ISO timestamp. */
  at: string;
}

export interface ProjectBriefing {
  policyKey?: string;
  /** Stable project key (case-folded project root when available). */
  key: string;
  name: string;
  path: string;
  sessions: number;
  running: number;
  waiting: number;
  errors: number;
  unread: number;
  lastActivity: string | null;
  git?: { dirty: number; branch?: string };
}

export type FoxDispatchState = "started" | "sent" | "waited" | "running" | "done" | "failed" | "waiting" | "updated";

export interface FoxDispatchBrief {
  id: string;
  /** Stable worker-creation task ID used for follow-ups. */
  taskId: string;
  at: string;
  task: string;
  state: FoxDispatchState;
  targetSessionId: string;
  sessionName: string | null;
  projectName: string;
  projectKey?: string;
  delivery?: "prompt" | "steer" | "followUp";
}

export interface FoxWorkerBrief {
  sessionId: string;
  parentSessionId: string;
  title: string;
  cwd: string;
  projectKey: string;
  projectName: string;
  state: "running" | "waiting" | "error" | "idle";
  detail?: string;
  at: string;
  messageCount: number;
  report?: FoxWorkerReport;
  reportDelivery?: FoxReportView["delivery"];
  reportError?: string;
}

export interface Briefing {
  workers?: FoxWorkerBrief[];
  historicalWorkers?: FoxWorkerBrief[];
  generatedAt: string;
  totals: {
    projects: number;
    sessions: number;
    running: number;
    waiting: number;
    unread: number;
  };
  needsYou: BriefingItem[];
  projects: ProjectBriefing[];
  recent: BriefingItem[];
  /** Sessions running right now, with the task they were started for. */
  active?: BriefingItem[];
  /** Recent work FOX handed to project sessions. */
  dispatches?: FoxDispatchBrief[];
  /** Session activity in the last 24 hours, one bucket per hour (oldest first). */
  pulse: BriefingPulse;
  warnings?: string[];
}

export interface BriefingPulse {
  /** 24 hourly counts, oldest → newest. */
  hours: number[];
  /** Largest bucket, floored at 1 so a chart can scale without dividing by zero. */
  max: number;
}

/** One live session from the RPC registry. */
export interface LiveSessionState {
  id: string;
  running: boolean;
  /** Number of UI requests waiting for a human answer. */
  pendingInput: number;
  /** First pending dialog's title/message, when available. */
  pendingInputDetail?: string | null;
  /** Last failed run's message, or null after a successful/new run. */
  lastRunError?: string | null;
}

export interface BriefingInput {
  sessions: SessionInfo[];
  projects?: ManagedProject[];
  live?: LiveSessionState[];
  notifications?: NotificationHistoryEntry[];
  now?: number;
  days?: number;
  excludeSessionId?: string | null;
  warnings?: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const PULSE_HOURS = 24;
const RECENT_WINDOW_MS = DAY_MS;
const RECENT_LIMIT = 20;
const MAX_DETAIL = 180;

const ITEM_ORDER: Record<BriefingItemKind, number> = {
  error: 0,
  input: 1,
  blocked: 2,
  activity: 3,
};

function clampDays(value: number | undefined): number {
  if (!Number.isFinite(value)) return 7;
  return Math.min(30, Math.max(1, Math.trunc(value as number)));
}

function timeOf(iso: string | undefined): number {
  if (!iso) return 0;
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isoOf(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

/**
 * Hourly session-activity buckets for the last 24 hours. `lastMessageAt` is the
 * only activity timestamp the session list exposes; a session contributes to
 * the bucket its latest message falls in, which is enough to show the shape of
 * work without scanning transcripts.
 */
function buildPulse(sessions: SessionInfo[], now: number): BriefingPulse {
  const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const start = currentHour - (PULSE_HOURS - 1) * HOUR_MS;
  const hours = new Array<number>(PULSE_HOURS).fill(0);
  for (const session of sessions) {
    const at = timeOf(session.lastMessageAt ?? session.modified);
    if (!at || at < start || at >= currentHour + HOUR_MS) continue;
    const index = Math.floor((at - start) / HOUR_MS);
    if (index >= 0 && index < PULSE_HOURS) hours[index] += 1;
  }
  return { hours, max: Math.max(1, ...hours) };
}

function baseName(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function clipDetail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text;
}

function projectIdentity(session: SessionInfo): { key: string; path: string } {
  const path = session.projectRoot ?? session.cwd;
  return { key: session.projectKey ?? path, path };
}

function projectName(path: string, registry: Map<string, ManagedProject>): string {
  const entry = registry.get(path);
  return entry?.alias?.trim() || baseName(path);
}

/**
 * Build the read-only briefing. Deterministic for a fixed `now` and inputs;
 * every list is deduped and bounded.
 */
export function buildBriefing(input: BriefingInput): Briefing {
  const now = Number.isFinite(input.now) ? (input.now as number) : Date.now();
  const days = clampDays(input.days);
  const windowStart = now - days * DAY_MS;
  const recentStart = now - RECENT_WINDOW_MS;
  const sessions = input.sessions ?? [];
  const registry = new Map((input.projects ?? []).map((project) => [project.path, project]));
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const liveById = new Map((input.live ?? []).map((live) => [live.id, live]));

  // A session belongs to the briefing when it changed inside the requested
  // window, or when it is live right now. A live session whose last message is
  // old still matters: it is running.
  const relevantIds = new Set<string>();
  for (const session of sessions) {
    const changedAt = timeOf(session.lastMessageAt ?? session.modified);
    if (changedAt >= windowStart) relevantIds.add(session.id);
  }
  for (const live of liveById.values()) {
    if (sessionById.has(live.id)) relevantIds.add(live.id);
  }

  const projectBySession = new Map<string, ProjectBriefing>();
  const projectOrder: string[] = [];
  const lastActivityMs = new Map<string, number>();

  function ensureProject(session: SessionInfo): ProjectBriefing {
    const identity = projectIdentity(session);
    let project = projectBySession.get(identity.key);
    if (!project) {
      project = {
        key: identity.key,
        name: projectName(identity.path, registry),
        path: identity.path,
        sessions: 0,
        running: 0,
        waiting: 0,
        errors: 0,
        unread: 0,
        lastActivity: null,
      };
      projectBySession.set(identity.key, project);
      projectOrder.push(identity.key);
    }
    project.sessions += 1;
    const activityAt = timeOf(session.lastMessageAt ?? session.modified);
    if (activityAt > (lastActivityMs.get(identity.key) ?? 0)) {
      lastActivityMs.set(identity.key, activityAt);
      project.lastActivity = isoOf(activityAt);
    }
    return project;
  }

  for (const id of relevantIds) {
    const session = sessionById.get(id);
    if (session) ensureProject(session);
  }

  const needsYou = new Map<string, BriefingItem>();
  const activeItems = new Map<string, BriefingItem>();
  const errorSessions = new Set<string>();
  const liveErrorSessions = new Set<string>();
  const inputSessions = new Set<string>();

  function sessionItem(session: SessionInfo, kind: BriefingItemKind, detail?: string, at?: string): BriefingItem {
    const identity = projectIdentity(session);
    const project = projectBySession.get(identity.key);
    return {
      id: `${session.id}:${kind}`,
      kind,
      sessionId: session.id,
      sessionName: session.name ?? null,
      projectKey: identity.key,
      projectName: project?.name ?? projectName(identity.path, registry),
      detail,
      at: at ?? isoOf(now),
    };
  }

  // Live sessions: pending input wins over a stale unread notification. A
  // running session with no pending request is simply "running".
  for (const live of liveById.values()) {
    const session = sessionById.get(live.id);
    if (!session) continue;
    const project = projectBySession.get(projectIdentity(session).key);
    if (!project) continue;
    if (live.pendingInput > 0) {
      project.waiting += 1;
      inputSessions.add(session.id);
      const at = session.lastMessageAt ?? isoOf(now);
      needsYou.set(
        `${session.id}:input`,
        sessionItem(session, "input", clipDetail(live.pendingInputDetail ?? undefined), at),
      );
    } else if (live.running) {
      project.running += 1;
      activeItems.set(session.id, {
        ...sessionItem(session, "activity", clipDetail(session.firstMessage), session.lastMessageAt ?? isoOf(now)),
        id: `${session.id}:active`,
      });
    }
    if (live.lastRunError) {
      errorSessions.add(session.id);
      liveErrorSessions.add(session.id);
      const at = session.lastMessageAt ?? isoOf(now);
      needsYou.set(`${session.id}:error`, sessionItem(session, "error", clipDetail(live.lastRunError), at));
    }
  }

  // Unread notifications: an optional enrichment. An unread input on a live
  // session is stale (the live registry says no request is pending), so it is
  // skipped for "needs you"; it still counts as unread below.
  // A later completed/input entry (read or not) means that session resolved
  // whatever the older error was about — the history ledger keeps both ids.
  const resolvedAt = new Map<string, number>();
  for (const entry of input.notifications ?? []) {
    if (entry.event.type !== "completed" && entry.event.type !== "input") continue;
    const at = Number.isFinite(entry.at) ? entry.at : 0;
    if (at > (resolvedAt.get(entry.event.sessionId) ?? 0)) resolvedAt.set(entry.event.sessionId, at);
  }
  const unreadBySession = new Map<string, number>();
  for (const entry of input.notifications ?? []) {
    if (entry.read) continue;
    const session = sessionById.get(entry.event.sessionId);
    if (!session) continue;
    const project = projectBySession.get(projectIdentity(session).key);
    if (!project) continue;
    unreadBySession.set(session.id, (unreadBySession.get(session.id) ?? 0) + 1);
    if (entry.event.type === "error") {
      const live = liveById.get(session.id);
      // A live session with no recorded failure has recovered (or never failed).
      if (live && !live.lastRunError) continue;
      // A later completed/input notification already resolved this run.
      if ((resolvedAt.get(session.id) ?? 0) > entry.at) continue;
      errorSessions.add(session.id);
      if (liveErrorSessions.has(session.id)) continue;
      const at = Number.isFinite(entry.at) ? isoOf(entry.at) : isoOf(now);
      const item = sessionItem(session, "error", clipDetail(entry.event.detail), at);
      const existing = needsYou.get(item.id);
      if (!existing || timeOf(item.at) > timeOf(existing.at)) needsYou.set(item.id, item);
    } else if (entry.event.type === "input") {
      const live = liveById.get(session.id);
      if (live) continue; // live state is authoritative for a running session
      inputSessions.add(session.id);
      project.waiting += 1;
      const at = Number.isFinite(entry.at) ? isoOf(entry.at) : isoOf(now);
      needsYou.set(`${session.id}:input`, sessionItem(session, "input", clipDetail(entry.event.detail), at));
    }
  }
  for (const [sessionId, count] of unreadBySession) {
    const session = sessionById.get(sessionId);
    if (!session) continue;
    const project = projectBySession.get(projectIdentity(session).key);
    if (project) project.unread += count;
  }

  // Keep waiting/input counts aligned with the emitted items.
  for (const project of projectBySession.values()) {
    const waiting = [...inputSessions].filter((id) => {
      const session = sessionById.get(id);
      return session ? projectIdentity(session).key === project.key : false;
    }).length;
    project.waiting = Math.max(project.waiting, waiting);
  }
  for (const project of projectBySession.values()) project.errors = 0;
  for (const id of errorSessions) {
    const session = sessionById.get(id);
    if (!session) continue;
    const project = projectBySession.get(projectIdentity(session).key);
    if (project) project.errors += 1;
  }

  const needsYouItems = [...needsYou.values()]
    .filter((item) => !input.excludeSessionId || item.sessionId !== input.excludeSessionId)
    .sort((a, b) => ITEM_ORDER[a.kind] - ITEM_ORDER[b.kind] || timeOf(b.at) - timeOf(a.at));

  const recent: BriefingItem[] = [];
  for (const session of sessions) {
    const last = timeOf(session.lastMessageAt);
    if (!last || last < recentStart) continue;
    const identity = projectIdentity(session);
    const project = projectBySession.get(identity.key);
    if (!project) continue;
    recent.push({
      id: `${session.id}:activity`,
      kind: "activity",
      sessionId: session.id,
      sessionName: session.name ?? null,
      projectKey: identity.key,
      projectName: project.name,
      detail: clipDetail(session.firstMessage) ?? undefined,
      at: session.lastMessageAt as string,
    });
  }
  recent.sort((a, b) => timeOf(b.at) - timeOf(a.at));
  recent.splice(RECENT_LIMIT);

  const projects = projectOrder
    .map((key) => projectBySession.get(key))
    .filter((project): project is ProjectBriefing => project !== undefined)
    .sort((a, b) => timeOf(b.lastActivity ?? undefined) - timeOf(a.lastActivity ?? undefined) || a.name.localeCompare(b.name));

  const active = [...activeItems.values()].sort((a, b) => timeOf(b.at) - timeOf(a.at));

  const totals = projects.reduce(
    (sum, project) => ({
      projects: sum.projects + 1,
      sessions: sum.sessions + project.sessions,
      running: sum.running + project.running,
      waiting: sum.waiting + project.waiting,
      unread: sum.unread + project.unread,
    }),
    { projects: 0, sessions: 0, running: 0, waiting: 0, unread: 0 },
  );

  const warnings = input.warnings?.filter((warning) => warning.trim().length > 0);
  return {
    generatedAt: isoOf(now),
    totals,
    needsYou: needsYouItems,
    active,
    projects,
    recent,
    pulse: buildPulse(sessions, now),
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
}
