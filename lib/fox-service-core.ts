import type { Briefing, BriefingItem } from "./briefing";
import type { FoxServiceConfig } from "./fox-service-config";

/**
 * Pure planning for the resident FOX service. All I/O (sessions, RPC, files)
 * lives in fox-service.ts; this module decides whether a tick should wake FOX,
 * coalesces events and enforces quiet hours and the daily cap. Keeping it pure
 * makes those rules testable without starting an agent.
 */

export type FoxEventKind = "error" | "input" | "blocked" | "worker-update";

export interface FoxEvent {
  /** Stable occurrence key; a resolved event that reappears gets a new key. */
  key: string;
  kind: FoxEventKind;
  sessionId: string;
  sessionName: string | null;
  /** Canonical project root; observation context, never a task-store key. */
  projectRef?: string;
  projectName: string;
  detail?: string;
  at: string;
}

export interface FoxServicePending extends FoxEvent {
  firstSeenAt: string;
  attempts: number;
}

export interface FoxServiceState {
  version: 1;
  /** Null until the first tick has baselined the existing portfolio. */
  seededAt: string | null;
  lastTickAt: string | null;
  lastWakeAt: string | null;
  daily: { date: string; count: number };
  /** event key → last time it was observed. Bounded. */
  seen: Record<string, string>;
  /** In-memory events observed while quiet/busy or after a failed wake. */
  pending: FoxServicePending[];
}

export interface FoxTickInput {
  events: FoxEvent[];
  state: FoxServiceState;
  config: FoxServiceConfig;
  now: number;
  /** A live FOX turn or a FOX dialog is still waiting for the human. */
  foxBusy: boolean;
}

export type FoxTickReason = "seeded" | "disabled" | "busy" | "quiet" | "cap" | "no-events" | "wake" | "wake-failed";

export interface FoxTickPlan {
  state: FoxServiceState;
  wake: { events: FoxEvent[]; message: string } | null;
  reason: FoxTickReason;
}

export const MAX_SEEN_EVENTS = 200;
export const MAX_PENDING_EVENTS = 20;
const MAX_WAKE_ATTEMPTS = 3;

const KIND_ORDER: Record<FoxEventKind, number> = { error: 0, input: 1, blocked: 2, "worker-update": 3 };

export function emptyFoxServiceState(): FoxServiceState {
  return {
    version: 1,
    seededAt: null,
    lastTickAt: null,
    lastWakeAt: null,
    daily: { date: "", count: 0 },
    seen: {},
    pending: [],
  };
}

export function eventKey(item: Pick<BriefingItem, "kind" | "sessionId" | "at" | "detail">): string {
  return JSON.stringify([item.kind, item.sessionId, item.at, item.detail ?? ""]);
}

/** Errors > waiting-for-input > blocked, newest first inside each kind. */
export function extractFoxEvents(briefing: Pick<Briefing, "needsYou" | "workers">): FoxEvent[] {
  const byKey = new Map<string, FoxEvent>();
  for (const item of briefing.needsYou) {
    if (item.kind !== "error" && item.kind !== "input" && item.kind !== "blocked") continue;
    const key = eventKey(item);
    if (byKey.has(key)) continue;
    byKey.set(key, {
      key,
      kind: item.kind,
      sessionId: item.sessionId,
      sessionName: item.sessionName,
      projectRef: item.projectKey,
      projectName: item.projectName,
      ...(item.detail ? { detail: item.detail } : {}),
      at: item.at,
    });
  }
  for (const worker of briefing.workers ?? []) {
    const report = worker.report;
    if (!report || report.status === "accepted" || worker.reportDelivery !== "received") continue;
    const key = JSON.stringify(["worker-report", report.id]);
    byKey.set(key, {
      key, kind: "worker-update", sessionId: worker.sessionId, sessionName: worker.title,
      projectRef: worker.projectKey, projectName: worker.projectName, at: report.at,
      detail: `Worker reported ${report.status}: ${report.summary.slice(0, 1000)}. This is reported evidence, not independently verified completion.`,
    });
  }
  return [...byKey.values()].sort((a, b) =>
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || Date.parse(b.at) - Date.parse(a.at)
    || a.sessionId.localeCompare(b.sessionId),
  );
}

export function localDayKey(now: number): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function minutesOf(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** Local-time quiet window; an end before the start wraps midnight. */
export function isQuietAt(now: number, quietStart: string, quietEnd: string): boolean {
  const start = minutesOf(quietStart);
  const end = minutesOf(quietEnd);
  if (start === null || end === null || start === end) return false;
  const date = new Date(now);
  const minutes = date.getHours() * 60 + date.getMinutes();
  return start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

function trimSeen(seen: Record<string, string>): Record<string, string> {
  const entries = Object.entries(seen)
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    .slice(0, MAX_SEEN_EVENTS);
  return Object.fromEntries(entries);
}

function trimPending(pending: FoxServicePending[]): FoxServicePending[] {
  return pending
    .slice()
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, MAX_PENDING_EVENTS);
}

function addSeen(seen: Record<string, string>, events: readonly FoxEvent[], nowIso: string): Record<string, string> {
  const next = { ...seen };
  for (const event of events) next[event.key] = nowIso;
  return trimSeen(next);
}

function withPending(state: FoxServiceState, pending: FoxServicePending[], nowIso: string): FoxServiceState {
  return { ...state, pending: trimPending(pending), lastTickAt: nowIso };
}

function formatEvent(event: FoxEvent): string {
  const detail = event.detail ? ` — ${event.detail}` : "";
  return `- [${event.kind}] ${event.projectName} · ${event.sessionName ?? event.sessionId}${detail}`;
}

export function formatFoxWakeMessage(events: readonly FoxEvent[], nowIso: string): string {
  return [
    `[FOX proactive check — ${nowIso}]`,
    "New attention since your last check:",
    ...events.map(formatEvent),
    "",
    "This is a proactive wake, not a message the user just sent. Use worker reports already delivered to this conversation and the report summaries in BRIEFING.md. Read a worker conversation only to verify missing evidence or recover a broken reporting channel, not to infer routine progress. Update your native todo only when the evidence justifies it, then report meaningful changes briefly. Never call ask, new_session or send_to_session during this check. Idle or new activity is not proof of task completion.",
  ].join("\n");
}

/**
 * Advance the service by one observation. The returned state is what should be
 * persisted unless the wake fails; `wake` is the exact prompt to deliver.
 */
export function planFoxTick(input: FoxTickInput): FoxTickPlan {
  const nowIso = new Date(input.now).toISOString();
  const current = input.events;
  const currentKeys = new Set(current.map((event) => event.key));

  if (!input.state.seededAt) {
    const seeded = withPending({
      ...input.state,
      seededAt: nowIso,
      daily: { date: localDayKey(input.now), count: input.state.daily.count },
      seen: addSeen(input.state.seen, current, nowIso),
    }, [], nowIso);
    return { state: seeded, wake: null, reason: "seeded" };
  }

  // While disabled, observe and remember everything. Enabling later must not
  // replay an old backlog; the dashboard already shows those items.
  if (!input.config.enabled) {
    return {
      state: withPending({
        ...input.state,
        daily: { date: localDayKey(input.now), count: input.state.daily.date === localDayKey(input.now) ? input.state.daily.count : 0 },
        seen: addSeen(input.state.seen, current, nowIso),
      }, [], nowIso),
      wake: null,
      reason: "disabled",
    };
  }

  const pending = input.state.pending.filter((event) => currentKeys.has(event.key));
  const pendingKeys = new Set(pending.map((event) => event.key));
  for (const event of current) {
    if (input.state.seen[event.key] || pendingKeys.has(event.key)) continue;
    pending.push({ ...event, firstSeenAt: nowIso, attempts: 0 });
    pendingKeys.add(event.key);
  }

  const seen = addSeen(input.state.seen, current.filter((event) => !input.state.seen[event.key]), nowIso);
  if (pending.length === 0) {
    return {
      state: withPending({ ...input.state, seen }, [], nowIso),
      wake: null,
      reason: "no-events",
    };
  }

  const bounded = trimPending(pending);
  if (input.foxBusy) {
    return { state: withPending({ ...input.state, seen }, bounded, nowIso), wake: null, reason: "busy" };
  }
  if (isQuietAt(input.now, input.config.quietStart, input.config.quietEnd)) {
    return { state: withPending({ ...input.state, seen }, bounded, nowIso), wake: null, reason: "quiet" };
  }

  const today = localDayKey(input.now);
  const count = input.state.daily.date === today ? input.state.daily.count : 0;
  if (count >= input.config.maxDailyMessages) {
    return {
      state: withPending({
        ...input.state,
        daily: { date: today, count },
        seen: addSeen(seen, bounded, nowIso),
      }, [], nowIso),
      wake: null,
      reason: "cap",
    };
  }

  const events = bounded
    .slice()
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || Date.parse(b.at) - Date.parse(a.at));
  return {
    state: withPending({
      ...input.state,
      daily: { date: today, count: count + 1 },
      lastWakeAt: nowIso,
      seen,
    }, [], nowIso),
    wake: { events, message: formatFoxWakeMessage(events, nowIso) },
    reason: "wake",
  };
}

/** Keep a wake pending after a delivery failure; stop retrying a poison event. */
export function recordWakeFailure(state: FoxServiceState, events: readonly FoxEvent[], now: number): FoxServiceState {
  const nowIso = new Date(now).toISOString();
  const pending = new Map<string, FoxServicePending>();
  for (const event of state.pending) pending.set(event.key, event);
  for (const event of events) {
    const previous = pending.get(event.key);
    const attempts = (previous?.attempts ?? 0) + 1;
    if (attempts < MAX_WAKE_ATTEMPTS) {
      pending.set(event.key, { ...event, firstSeenAt: previous?.firstSeenAt ?? nowIso, attempts });
    } else {
      pending.delete(event.key);
    }
  }
  return withPending({ ...state, seen: addSeen(state.seen, events, nowIso) }, [...pending.values()], nowIso);
}
