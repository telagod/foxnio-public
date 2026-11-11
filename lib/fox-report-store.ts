import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { comparableProjectPath } from "./comparable-path";
import { scanJsonlLines } from "./jsonl-lines";
import { readSessionHeaderSync } from "./omp/session-files";
import { nativeSessionFamily, nativeSessionLineage } from "./omp/session-lineage";
import { foxWorkspaceDir } from "./fox-workspace";
import type { FoxReportView, FoxWorkerReport } from "./fox-report-types";
import type { SessionInfo } from "./types";
import {
  FOX_REPORT_MESSAGE, FOX_REPORT_OUTBOX, FOX_REPORT_RECEIPT, foxReportFromEntry, parseFoxReport, sameFoxReport,
} from "./omp/fox-reports.mjs";

interface ReportJournal {
  outbox: FoxWorkerReport[];
  received: Map<string, FoxWorkerReport>;
  conflicts: Set<string>;
  invalid: boolean;
}

interface PendingReport {
  report: FoxWorkerReport;
  workerFile: string;
  parentFile: string;
}

class FoxReportSourceError extends Error {}

interface RelayState {
  journals: Map<string, { stamp: string; loading: Promise<ReportJournal> }>;
  pending: Map<string, PendingReport>;
  errors: Map<string, string>;
  retry: Map<string, { at: number; attempts: number }>;
  listeners: Set<() => void>;
  deliver: ((report: FoxWorkerReport, parentFile: string) => Promise<void>) | null;
  timer: ReturnType<typeof setTimeout> | null;
  draining: Promise<void> | null;
  stopped: boolean;
}

declare global {
  var __foxReportRelay: RelayState | undefined;
}

function relay(): RelayState {
  return globalThis.__foxReportRelay ??= {
    journals: new Map(), pending: new Map(), errors: new Map(), retry: new Map(),
    listeners: new Set(), deliver: null, timer: null, draining: null, stopped: false,
  };
}

export function subscribeFoxReports(listener: () => void): () => void {
  relay().listeners.add(listener);
  return () => { relay().listeners.delete(listener); };
}

function changed(): void {
  for (const listener of relay().listeners) {
    try { listener(); } catch {}
  }
}

export function foxWorkerParent(workerFile: string) {
  const lineage = workerFile ? nativeSessionLineage(workerFile) : null;
  const worker = lineage?.[0].header;
  const origin = lineage?.at(-1)?.header;
  const foxCwd = comparableProjectPath(foxWorkspaceDir());
  if (!worker || !origin || comparableProjectPath(worker.cwd) === foxCwd || !origin.parentSession || !isAbsolute(origin.parentSession)) return null;
  const parent = readSessionHeaderSync(origin.parentSession);
  return parent && parent.id !== worker.id && comparableProjectPath(parent.cwd) === foxCwd
    ? { worker, parent, parentFile: origin.parentSession, lineage: lineage! } : null;
}

async function readSingleReportJournal(file: string): Promise<ReportJournal> {
  const stat = statSync(file);
  const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  const state = relay();
  const cached = state.journals.get(file);
  if (cached?.stamp === stamp) {
    const journal = await cached.loading;
    if (journal.conflicts instanceof Set) return journal;
    state.journals.delete(file);
  }
  const loading = (async () => {
    const journal: ReportJournal = { outbox: [], received: new Map(), conflicts: new Set(), invalid: false };
    await scanJsonlLines(file, {
      headBytes: 256, maxLineBytes: 512 * 1024,
      accept: (buffer, length) => /"type"\s*:\s*"custom(?:_message)?"/.test(buffer.toString("utf8", 0, length)),
      onLine: (line) => {
        let entry;
        try { entry = JSON.parse(line); } catch { journal.invalid = true; return; }
        if (![FOX_REPORT_OUTBOX, FOX_REPORT_MESSAGE, FOX_REPORT_RECEIPT].includes(entry.customType)) return;
        const report = foxReportFromEntry(entry) as FoxWorkerReport | null;
        if (!report) { journal.invalid = true; return; }
        if (entry.customType === FOX_REPORT_OUTBOX) journal.outbox.push(report);
        else {
          const prior = journal.received.get(report.id);
          if (prior && !sameFoxReport(prior, report)) {
            journal.invalid = true;
            journal.conflicts.add(report.id);
            journal.received.delete(report.id);
          } else if (!journal.conflicts.has(report.id)) journal.received.set(report.id, report);
        }
      },
    });
    return journal;
  })();
  state.journals.delete(file);
  state.journals.set(file, { stamp, loading });
  while (state.journals.size > 64) state.journals.delete(state.journals.keys().next().value!);
  try { return await loading; } catch (error) {
    if (state.journals.get(file)?.loading === loading) state.journals.delete(file);
    throw error;
  }
}

export async function readFoxReportJournal(file: string): Promise<ReportJournal> {
  const header = readSessionHeaderSync(file);
  if (!header || comparableProjectPath(header.cwd) !== comparableProjectPath(foxWorkspaceDir())) return readSingleReportJournal(file);
  const journals = await Promise.all(nativeSessionFamily(file).map(readSingleReportJournal));
  const merged: ReportJournal = { outbox: [], received: new Map(), conflicts: new Set(), invalid: false };
  for (const journal of journals) {
    merged.invalid ||= journal.invalid;
    for (const id of journal.conflicts) { merged.conflicts.add(id); merged.received.delete(id); }
    for (const [id, report] of journal.received) {
      const prior = merged.received.get(id);
      if (prior && !sameFoxReport(prior, report)) {
        merged.invalid = true;
        merged.conflicts.add(id);
        merged.received.delete(id);
      } else if (!merged.conflicts.has(id)) merged.received.set(id, report);
    }
  }
  return merged;
}

function belongsTo(report: FoxWorkerReport, parent: NonNullable<ReturnType<typeof foxWorkerParent>>): boolean {
  return parent.lineage.some(({ header }) => header.id === report.sourceSessionId) && report.parentSessionId === parent.parent.id
    && comparableProjectPath(report.cwd) === comparableProjectPath(parent.worker.cwd);
}

export async function foxWorkerReportView(workerFile: string): Promise<FoxReportView> {
  const parent = foxWorkerParent(workerFile);
  if (!parent) return { report: null, delivery: "unavailable", error: "The original FOX parent could not be resolved." };
  try {
    const journal = await readFoxReportJournal(workerFile);
    const report = journal.outbox.filter((item) => belongsTo(item, parent))
      .reduce<FoxWorkerReport | null>((latest, item) => {
        if (!latest) return item;
        if (latest.sourceSessionId === item.sourceSessionId) return item.sequence > latest.sequence ? item : latest;
        return parent.lineage.findIndex(({ header }) => header.id === item.sourceSessionId)
          < parent.lineage.findIndex(({ header }) => header.id === latest.sourceSessionId) ? item : latest;
      }, null);
    if (!report) return { report: null, delivery: "unavailable", ...(journal.invalid ? { error: "The native report journal contains invalid records." } : {}) };
    const received = (await readFoxReportJournal(parent.parentFile)).received.get(report.id);
    const error = relay().errors.get(parent.worker.id) ?? relay().errors.get(parent.parent.id);
    return {
      report, delivery: received && sameFoxReport(received, report) ? "received" : error ? "unavailable" : "pending",
      sourceSessionIds: parent.lineage.map(({ header }) => header.id),
      ...(error ? { error } : {}),
      ...(journal.invalid ? { error: "Some native report records could not be read." } : {}),
    };
  } catch (error) {
    return { report: null, delivery: "unavailable", error: error instanceof Error ? error.message : String(error) };
  }
}

export function configureFoxReportDelivery(deliver: NonNullable<RelayState["deliver"]>): void {
  relay().deliver = deliver;
  relay().stopped = false;
}

function schedule(delay = 0): void {
  const state = relay();
  if (state.stopped || !state.deliver || !state.pending.size) return;
  if (state.timer && delay === 0) { clearTimeout(state.timer); state.timer = null; }
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    void flushFoxReports().catch(() => {});
  }, delay);
  state.timer.unref?.();
}

export async function recoverFoxWorkerReports(workerFile: string): Promise<void> {
  const parent = foxWorkerParent(workerFile);
  if (!parent) return;
  const [source, target] = await Promise.all([readFoxReportJournal(workerFile), readFoxReportJournal(parent.parentFile)]);
  let added = false;
  for (const report of source.outbox) {
    if (!belongsTo(report, parent)) continue;
    if (target.conflicts.has(report.id)) {
      relay().errors.set(report.sourceSessionId, "Conflicting native report identity; no replacement was delivered.");
      continue;
    }
    const received = target.received.get(report.id);
    if (received) {
      if (!sameFoxReport(received, report)) relay().errors.set(parent.parent.id, "Conflicting native report identity; no replacement was delivered.");
      continue;
    }
    const existing = relay().pending.get(report.id);
    if (existing && !sameFoxReport(existing.report, report)) {
      relay().errors.set(parent.parent.id, "Conflicting worker report identity; delivery stopped.");
      continue;
    }
    relay().retry.delete(`worker:${report.sourceSessionId}`);
    if (!existing) {
      relay().pending.set(report.id, { report, workerFile, parentFile: parent.parentFile });
      added = true;
    }
  }
  if (added) { changed(); schedule(); }
}

export async function reconcileFoxReports(sessions: readonly SessionInfo[]): Promise<void> {
  const foxCwd = comparableProjectPath(foxWorkspaceDir());
  const workers = sessions.filter((session) => session.parentSessionId && comparableProjectPath(session.cwd) !== foxCwd && foxWorkerParent(session.path));
  for (let index = 0; index < workers.length; index += 8) {
    await Promise.all(workers.slice(index, index + 8).map(async (worker) => {
      try { await recoverFoxWorkerReports(worker.path); } catch (error) {
        relay().errors.set(worker.id, error instanceof Error ? error.message : String(error));
      }
    }));
  }
}

export async function acceptFoxReport(workerFile: string, value: unknown): Promise<FoxWorkerReport> {
  const report = parseFoxReport(value) as FoxWorkerReport | null;
  const parent = foxWorkerParent(workerFile);
  if (!report || !parent || !belongsTo(report, parent)) throw new Error("Worker report does not match its native session and parent");
  const source = await readFoxReportJournal(workerFile);
  if (!source.outbox.some((item) => item.id === report.id && sameFoxReport(item, report))) {
    throw new Error("OMP has not durably recorded this worker report");
  }
  await recoverFoxWorkerReports(workerFile);
  wakeFoxReportDelivery(report.parentSessionId);
  return report;
}

export function wakeFoxReportDelivery(parentSessionId: string): void {
  relay().retry.delete(parentSessionId);
  schedule();
}

export async function flushFoxReports(): Promise<void> {
  const state = relay();
  if (state.draining) return state.draining;
  if (state.stopped || !state.deliver) return;
  state.draining = (async () => {
    const parents = new Set([...state.pending.values()].map(({ report }) => report.parentSessionId));
    await Promise.all([...parents].map(async (parentId) => {
      if ((state.retry.get(parentId)?.at ?? 0) > Date.now()) return;
      const pending = [...state.pending.values()].filter(({ report }) => report.parentSessionId === parentId)
        .filter(({ report }) => (state.retry.get(`worker:${report.sourceSessionId}`)?.at ?? 0) <= Date.now())
        .sort((a, b) => b.report.sequence - a.report.sequence).slice(0, 50);
      for (const item of pending) {
        if (state.stopped) return;
        const sourceKey = `worker:${item.report.sourceSessionId}`;
        if ((state.retry.get(sourceKey)?.at ?? 0) > Date.now()) continue;
        try {
          const identity = foxWorkerParent(item.workerFile);
          if (!identity || !belongsTo(item.report, identity) || identity.parentFile !== item.parentFile) throw new FoxReportSourceError("The native worker lineage changed; the report was not redirected.");
          const outbox = await readFoxReportJournal(item.workerFile).catch((error) => {
            throw new FoxReportSourceError(error instanceof Error ? error.message : String(error));
          });
          if (!outbox.outbox.some((report) => sameFoxReport(report, item.report))) throw new FoxReportSourceError("The native outbox no longer contains this report.");
          const before = await readFoxReportJournal(item.parentFile);
          if (before.conflicts.has(item.report.id)) throw new FoxReportSourceError("Conflicting native report receipt");
          if (before.received.has(item.report.id)) {
            if (!sameFoxReport(before.received.get(item.report.id), item.report)) throw new FoxReportSourceError("Conflicting native report receipt");
          } else {
            await state.deliver!(item.report, item.parentFile);
            const after = await readFoxReportJournal(item.parentFile);
            if (!sameFoxReport(after.received.get(item.report.id), item.report)) throw new Error("OMP did not persist the report receipt");
          }
          state.pending.delete(item.report.id);
          state.errors.delete(parentId);
          state.errors.delete(item.report.sourceSessionId);
          state.retry.delete(parentId);
          state.retry.delete(sourceKey);
          changed();
        } catch (error) {
          if (error instanceof FoxReportSourceError) {
            const attempts = (state.retry.get(sourceKey)?.attempts ?? 0) + 1;
            state.retry.set(sourceKey, { attempts, at: Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6)) });
            state.errors.set(item.report.sourceSessionId, error.message);
            changed();
            continue;
          }
          const busy = error instanceof Error && /busy|settle|pending/i.test(error.message);
          const attempts = busy ? 0 : (state.retry.get(parentId)?.attempts ?? 0) + 1;
          state.retry.set(parentId, { attempts, at: Date.now() + (busy ? 250 : Math.min(30_000, 500 * 2 ** Math.min(attempts, 6))) });
          if (!busy) {
            state.errors.set(parentId, error instanceof Error ? error.message : String(error));
            changed();
          }
          break;
        }
      }
    }));
  })().finally(() => {
    state.draining = null;
    if (state.pending.size) {
      const next = [...state.pending.values()].reduce((soonest, { report }) => Math.min(soonest,
        Math.max(state.retry.get(report.parentSessionId)?.at ?? 0, state.retry.get(`worker:${report.sourceSessionId}`)?.at ?? 0)), Infinity);
      schedule(Math.max(250, next - Date.now()));
    }
  });
  return state.draining;
}

export function startFoxReportDelivery(): void {
  relay().stopped = false;
  schedule();
}

export async function stopFoxReportDelivery(): Promise<void> {
  relay().stopped = true;
  if (relay().timer) clearTimeout(relay().timer!);
  relay().timer = null;
  await relay().draining?.catch(() => {});
}
