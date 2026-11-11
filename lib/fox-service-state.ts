import { storageRequest, storageRoots } from "./storage/client";
import type { StorageRequest, VersionedObservation } from "./storage/protocol";
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
const KIND_BY_NAME: Record<FoxEventKind, true> = { error: true, input: true, blocked: true, "worker-update": true };


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

/** Strict importer: corrupt budget/dedupe state must not create extra wakes. */
export function parseFoxServiceState(value: unknown): FoxServiceState {
  const invalid = () => { throw new Error("Invalid FOX observation state"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const raw = value as Record<string, unknown>;
  if (raw.version !== 1) return invalid();
  for (const field of ["seededAt", "lastTickAt", "lastWakeAt"]) {
    const at = raw[field];
    if (at !== null && (typeof at !== "string" || !Number.isFinite(Date.parse(at)))) return invalid();
  }
  if (!raw.daily || typeof raw.daily !== "object" || Array.isArray(raw.daily)) return invalid();
  const daily = raw.daily as Record<string, unknown>;
  if (typeof daily.date !== "string" || daily.date !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(daily.date)
    || typeof daily.count !== "number" || !Number.isSafeInteger(daily.count) || daily.count < 0) return invalid();
  if (!raw.seen || typeof raw.seen !== "object" || Array.isArray(raw.seen)
    || Object.entries(raw.seen).some(([key, at]) => !key || typeof at !== "string" || !Number.isFinite(Date.parse(at)))) return invalid();
  if (raw.pending !== undefined && (!Array.isArray(raw.pending) || raw.pending.some((event) => !parsePending(event)))) return invalid();
  return normalizeFoxServiceState(value);
}

function durableState(state: FoxServiceState): FoxServiceState {
  const normalized = parseFoxServiceState(state);
  const retryKeys = new Set(normalized.pending.map((event) => event.key));
  return { ...normalized, pending: [], seen: Object.fromEntries(Object.entries(normalized.seen).filter(([key]) => !retryKeys.has(key))) };
}

export function readFoxServiceState(home?: string): Promise<VersionedObservation> {
  return storageRequest({ operation: "foxObservation.get" }, storageRoots(home));
}

export async function writeFoxServiceState(state: FoxServiceState, expectedVersion: number, home?: string): Promise<VersionedObservation> {
  return storageRequest({ operation: "foxObservation.save", state: durableState(state), expectedVersion }, storageRoots(home));
}

export type FoxObservationClaimRequest = Omit<Extract<StorageRequest, { operation: "observation.claim" }>, "operation">;
export type FoxObservationSettleRequest = Omit<Extract<StorageRequest, { operation: "observation.settle" }>, "operation">;

export function claimFoxObservation(request: FoxObservationClaimRequest, home?: string): Promise<{ claimed: boolean; version: number }> {
  return storageRequest({ operation: "observation.claim", ...request }, storageRoots(home));
}

export async function settleFoxObservation(request: FoxObservationSettleRequest, home?: string): Promise<VersionedObservation> {
  return storageRequest({ operation: "observation.settle", ...request, ...(request.state ? { state: durableState(request.state) } : {}) }, storageRoots(home));
}
