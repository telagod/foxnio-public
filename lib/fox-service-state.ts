import { readFileSync } from "fs";
import { join } from "path";
import { foxWorkspaceDir } from "./fox-workspace";
import { writeFileAtomic } from "./fs-atomic";
import {
  emptyFoxServiceState,
  MAX_PENDING_EVENTS,
  MAX_SEEN_EVENTS,
  type FoxEventKind,
  type FoxServicePending,
  type FoxServiceState,
} from "./fox-service-core";

/**
 * Durable observation state for the resident service. This is not a task
 * store: it only remembers which attention events have already been surfaced,
 * and the daily message count. Pending retries live only inside the engine.
 */
const FILE = "service-state.json";
const KIND_BY_NAME: Record<FoxEventKind, true> = { error: true, input: true, blocked: true, "worker-update": true };

export function foxServiceStatePath(home?: string): string {
  return join(foxWorkspaceDir(home), FILE);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function parsePending(value: unknown): FoxServicePending | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.key !== "string" || typeof raw.sessionId !== "string" || typeof raw.kind !== "string" || !Object.hasOwn(KIND_BY_NAME, raw.kind as FoxEventKind)) return null;
  if (typeof raw.projectName !== "string" || typeof raw.at !== "string") return null;
  return {
    key: raw.key,
    kind: raw.kind as FoxEventKind,
    sessionId: raw.sessionId,
    sessionName: typeof raw.sessionName === "string" ? raw.sessionName : null,
    projectName: raw.projectName,
    ...(typeof raw.detail === "string" && raw.detail ? { detail: raw.detail } : {}),
    at: raw.at,
    firstSeenAt: typeof raw.firstSeenAt === "string" ? raw.firstSeenAt : raw.at,
    attempts: typeof raw.attempts === "number" && Number.isFinite(raw.attempts) ? Math.max(0, Math.trunc(raw.attempts)) : 0,
  };
}

export function normalizeFoxServiceState(value: unknown): FoxServiceState {
  if (!value || typeof value !== "object") return emptyFoxServiceState();
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) return emptyFoxServiceState();

  const seen: Record<string, string> = {};
  if (raw.seen && typeof raw.seen === "object") {
    const entries = Object.entries(raw.seen as Record<string, unknown>)
      .filter(([, at]) => typeof at === "string")
      .sort((a, b) => Date.parse(b[1] as string) - Date.parse(a[1] as string))
      .slice(0, MAX_SEEN_EVENTS);
    for (const [key, at] of entries) seen[key] = at as string;
  }

  const pending = Array.isArray(raw.pending)
    ? raw.pending.map(parsePending).filter((item): item is FoxServicePending => item !== null).slice(0, MAX_PENDING_EVENTS)
    : [];

  const daily = raw.daily && typeof raw.daily === "object" ? raw.daily as Record<string, unknown> : {};
  const dailyDate = typeof daily.date === "string" ? daily.date : "";
  const dailyCount = typeof daily.count === "number" && Number.isFinite(daily.count) ? Math.max(0, Math.trunc(daily.count)) : 0;

  return {
    version: 1,
    seededAt: stringOrNull(raw.seededAt),
    lastTickAt: stringOrNull(raw.lastTickAt),
    lastWakeAt: stringOrNull(raw.lastWakeAt),
    daily: { date: dailyDate, count: dailyCount },
    seen,
    pending,
  };
}

export function readFoxServiceState(home?: string): FoxServiceState {
  try {
    return normalizeFoxServiceState(JSON.parse(readFileSync(foxServiceStatePath(home), "utf8")));
  } catch {
    return emptyFoxServiceState();
  }
}

export function writeFoxServiceState(state: FoxServiceState, home?: string): void {
  const normalized = normalizeFoxServiceState(state);
  const path = foxServiceStatePath(home);
  const { pending, ...durable } = normalized;
  const retryKeys = new Set(pending.map((event) => event.key));
  durable.seen = Object.fromEntries(Object.entries(durable.seen).filter(([key]) => !retryKeys.has(key)));
  writeFileAtomic(path, JSON.stringify(durable));
}
