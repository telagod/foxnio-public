import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { isRecord } from "./type-guards";
import { foxWorkspaceDir } from "./fox-workspace";

/**
 * The small durable ledger behind FOX's "dispatched work" panel. It records
 * what the resident chief handed to a project session, not the transcript:
 * one line per accepted new_session/send_to_session call, latest first.
 */
export type FoxDispatchKind = "new_session" | "send_to_session";
export type FoxDispatchStatus = "started" | "sent" | "waited" | "failed";

export interface FoxDispatchRecord {
  id: string;
  at: string;
  kind: FoxDispatchKind;
  sourceSessionId: string;
  targetSessionId: string;
  /** Worker-creation record id for a new_session, or the worker's task id for a follow-up. */
  taskId?: string;
  /** Best-known cwd of the target at dispatch time. */
  targetCwd?: string;
  /** The task text FOX sent, without the agent-tool attribution prefix. */
  task: string;
  delivery?: "prompt" | "steer" | "followUp";
  status: FoxDispatchStatus;
  /** Only present for a waited delivery that returned text. */
  responseText?: string;
}

export interface FoxDispatchInput {
  kind: FoxDispatchKind;
  sourceSessionId: string;
  targetSessionId: string;
  taskId?: string;
  targetCwd?: string;
  task: string;
  delivery?: "prompt" | "steer" | "followUp";
  status: FoxDispatchStatus;
  responseText?: string;
}

const FILE = "dispatches.json";
const MAX_RECORDS = 100;

export function foxDispatchPath(home?: string): string {
  return join(foxWorkspaceDir(home), FILE);
}

function asRecord(value: unknown): FoxDispatchRecord | null {
  if (!isRecord(value)) return null;
  const { id, at, kind, sourceSessionId, targetSessionId, taskId, targetCwd, task, delivery, status, responseText } = value;
  if (
    typeof id !== "string"
    || typeof at !== "string"
    || (kind !== "new_session" && kind !== "send_to_session")
    || typeof sourceSessionId !== "string"
    || typeof targetSessionId !== "string"
    || typeof task !== "string"
    || (status !== "started" && status !== "sent" && status !== "waited" && status !== "failed")
  ) {
    return null;
  }
  return {
    id,
    at,
    kind,
    sourceSessionId,
    targetSessionId,
    ...(typeof taskId === "string" && taskId ? { taskId } : {}),
    ...(typeof targetCwd === "string" && targetCwd ? { targetCwd } : {}),
    task,
    ...(delivery === "prompt" || delivery === "steer" || delivery === "followUp" ? { delivery } : {}),
    status,
    ...(typeof responseText === "string" ? { responseText } : {}),
  };
}

/** Latest-first, bounded. A missing/corrupt ledger is simply empty. */
export function readFoxDispatches(home?: string): FoxDispatchRecord[] {
  try {
    const path = foxDispatchPath(home);
    if (!existsSync(path)) return [];
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(asRecord)
      .filter((record): record is FoxDispatchRecord => record !== null)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, MAX_RECORDS);
  } catch {
    return [];
  }
}

export function isFoxDispatchTarget(taskId: string | undefined, targetSessionId: string, home?: string): boolean {
  if (!taskId) return false;
  return readFoxDispatches(home).some(
    (record) => record.kind === "new_session" && record.id === taskId && record.targetSessionId === targetSessionId,
  );
}

/**
 * Hide pre-policy `send_to_session` rows that never had a FOX-created worker,
 * and hide sends recorded before that worker existed. Only the worker creation
 * itself and later follow-ups belong in the brief.
 */
export function selectFoxDispatches(records: readonly FoxDispatchRecord[]): FoxDispatchRecord[] {
  const workerAt = new Map<string, number>();
  for (const record of records) {
    if (record.kind !== "new_session") continue;
    const at = Date.parse(record.at);
    const previous = workerAt.get(record.targetSessionId);
    if (previous === undefined || (Number.isFinite(at) && at < previous)) {
      workerAt.set(record.targetSessionId, at);
    }
  }
  return records.filter((record) => {
    if (record.kind === "new_session") return true;
    const created = workerAt.get(record.targetSessionId);
    if (created === undefined) return false;
    const at = Date.parse(record.at);
    return Number.isFinite(at) && at >= created;
  });
}

/**
 * Record an accepted dispatch. Ledger failures never fail the delivery: the
 * task already reached the target, so this is presentation-only state.
 */
export function recordFoxDispatch(input: FoxDispatchInput, home?: string): void {
  try {
    const at = new Date().toISOString();
    const id = randomUUID();
    const record: FoxDispatchRecord = {
      id,
      at,
      kind: input.kind,
      sourceSessionId: input.sourceSessionId,
      targetSessionId: input.targetSessionId,
      ...(input.kind === "new_session" ? { taskId: id } : input.taskId ? { taskId: input.taskId } : {}),
      task: input.task.replace(/\s+/g, " ").trim().slice(0, 500),
      status: input.status,
      ...(input.targetCwd ? { targetCwd: input.targetCwd } : {}),
      ...(input.delivery ? { delivery: input.delivery } : {}),
      ...(input.responseText ? { responseText: input.responseText.slice(0, 2_000) } : {}),
    };
    const dir = foxWorkspaceDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const records = [record, ...readFoxDispatches(home)].slice(0, MAX_RECORDS);
    const target = foxDispatchPath(home);
    const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
    writeFileSync(temp, `${JSON.stringify(records, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, target);
  } catch {
    // Presentation state only; never fail a delivered task.
  }
}
