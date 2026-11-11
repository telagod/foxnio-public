import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { getAgentDir, getSessionsDir } from '../omp/paths';
import { foxWorkspaceDir } from '../fox-workspace';
import { StorageError, isStorageMutation, type StorageRequest, type StorageResults, type StorageRoots, type DataCursor } from './protocol';

interface Work { id: number; request: StorageRequest; resolve: (value: unknown) => void; reject: (reason: unknown) => void; key?: string }
interface WorkerReply { id?: number; value?: unknown; head?: DataCursor; error?: { code: string; message: string; outcome?: 'not_committed' | 'uncertain' } }
function canonicalRoot(path: string): string { return existsSync(path) ? realpathSync(path) : resolve(path); }
export function storageRoots(home?: string): StorageRoots {
  const agentDir = home === undefined ? getAgentDir() : join(home, '.omp', 'agent');
  return { agentDir: canonicalRoot(agentDir), sessionsDir: canonicalRoot(home === undefined ? getSessionsDir() : join(agentDir, 'sessions')), foxDir: canonicalRoot(foxWorkspaceDir(home)) };
}

/** One admitted request, 64 waiting; an admitted mutation is never replayed. */
export class StorageWorkerClient {
  private worker?: Worker;
  private active?: Work;
  private readonly waiting: Work[] = [];
  private readonly scans = new Map<string, Promise<unknown>>();
  private nextId = 0;
  private closed = false;
  private workerOwner?: string;
  private abandonedOwners: string[] = [];
  private terminating?: Promise<number>;
  constructor(private readonly roots: StorageRoots, private readonly createWorker: (identity: { owner: string; abandonedOwners: string[] }) => Worker = identity => new Worker(join(process.env.OMP_WEB_PACKAGE_DIR || process.cwd(), 'lib', 'storage', 'worker.mjs'), { workerData: { roots, identity }, execArgv: [] }), private readonly onHead?: (cursor: DataCursor) => void) {}
  request<T extends StorageRequest>(request: T): Promise<StorageResults[T['operation']]> {
    if (this.closed) return Promise.reject(new StorageError('storage_unavailable', 'Storage client is closed', 'not_committed'));
    const key = request.operation === 'index.scan' ? JSON.stringify(request) : undefined;
    const shared = key ? this.scans.get(key) : undefined;
    if (shared) return shared as Promise<StorageResults[T['operation']]>;
    if ((this.active || this.terminating) && this.waiting.length >= 64) return Promise.reject(new StorageError('storage_busy', 'Storage queue has 64 waiting requests', 'not_committed'));
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    this.waiting.push({ id: ++this.nextId, request, resolve, reject, key });
    if (key) this.scans.set(key, promise);
    this.dispatch(); return promise as Promise<StorageResults[T['operation']]>;
  }
  private dispatch(): void {
    if (this.active || this.closed || this.terminating) return;
    // An ingestion continuation never prevents already queued app commands from running.
    const priority = this.waiting.findIndex(work => work.request.operation !== 'index.scan');
    const work = this.waiting.splice(priority < 0 ? 0 : priority, 1)[0];
    if (!work) { this.worker?.unref(); return; }
    this.active = work;
    let posted = false;
    try {
      if (!this.worker) {
        this.workerOwner = randomUUID();
        const worker = this.createWorker({ owner: this.workerOwner, abandonedOwners: this.abandonedOwners }); this.worker = worker;
        worker.on('message', (reply: WorkerReply) => this.receive(worker, reply));
        worker.on('error', error => this.fail(worker, error));
        worker.on('exit', code => this.fail(worker, new Error(`Storage worker exited (${code})`)));
      }
      this.worker.ref(); this.worker.postMessage({ id: work.id, request: work.request }); posted = true;
    } catch (error) { this.fail(this.worker, error, posted); }
  }
  private receive(worker: Worker, reply: WorkerReply): void {
    if (worker !== this.worker) return;
    if (reply.head) this.onHead?.(reply.head);
    const work = this.active;
    if (!work || reply.id !== work.id) { this.fail(worker, new Error('Storage worker protocol mismatch')); return; }
    this.active = undefined; if (work.key) this.scans.delete(work.key);
    if (!reply.error) this.abandonedOwners = [];
    if (reply.error) work.reject(new StorageError(reply.error.code, reply.error.message, reply.error.outcome)); else work.resolve(reply.value);
    this.dispatch();
  }
  private fail(worker: Worker | undefined, cause: unknown, admitted = true): void {
    if (worker !== this.worker) return;
    this.worker = undefined;
    if (this.workerOwner) this.abandonedOwners.push(this.workerOwner);
    this.workerOwner = undefined;
    const active = this.active; this.active = undefined;
    const message = cause instanceof Error ? cause.message : String(cause);
    if (active) active.reject(new StorageError('storage_unavailable', message, isStorageMutation(active.request) && admitted ? 'uncertain' : 'not_committed'));
    for (const work of this.waiting.splice(0)) work.reject(new StorageError('storage_unavailable', message, 'not_committed'));
    this.scans.clear();
    if (worker) {
      const terminating = worker.terminate(); this.terminating = terminating;
      void terminating.finally(() => { if (this.terminating === terminating) this.terminating = undefined; this.dispatch(); });
    }
  }
  async close(): Promise<void> {
    if (this.closed) return; this.closed = true;
    const worker = this.worker;
    this.fail(worker, new Error('Storage client closed'));
    await this.terminating;
  }
}
interface StorageContext { clients: Map<string, StorageWorkerClient>; listeners: Set<(cursor: DataCursor) => void>; timer?: NodeJS.Timeout; checking: boolean; cursor?: DataCursor }
declare global { var __foxStorageContext: StorageContext | undefined }
function context(): StorageContext { return globalThis.__foxStorageContext ??= { clients: new Map(), listeners: new Set(), checking: false }; }
function notify(cursor: DataCursor, authoritative = false): void {
  const state = context();
  if (state.cursor?.generation === cursor.generation
    && (state.cursor.revision === cursor.revision || !authoritative && state.cursor.revision > cursor.revision)) return;
  state.cursor = cursor;
  for (const listener of state.listeners) { try { listener(cursor); } catch (error) { console.error('[storage] change listener failed', error); } }
}
export function storageRequest<T extends StorageRequest>(request: T, roots = storageRoots()): Promise<StorageResults[T['operation']]> {
  const state = context(), key = JSON.stringify(roots);
  let client = state.clients.get(key);
  if (!client) { client = new StorageWorkerClient(roots, undefined, cursor => { if (key === JSON.stringify(storageRoots())) notify(cursor); }); state.clients.set(key, client); }
  return client.request(request);
}
async function checkHead(): Promise<void> {
  const state = context(); if (state.checking || !state.listeners.size) return; state.checking = true;
  try { notify(await storageRequest({ operation: 'head' }), true); } catch { /* SSE independently exposes typed unavailability and keeps its subscription. */ }
  finally { state.checking = false; }
}
export function subscribeStorageChanges(listener: (cursor: DataCursor) => void): () => void {
  const state = context(); state.listeners.add(listener);
  if (state.cursor) queueMicrotask(() => { if (state.listeners.has(listener) && state.cursor) listener(state.cursor); });
  if (!state.timer) { void checkHead(); state.timer = setInterval(() => { void checkHead(); }, 1000); state.timer.unref(); }
  return () => { state.listeners.delete(listener); if (!state.listeners.size) { clearInterval(state.timer); state.timer = undefined; } };
}
export async function closeStorage(): Promise<void> {
  const state = context(); clearInterval(state.timer); state.timer = undefined;
  const clients = [...state.clients.values()]; state.clients.clear(); state.cursor = undefined;
  await Promise.all(clients.map(client => client.close()));
  if (state.listeners.size) { state.timer = setInterval(() => { void checkHead(); }, 1000); state.timer.unref(); }
}
