import { Worker } from "node:worker_threads";
import { statSync } from "node:fs";
import { join } from "node:path";
import { sessionPathKey } from "./paths";
import { SessionFileTooLargeError, SessionHistoryWorkerError } from "./session-history-errors";
import type { ResolveBlobOptions, SessionLoadError } from "./omp/session-files";
import type { SessionContext, SessionEntry, SessionTreeNode } from "./types";
import type { SessionHistoryCursor, SessionHistoryPage } from "./session-sync";
import type { SubagentHistoryEntry } from "./subagent-types";

type ViewOptions = { deferThinking?: boolean; deferToolResultImages?: boolean; includePreCompaction?: boolean };
export type HistoryRequest = { filePath: string } & (
  | { operation: "entries" | "boundary" | "loadError" | "subagents" }
  | { operation: "displayEntries"; options?: ResolveBlobOptions }
  | { operation: "display"; options?: ViewOptions }
  | { operation: "context"; leafId?: string; options?: ViewOptions }
  | { operation: "page"; cursor: SessionHistoryCursor | null; limit: number; leafId?: string; options?: ViewOptions }
  | { operation: "entry"; entryId: string }
  | { operation: "reference"; target: string; bashOutput: boolean }
);
interface HistoryResults {
  entries: SessionEntry[];
  displayEntries: SessionEntry[];
  boundary: { entryIds: string[] };
  loadError: SessionLoadError | undefined;
  display: { leafId: string | null; tree: SessionTreeNode[]; context: SessionContext };
  context: SessionContext;
  page: { history: SessionHistoryPage; leafId: string | null; tipId: string | null };
  subagents: SubagentHistoryEntry[];
  entry: SessionEntry | undefined;
  reference: boolean;
}
interface Work {
  id: number;
  request: HistoryRequest;
  environment: Record<string, string | undefined>;
  key: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}
interface Reply { id: number; value?: unknown; error?: { name?: string; message: string; code?: string } }

const MAX_WAITING = 32;
const ENVIRONMENT_KEYS = ["PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "XDG_DATA_HOME", "HOME", "USERPROFILE"];

/** One worker owns both caches, so neither cache budget multiplies with
 * concurrency. Only one request is posted at a time; the main queue is bounded. */
export class HistoryWorkerQueue {
  private worker?: Worker;
  private active?: Work;
  private readonly waiting: Work[] = [];
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly invalidated = new Set<string>();
  private invalidateAll = false;
  private nextId = 0;

  constructor(private readonly createWorker: () => Worker = () => {
    // Both the npm launcher and Electron start Next from the package root;
    // the launcher also supplies OMP_WEB_PACKAGE_DIR when cwd differs.
    const root = process.env.OMP_WEB_PACKAGE_DIR || process.cwd();
    return new Worker(join(root, "lib", "session-history-worker.mjs"), { execArgv: [] });
  }) {}

  run<T extends HistoryRequest>(request: T): Promise<HistoryResults[T["operation"]]> {
    const environment = Object.fromEntries(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
    let version = "";
    try {
      const stat = statSync(request.filePath);
      version = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch { /* Worker retains the lenient missing-file behavior. */ }
    const key = JSON.stringify([request, version, environment]);
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<HistoryResults[T["operation"]]>;
    if (this.active && this.waiting.length >= MAX_WAITING) return Promise.reject(new SessionHistoryWorkerError("session_history_busy"));
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.waiting.push({ id: ++this.nextId, request, environment, key, resolve, reject });
    this.inFlight.set(key, promise);
    this.dispatch();
    return promise as Promise<HistoryResults[T["operation"]]>;
  }

  invalidate(filePath?: string): void {
    // New callers must not join a read that began before the mutation.
    this.inFlight.clear();
    if (!this.worker) return;
    if (!filePath || this.invalidated.size >= MAX_WAITING) {
      this.invalidateAll = true;
      this.invalidated.clear();
    } else if (!this.invalidateAll) {
      this.invalidated.add(sessionPathKey(filePath));
    }
  }

  private dispatch(): void {
    if (this.active) return;
    const work = this.waiting.shift();
    if (!work) { this.worker?.unref(); return; }
    this.active = work;
    try {
      if (!this.worker) {
        const worker = this.createWorker();
        this.worker = worker;
        worker.on("message", (reply: Reply) => this.complete(worker, reply));
        worker.on("error", () => this.fail(worker));
        worker.on("exit", () => this.fail(worker));
      }
      this.worker.ref();
      this.worker.postMessage({
        id: work.id, request: work.request, environment: work.environment,
        invalidations: this.invalidateAll ? null : [...this.invalidated],
      });
      this.invalidateAll = false;
      this.invalidated.clear();
    } catch {
      this.fail(this.worker);
    }
  }

  private complete(worker: Worker, reply: Reply): void {
    if (worker !== this.worker) return;
    const work = this.active;
    if (!work || reply.id !== work.id) { this.fail(worker); return; }
    this.active = undefined;
    // Invalidation may have installed another promise with the same key.
    // Do not remove newer work's coalescing slot.
    if (!this.waiting.some((queued) => queued.key === work.key)) this.inFlight.delete(work.key);
    if (reply.error) {
      const error = reply.error.code === "session_file_too_large"
        ? new SessionFileTooLargeError(work.request.filePath)
        : Object.assign(new Error(reply.error.message), { name: reply.error.name || "Error", ...(reply.error.code ? { code: reply.error.code } : {}) });
      work.reject(error);
    } else {
      work.resolve(reply.value);
    }
    this.dispatch();
  }

  private fail(worker: Worker | undefined): void {
    if (worker !== this.worker) return;
    this.worker = undefined;
    const pending = this.active ? [this.active, ...this.waiting] : [...this.waiting];
    this.active = undefined;
    this.waiting.length = 0;
    this.inFlight.clear();
    this.invalidated.clear();
    this.invalidateAll = false;
    for (const work of pending) work.reject(new SessionHistoryWorkerError("session_history_worker_failed"));
    if (worker) void worker.terminate();
  }
}

declare global { var __ompHistoryWorkerQueue: HistoryWorkerQueue | undefined }

export function requestSessionHistory<T extends HistoryRequest>(request: T): Promise<HistoryResults[T["operation"]]> {
  return (globalThis.__ompHistoryWorkerQueue ??= new HistoryWorkerQueue()).run(request);
}

export function invalidateSessionHistory(filePath?: string): void {
  globalThis.__ompHistoryWorkerQueue?.invalidate(filePath);
}
