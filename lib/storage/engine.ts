import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import type { SessionInfo } from '../types';
import type { ProjectRegistryEntry } from '../project-registry';
import type { NotificationHistoryEntry } from '../notification-events';
import type { FoxSessionRecord } from '../fox-session';
import type { FoxServiceState } from '../fox-service-core';
import { StorageError, isStorageMutation, type StorageRequest, type StorageResults, type StorageRoots, type DataCursor, type DataHealth, type DataTopic, type DataChange, type VersionedObservation, type IndexSource } from './protocol';
import { configureDatabase, createSchema, assertSchema, SCHEMA_VERSION, INITIAL_HEALTH } from './schema';
import { appDirectory, databasePath, assertNoLostDatabase, hasLegacySources, parseLegacy, recheckSources, importRows, finishReceipt, refuseKnownWriters, withMaintenance, assertNoMaintenance, beginInitializationStage, cleanupInitializationStages, syncDirectory, validateLaunchConfig, validatePointer, validateObservation, validateNotification, type ImportManifest, type LegacyImport, type MaintenanceIdentity } from './migration';
import { scanNativeIndexBatch } from './native-index';
import { readGoalDisplay, readReportDisplay, readObservationEvidence } from './fox-display';

interface SnapshotReader { db: DatabaseSync; cursor: DataCursor; offset: number; expires: number; timer: NodeJS.Timeout }
interface ChangeSet { topic: DataTopic; keys: string[]; reset?: boolean }
interface JsonRow { payload: string }
interface SourceRow { path: string; stamp: string; payload: string | null; error: string | null }
interface ObservationRow extends JsonRow { version: number; claim: string | null }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function storageFailure(error: unknown, mutation = false): StorageError {
  if (error instanceof StorageError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new StorageError(/busy|locked/i.test(message) ? 'storage_busy' : 'storage_unavailable', message, mutation ? 'not_committed' : undefined);
}

/** Worker-owned engine. No consumer may open SQLite on the HTTP/event-loop thread. */
export class StorageEngine {
  private db?: DatabaseSync;
  private readonly readers = new Map<string, SnapshotReader>();
  private initialization?: Promise<void>;
  private lastFailure?: StorageError;
  private checkpoint?: NodeJS.Timeout;
  private maintenanceWarnings: string[] = [];
  constructor(private readonly roots: StorageRoots, private readonly identity: MaintenanceIdentity = { owner: randomUUID(), abandonedOwners: [] }) {}

  private protectFiles(): void {
    for (const suffix of ['', '-wal', '-shm']) { const path = databasePath(this.roots) + suffix; if (existsSync(path)) chmodSync(path, 0o600); }
  }
  private openExisting(): void {
    const db = new DatabaseSync(databasePath(this.roots));
    try {
      configureDatabase(db); assertSchema(db);
      const row = db.prepare('SELECT manifest FROM schema_migrations WHERE version=?').get(SCHEMA_VERSION);
      if (!row || typeof row.manifest !== 'string') throw new StorageError('migration_failed', 'Missing migration manifest');
      const manifest: ImportManifest = JSON.parse(row.manifest);
      this.maintenanceWarnings = finishReceipt(this.roots, manifest);
      this.db = db; this.protectFiles();
      this.checkpoint ??= setInterval(() => { if (this.db) { try { this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* A later request reports storage failures. */ } } }, 30_000);
      this.checkpoint.unref();
    } catch (error) { db.close(); throw error; }
  }
  private async initialize(): Promise<void> {
    assertNoLostDatabase(this.roots); assertNoMaintenance(this.roots, this.identity);
    if (this.db) return;
    if (existsSync(databasePath(this.roots))) {
      await withMaintenance(this.roots, this.identity, async () => { cleanupInitializationStages(this.roots); this.openExisting(); });
      return;
    }
    if (hasLegacySources(this.roots)) throw this.lastFailure?.code === 'migration_failed' ? this.lastFailure : new StorageError('migration_required', 'Legacy application data requires foxnio data migrate --offline after stopping all old instances');
    await withMaintenance(this.roots, this.identity, async () => {
      assertNoLostDatabase(this.roots);
      cleanupInitializationStages(this.roots);
      if (!existsSync(databasePath(this.roots))) {
        if (hasLegacySources(this.roots)) throw new StorageError('migration_required', 'Legacy application data appeared during initialization');
        this.createDatabase(parseLegacy(this.roots));
      }
      this.openExisting();
    });
  }
  private async ready(): Promise<DatabaseSync> {
    this.initialization ??= this.initialize().finally(() => { this.initialization = undefined; });
    await this.initialization;
    if (!this.db) throw new StorageError('storage_unavailable');
    return this.db;
  }
  private createDatabase(data: LegacyImport): void {
    mkdirSync(appDirectory(this.roots), { recursive: true, mode: 0o700 });
    const stage = beginInitializationStage(this.roots, data.manifest);
    let db: DatabaseSync | undefined;
    let published = false;
    try {
      closeSync(openSync(stage.path, 'wx', 0o600));
      db = new DatabaseSync(stage.path);
      configureDatabase(db); db.exec('BEGIN IMMEDIATE');
      recheckSources(data.manifest.sources);
      createSchema(db); importRows(db, data); db.exec('COMMIT');
      // No external reader can see this private staging DB; fully fold its WAL
      // before publishing a single durable database inode without overwriting.
      const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (checkpoint?.busy !== 0) throw new StorageError('storage_busy', 'Initialization checkpoint did not finish');
      db.close(); db = undefined;
      const fd = openSync(stage.path, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
      linkSync(stage.path, databasePath(this.roots)); published = true;
      syncDirectory(appDirectory(this.roots));
      this.protectFiles();
      this.maintenanceWarnings = finishReceipt(this.roots, data.manifest);
    } catch (error) {
      if (published) throw new StorageError('storage_unavailable', `Database committed; initialization recovery must finish: ${String(error)}`, 'uncertain');
      throw error;
    } finally {
      if (db) { try { db.exec('ROLLBACK'); } catch {} db.close(); }
      // This exact directory was allocated by this invocation; final app.db is
      // never removed, even when a post-publication receipt operation fails.
      rmSync(stage.directory, { recursive: true, force: true });
    }
  }
  private head(db = this.db!): DataCursor {
    const row = db.prepare('SELECT generation,revision FROM data_clock WHERE id=1').get();
    if (!row || typeof row.generation !== 'string' || typeof row.revision !== 'number') throw new StorageError('storage_unavailable', 'Invalid data clock');
    return { generation: row.generation, revision: row.revision };
  }
  private projects(db = this.db!): StorageResults['projects.get'] {
    const rows = db.prepare('SELECT payload FROM app_projects ORDER BY rowid').all() as unknown as JsonRow[];
    return { version: 1, projects: rows.map(row => JSON.parse(row.payload) as ProjectRegistryEntry) };
  }
  private pins(db = this.db!): StorageResults['pins.get'] {
    return { pinned: db.prepare('SELECT id,at FROM app_session_pins ORDER BY position').all().map(row => ({ id: String(row.id), at: Number(row.at) })) };
  }
  private notifications(db = this.db!): NotificationHistoryEntry[] {
    return db.prepare('SELECT id,event,at,read FROM app_notification_history ORDER BY at DESC,rowid DESC').all().map(row => ({ id: String(row.id), event: JSON.parse(String(row.event)), at: Number(row.at), read: row.read === 1 }));
  }
  private pointer(db = this.db!): FoxSessionRecord { const row = db.prepare('SELECT payload FROM app_fox_pointer WHERE id=1').get() as unknown as JsonRow; return JSON.parse(row.payload); }
  private observation(db = this.db!): VersionedObservation {
    const row = db.prepare('SELECT payload,version,claim FROM app_fox_observation WHERE id=1').get() as unknown as ObservationRow;
    return { state: JSON.parse(row.payload), version: row.version, ...(row.claim ? { claim: JSON.parse(row.claim) } : {}) };
  }
  private health(db = this.db!): DataHealth { const row = db.prepare('SELECT payload FROM projection_health WHERE id=1').get() as unknown as JsonRow; return JSON.parse(row.payload); }
  private exposedHealth(db = this.db!): DataHealth {
    const health = this.health(db);
    return this.maintenanceWarnings.length ? { ...health, warnings: [...new Set([...health.warnings, ...this.maintenanceWarnings])] } : health;
  }
  private sessions(db: DatabaseSync, offset = 0, limit = -1): SessionInfo[] {
    const rows = db.prepare('SELECT payload FROM projection_sessions ORDER BY modified DESC,path LIMIT ? OFFSET ?').all(limit, offset) as unknown as JsonRow[];
    return rows.map(row => JSON.parse(row.payload));
  }
  private sources(): IndexSource[] {
    const rows = this.db!.prepare('SELECT path,stamp,payload,error FROM projection_sources ORDER BY path').all() as unknown as SourceRow[];
    return rows.map(row => ({ path: row.path, stamp: row.stamp, ...(row.payload ? { payload: JSON.parse(row.payload) } : {}), ...(row.error ? { error: row.error } : {}) }));
  }
  private commit<T>(run: (changes: ChangeSet[]) => T): T {
    const db = this.db!, changes: ChangeSet[] = []; let committed = false;
    db.exec('BEGIN IMMEDIATE');
    try {
      assertNoMaintenance(this.roots, this.identity);
      const result = run(changes);
      if (changes.length) {
        db.exec('UPDATE data_clock SET revision=revision+1 WHERE id=1');
        const revision = this.head(db).revision;
        const grouped = new Map<DataTopic, { keys: Set<string>; reset: boolean }>();
        for (const change of changes) { let group = grouped.get(change.topic); if (!group) { group = { keys: new Set(), reset: false }; grouped.set(change.topic, group); } for (const key of change.keys) group.keys.add(key); group.reset ||= !!change.reset; }
        const insert = db.prepare('INSERT INTO data_changes(revision,topic,keys,reset) VALUES(?,?,?,?)');
        for (const [topic, group] of grouped) insert.run(revision, topic, JSON.stringify([...group.keys]), group.reset ? 1 : 0);
        db.prepare('DELETE FROM data_changes WHERE revision<=?').run(revision - 10_000);
      }
      db.exec('COMMIT'); committed = true;
      this.protectFiles(); return result;
    } catch (error) { if (!committed) { try { db.exec('ROLLBACK'); } catch {} } if (committed) throw new StorageError('storage_unavailable', String(error), 'uncertain'); throw error; }
  }
  private consistent<T>(run: () => T): T { const db = this.db!; db.exec('BEGIN'); try { const value = run(); db.exec('COMMIT'); return value; } catch (error) { db.exec('ROLLBACK'); throw error; } }
  private closeReader(token: string): void { const reader = this.readers.get(token); if (!reader) return; this.readers.delete(token); clearTimeout(reader.timer); try { reader.db.exec('ROLLBACK'); } finally { reader.db.close(); } }
  private drainReaders(): void { for (const token of this.readers.keys()) this.closeReader(token); }
  private openSnapshot(): StorageResults['snapshot.open'] {
    for (const [token, reader] of this.readers) if (reader.expires <= Date.now()) this.closeReader(token);
    if (this.readers.size >= 4) throw new StorageError('storage_busy', 'Four snapshot readers are already pinned');
    const db = new DatabaseSync(databasePath(this.roots), { readOnly: true });
    try {
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN');
      const cursor = this.head(db), sessions = this.sessions(db, 0, 501), next = sessions.length > 500;
      const data = { sessions: sessions.slice(0, 500), projects: this.projects(db).projects, pins: this.pins(db).pinned, notifications: this.notifications(db), foxPointer: this.pointer(db), foxObservation: this.observation(db).state, foxWorkspace: this.roots.foxDir };
      const token = randomUUID(), timer = setTimeout(() => this.closeReader(token), 30_000); timer.unref();
      this.readers.set(token, { db, cursor, offset: 500, expires: Date.now() + 30_000, timer });
      const result = { token, cursor, ...this.exposedHealth(db), data, next }; if (!next) this.closeReader(token); return result;
    } catch (error) { try { db.close(); } catch {} throw error; }
  }
  private snapshotPage(token: string): StorageResults['snapshot.page'] {
    const reader = this.readers.get(token);
    if (!reader || reader.expires <= Date.now()) { this.closeReader(token); throw new StorageError('reset_required', 'Snapshot token expired; restart the snapshot'); }
    if (this.head().generation !== reader.cursor.generation) { this.closeReader(token); throw new StorageError('reset_required', 'Projection generation changed'); }
    const rows = this.sessions(reader.db, reader.offset, 501), next = rows.length > 500; reader.offset += 500;
    const result = { cursor: reader.cursor, sessions: rows.slice(0, 500), next }; if (!next) this.closeReader(token); return result;
  }
  private changes(request: Extract<StorageRequest, { operation: 'changes' }>): StorageResults['changes'] {
    return this.consistent(() => {
      const head = this.head(), through = request.through ?? head, cursor = request.cursor;
      const valid = (value: DataCursor) => value && value.generation === head.generation && Number.isSafeInteger(value.revision) && value.revision >= 0 && value.revision <= head.revision;
      const oldest = this.db!.prepare('SELECT MIN(revision) AS revision FROM data_changes').get();
      if (!valid(cursor) || !valid(through) || through.revision < cursor.revision || typeof oldest?.revision === 'number' && cursor.revision < oldest.revision - 1) throw new StorageError('reset_required', 'Cursor is unknown, pruned, or outside this database generation');
      const limit = Math.max(1, Math.min(256, Number.isSafeInteger(request.limit) ? request.limit! : 256));
      const last = Math.min(through.revision, cursor.revision + limit);
      const rows = this.db!.prepare('SELECT revision,topic,keys,reset FROM data_changes WHERE revision>? AND revision<=? ORDER BY revision,topic').all(cursor.revision, last);
      const changes: DataChange[] = rows.map(row => ({ revision: Number(row.revision), topic: row.topic as DataTopic, keys: JSON.parse(String(row.keys)), ...(row.reset ? { reset: true } : {}) }));
      return { cursor: { generation: head.generation, revision: last }, through, changes, hasMore: last < through.revision };
    });
  }
  private applyIndex(request: Extract<StorageRequest, { operation: 'index.apply' }>): DataCursor {
    this.commit(changes => {
      const db = this.db!;
      const updates = new Map(request.updates.map(update => [update.path, update]));
      const removed = new Set(request.removedPaths ?? []);
      for (const [path, expected] of Object.entries(request.expectedSources ?? {})) {
        const current = db.prepare('SELECT path,stamp,payload,error FROM projection_sources WHERE path=?').get(path) as unknown as SourceRow | undefined;
        if ((current?.stamp ?? null) === expected) continue;
        if (!current && removed.has(path)) continue;
        const update = updates.get(path);
        if (current && update && current.stamp === update.stamp && current.error === (update.error ?? null)
          && current.payload === (update.session ? JSON.stringify(this.durableSession(update.session)) : current.payload)) continue;
        throw new StorageError('storage_conflict', `Source changed during scan: ${path}`, 'not_committed');
      }
      const changed: string[] = [];
      for (const update of request.updates) {
        const previous = db.prepare('SELECT path,stamp,payload,error FROM projection_sources WHERE path=?').get(update.path) as unknown as SourceRow | undefined;
        const payload = update.session ? JSON.stringify(this.durableSession(update.session)) : previous?.payload ?? null, error = update.error ?? null;
        if (previous && previous.stamp === update.stamp && previous.payload === payload && previous.error === error) continue;
        db.prepare('INSERT INTO projection_sources(path,stamp,payload,error) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET stamp=excluded.stamp,payload=excluded.payload,error=excluded.error').run(update.path, update.stamp, payload, error);
        if (update.session) db.prepare('INSERT INTO projection_sessions VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET session_id=excluded.session_id,modified=excluded.modified,payload=excluded.payload').run(update.path, update.session.id, update.session.modified, payload);
        changed.push(update.session?.id ?? (previous?.payload ? JSON.parse(previous.payload).id : update.path));
      }
      for (const path of request.removedPaths ?? []) { const row = db.prepare('SELECT session_id FROM projection_sessions WHERE path=?').get(path); if (db.prepare('DELETE FROM projection_sources WHERE path=?').run(path).changes) changed.push(typeof row?.session_id === 'string' ? row.session_id : path); }
      if (request.health && !same(this.health(), request.health)) { db.prepare('UPDATE projection_health SET payload=? WHERE id=1').run(JSON.stringify(request.health)); changed.push('*'); }
      if (changed.length) changes.push({ topic: 'sessions', keys: changed });
    }); return this.head();
  }
  private durableSession(session: SessionInfo): SessionInfo {
    return { path: session.path, id: session.id, cwd: session.cwd, created: session.created, modified: session.modified, messageCount: session.messageCount, firstMessage: session.firstMessage, ...(session.name !== undefined ? { name: session.name } : {}), ...(session.lastMessageAt !== undefined ? { lastMessageAt: session.lastMessageAt } : {}), ...(session.parentSessionId !== undefined ? { parentSessionId: session.parentSessionId } : {}), ...(session.projectRoot !== undefined ? { projectRoot: session.projectRoot } : {}), ...(session.projectKey !== undefined ? { projectKey: session.projectKey } : {}), ...(session.worktreeBranch !== undefined ? { worktreeBranch: session.worktreeBranch } : {}) };
  }
  private saveObservation(state: FoxServiceState, claim: VersionedObservation['claim'] | undefined): void { this.db!.prepare('UPDATE app_fox_observation SET payload=?,claim=?,version=version+1 WHERE id=1').run(JSON.stringify(validateObservation(state, 'observation command')), claim ? JSON.stringify(claim) : null); }

  async request<T extends StorageRequest>(request: T): Promise<StorageResults[T['operation']]> {
    try { return await this.execute(request) as StorageResults[T['operation']]; }
    catch (error) { const failure = storageFailure(error, isStorageMutation(request)); if (failure.code === 'migration_failed') this.lastFailure = failure; throw failure; }
  }
  private async execute(request: StorageRequest): Promise<StorageResults[keyof StorageResults]> {
    if (request.operation === 'status') { try { await this.ready(); return { ready: true, cursor: this.head() }; } catch (error) { const failure = storageFailure(error); return { ready: false, error: { code: failure.code, message: failure.message } }; } }
    if (request.operation === 'migrate') {
      if (request.offline !== true) throw new StorageError('migration_required', 'Migration requires --offline');
      this.drainReaders();
      return withMaintenance(this.roots, this.identity, async () => {
        refuseKnownWriters(this.roots); assertNoLostDatabase(this.roots);
        cleanupInitializationStages(this.roots);
        const alreadyMigrated = existsSync(databasePath(this.roots));
        if (!alreadyMigrated) this.createDatabase(parseLegacy(this.roots, request.discardObservation));
        if (!this.db) this.openExisting();
        const row = this.db!.prepare('SELECT manifest FROM schema_migrations WHERE version=?').get(SCHEMA_VERSION)!;
        const manifest: ImportManifest = JSON.parse(String(row.manifest));
        return { cursor: this.head(), warnings: [...new Set([...manifest.warnings, ...this.maintenanceWarnings])], alreadyMigrated };
      });
    }
    const db = await this.ready();
    switch (request.operation) {
      case 'head': return this.head();
      case 'snapshot.open': return this.openSnapshot();
      case 'snapshot.page': return this.snapshotPage(request.token);
      case 'snapshot.close': this.closeReader(request.token); return;
      case 'changes': return this.changes(request);
      case 'projects.get': return this.projects();
      case 'projects.patch': return this.commit(changes => {
        if (request.expectedRevision !== undefined && this.head().revision !== request.expectedRevision) throw new StorageError('storage_conflict', 'Project edit depends on a stale revision', 'not_committed');
        const keys: string[] = [];
        for (const update of request.updates) {
          if (typeof update.path !== 'string' || !update.path) throw new StorageError('storage_conflict', 'Project path required', 'not_committed');
          const row = db.prepare('SELECT payload FROM app_projects WHERE path=?').get(update.path);
          const before: ProjectRegistryEntry | undefined = row ? JSON.parse(String(row.payload)) : undefined;
          if (!before && !update.register) continue;
          const next: ProjectRegistryEntry = before ? { ...before } : { path: update.path, addedAt: new Date().toISOString(), hidden: false };
          if (update.addedAt !== undefined) next.addedAt = update.addedAt;
          if (update.hidden !== undefined) next.hidden = update.hidden;
          if (update.alias !== undefined) { const alias = update.alias?.trim(); if (alias) next.alias = alias; else delete next.alias; }
          for (const field of ['sortOrder', 'pinOrder'] as const) { if (update[field] === null) delete next[field]; else if (update[field] !== undefined) { if (!Number.isFinite(update[field])) throw new StorageError('storage_conflict', `Invalid ${field}`); next[field] = update[field]; } }
          if (update.launchConfig === null) delete next.launchConfig; else if (update.launchConfig !== undefined) next.launchConfig = validateLaunchConfig(update.launchConfig, 'project command');
          if (same(before, next)) continue;
          db.prepare('INSERT INTO app_projects VALUES(?,?) ON CONFLICT(path) DO UPDATE SET payload=excluded.payload').run(next.path, JSON.stringify(next)); keys.push(next.path);
        }
        if (keys.length) changes.push({ topic: 'projects', keys }); return this.projects();
      });
      case 'pins.get': return this.pins();
      case 'pins.patch': return this.commit(changes => {
        const before = this.pins().pinned, removed = new Set(request.unpin ?? []), pins = before.filter(pin => !removed.has(pin.id)), present = new Set(pins.map(pin => pin.id));
        for (const id of request.pin ?? []) { if (present.has(id)) continue; present.add(id); pins.unshift({ id, at: request.now ?? Date.now() }); }
        const next = pins.slice(0, 200);
        if (!same(before, next)) { db.exec('DELETE FROM app_session_pins'); const insert = db.prepare('INSERT INTO app_session_pins VALUES(?,?,?)'); next.forEach((pin, i) => insert.run(pin.id, pin.at, i)); changes.push({ topic: 'pins', keys: [...new Set([...before.map(p => p.id), ...next.map(p => p.id)])] }); }
        return { pinned: next };
      });
      case 'notifications.list': return this.notifications();
      case 'notifications.record': return this.commit(changes => {
        const event = validateNotification(request.event, 'notification command'), entry = { id: `${event.sessionId}:${event.type}`, event, at: request.at ?? Date.now(), read: request.read ?? false }, before = this.notifications();
        const mark = db.prepare('UPDATE app_notification_history SET read=1 WHERE id=?'); for (const id of request.settleInputIds ?? []) mark.run(id);
        db.prepare('DELETE FROM app_notification_history WHERE id=?').run(entry.id);
        db.prepare('INSERT INTO app_notification_history VALUES(?,?,?,?)').run(entry.id, JSON.stringify(event), entry.at, entry.read ? 1 : 0);
        db.exec('DELETE FROM app_notification_history WHERE rowid NOT IN (SELECT rowid FROM app_notification_history ORDER BY at DESC,rowid DESC LIMIT 100)');
        const after = this.notifications(); if (!same(before, after)) changes.push({ topic: 'notification-history', keys: [...new Set([...before.map(n => n.id), ...after.map(n => n.id)])] }); return entry;
      });
      case 'notifications.read': return this.commit(changes => { const keys: string[] = []; for (const id of request.ids) if (db.prepare('UPDATE app_notification_history SET read=1 WHERE id=? AND read=0').run(id).changes) keys.push(id); if (keys.length) changes.push({ topic: 'notification-history', keys }); });
      case 'notifications.remove': return this.commit(changes => { if (db.prepare('DELETE FROM app_notification_history WHERE id=?').run(request.id).changes) changes.push({ topic: 'notification-history', keys: [request.id] }); });
      case 'notifications.clear': return this.commit(changes => { const keys = this.notifications().map(n => n.id); if (keys.length) { db.exec('DELETE FROM app_notification_history'); changes.push({ topic: 'notification-history', keys }); } });
      case 'foxPointer.get': return this.pointer();
      case 'foxPointer.cas': return this.commit(changes => { const before = this.pointer(), next = validatePointer(request.next, 'pointer command'); if (!same(before, request.expected) || next.sessionId !== null && next.sessionId === before.revokedSessionId) return null; if (!same(before, next)) { db.prepare('UPDATE app_fox_pointer SET payload=?,version=version+1 WHERE id=1').run(JSON.stringify(next)); changes.push({ topic: 'fox-pointer', keys: ['current'] }); } return next; });
      case 'foxPointer.reset': return this.commit(changes => { const before = this.pointer(); if (request.expected && !same(before, request.expected)) throw new StorageError('storage_conflict', 'FOX pointer changed before reset', 'not_committed'); const next = { sessionId: null, resetAt: new Date(Math.max(Date.now(), (Date.parse(before.resetAt ?? '') || 0) + 1)).toISOString(), revokedSessionId: before.sessionId ?? before.revokedSessionId }; db.prepare('UPDATE app_fox_pointer SET payload=?,version=version+1 WHERE id=1').run(JSON.stringify(next)); changes.push({ topic: 'fox-pointer', keys: ['current'] }); return next; });
      case 'foxObservation.get': return this.observation();
      case 'foxObservation.save': return this.commit(changes => { const before = this.observation(), state = validateObservation(request.state, 'observation command'); if (before.version !== request.expectedVersion || before.claim) throw new StorageError('storage_conflict', 'Observation state changed or has an unresolved transport claim', 'not_committed'); if (!same(before.state, state)) { this.saveObservation(state, undefined); changes.push({ topic: 'fox-observation', keys: ['state'] }); } return this.observation(); });
      case 'observation.claim': return this.commit(changes => {
        const before = this.observation();
        if (before.version !== request.expectedVersion || before.claim) return { claimed: false, version: before.version };
        if (!request.wakeId || request.wakeId.length > 256 || !request.owner || request.owner.length > 256
          || request.eventKeys.length > 200 || request.eventKeys.some(key => !key || key.length > 4096)
          || request.targetSessionId !== undefined && !/^[A-Za-z0-9_-]{8,128}$/.test(request.targetSessionId)
          || !Number.isFinite(request.now) || !Number.isFinite(request.leaseMs) || request.leaseMs <= 0
          || !Number.isFinite(request.now + request.leaseMs)) throw new StorageError('storage_conflict', 'Invalid observation claim');
        this.saveObservation(before.state, { wakeId: request.wakeId, owner: request.owner, ...(request.targetSessionId !== undefined ? { targetSessionId: request.targetSessionId } : {}), eventKeys: [...new Set(request.eventKeys)], leaseUntil: request.now + request.leaseMs, status: 'pending' });
        changes.push({ topic: 'fox-observation', keys: ['claim'] }); return { claimed: true, version: before.version + 1 };
      });
      case 'observation.evidence': return readObservationEvidence(request, this.roots);
      case 'observation.settle': return this.commit(changes => { const before = this.observation(); if (before.claim?.wakeId !== request.wakeId || before.claim.owner !== request.owner) throw new StorageError('storage_conflict', 'Observation transport claim owner changed', 'not_committed'); const claim = request.outcome === 'uncertain' ? { ...before.claim, status: 'uncertain' as const } : undefined; const state = request.state ? validateObservation(request.state, 'observation command') : before.state; if (!same(state, before.state) || !same(claim, before.claim)) { this.saveObservation(state, claim); changes.push({ topic: 'fox-observation', keys: ['state', 'claim'] }); } return this.observation(); });
      case 'index.sources': return { sources: this.sources() };
      case 'index.get': return this.consistent(() => {
        let sessions: SessionInfo[];
        if (request.ids) {
          const lookup = db.prepare('SELECT payload FROM projection_sessions WHERE session_id=? ORDER BY modified DESC,path');
          const rows = [...new Set(request.ids)].flatMap(id => lookup.all(id));
          sessions = rows.map(row => JSON.parse(String(row.payload)) as SessionInfo);
          sessions.sort((a, b) => b.modified.localeCompare(a.modified) || a.path.localeCompare(b.path));
        } else sessions = this.sessions(db);
        const found = new Set(sessions.map(session => session.id));
        return { sessions, missing: request.ids?.filter(id => !found.has(id)) ?? [], cursor: this.head(), ...this.exposedHealth() };
      });
      case 'index.apply': return this.applyIndex(request);
      case 'index.scan': {
        const sources = this.sources(), result = await scanNativeIndexBatch(request, this.roots, this.projects().projects, sources, this.health());
        const { expectedSources, ...publicResult } = result;
        const bases: Record<string, string | null> = expectedSources ?? Object.fromEntries([...result.updates.map(update => update.path), ...(result.removedPaths ?? [])].map(path => [path, sources.find(source => source.path === path)?.stamp ?? null]));
        if (result.updates.length || result.removedPaths?.length || !result.nextScanToken || result.staleSources.length || result.warnings.length) this.applyIndex({ operation: 'index.apply', updates: result.updates, removedPaths: result.removedPaths, expectedSources: bases, health: { complete: result.complete, staleSources: result.staleSources, warnings: result.warnings } });
        return publicResult;
      }
      case 'index.rebuild': this.drainReaders(); this.commit(changes => { db.exec('DELETE FROM projection_sources; DELETE FROM projection_sessions; DELETE FROM projection_views; DELETE FROM data_changes'); db.prepare('UPDATE projection_health SET payload=? WHERE id=1').run(JSON.stringify(INITIAL_HEALTH)); db.prepare('UPDATE data_clock SET generation=?,revision=0 WHERE id=1').run(randomUUID()); changes.push({ topic: 'sessions', keys: ['*'], reset: true }, { topic: 'fox-display', keys: ['*'], reset: true }); }); return this.head();
      case 'views.goal':
      case 'views.report': {
        const key = `${request.operation}:${request.filePath}`;
        const lookup = (sourceVersion: string): unknown | null => {
          const row = db.prepare('SELECT payload FROM projection_views WHERE key=? AND source_version=?').get(key, sourceVersion);
          return row ? JSON.parse(String(row.payload)) : null;
        };
        const result = request.operation === 'views.goal'
          ? await readGoalDisplay(request, this.roots, lookup)
          : await readReportDisplay(request, this.roots, lookup);
        await this.execute({ operation: 'views.put', key, sourceVersion: result.sourceVersion, value: result.value });
        return result;
      }
      case 'views.get': { const row = db.prepare('SELECT payload FROM projection_views WHERE key=? AND source_version=?').get(request.key, request.sourceVersion); return row ? { value: JSON.parse(String(row.payload)) } : null; }
      case 'views.put': this.commit(changes => { const payload = JSON.stringify(request.value); this.rejectLiveView(request.value); const row = db.prepare('SELECT source_version,payload FROM projection_views WHERE key=?').get(request.key); if (row?.source_version === request.sourceVersion && row.payload === payload) return; db.prepare('INSERT INTO projection_views VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET source_version=excluded.source_version,payload=excluded.payload').run(request.key, request.sourceVersion, payload); changes.push({ topic: 'fox-display', keys: [request.key] }); }); return this.head();
      case 'invalidate': this.commit(changes => { if (request.keys.length) changes.push({ topic: request.topic, keys: request.keys }); }); return this.head();
      case 'backup': {
        this.drainReaders(); const path = `${databasePath(this.roots)}.backup-${Date.now()}-${randomUUID()}`;
        closeSync(openSync(path, 'wx', 0o600));
        try { await backup(db, path); chmodSync(path, 0o600); const copy = new DatabaseSync(path, { readOnly: true }); try { assertSchema(copy); return { path, cursor: this.head(copy) }; } finally { copy.close(); } }
        catch (error) { rmSync(path, { force: true }); throw error; }
      }
    }
  }
  private rejectLiveView(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) { if (['running', 'pendingInput', 'lastRunError', 'needsYou'].includes(key)) throw new StorageError('storage_conflict', `Live field ${key} must not be persisted`); this.rejectLiveView(child); }
  }
  async close(): Promise<void> { this.drainReaders(); clearInterval(this.checkpoint); this.checkpoint = undefined; if (this.db) { this.db.close(); this.db = undefined; } }
}
