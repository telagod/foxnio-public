import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ProjectRegistryEntry } from '../project-registry';
import type { PinnedSession } from '../session-ui-state';
import type { NotificationEvent, NotificationHistoryEntry } from '../notification-events';
import type { FoxSessionRecord } from '../fox-session';
import type { FoxServiceState } from '../fox-service-core';
import type { ProjectLaunchConfig } from '../types';
import { isRecord } from '../type-guards';
import { StorageError, type StorageRoots } from './protocol';
import { EMPTY_POINTER, emptyObservation, SCHEMA_VERSION } from './schema';

export interface SourceDigest { path: string; stamp: string | null; digest: string | null }
export interface ImportManifest { installationId: string; schemaVersion: number; completedAt: string; sources: SourceDigest[]; warnings: string[] }
export interface MaintenanceIdentity { owner: string; abandonedOwners: readonly string[] }
export interface LegacyImport { projects: ProjectRegistryEntry[]; pins: PinnedSession[]; notifications: NotificationHistoryEntry[]; pointer: FoxSessionRecord; observation: FoxServiceState; manifest: ImportManifest }
export function appDirectory(roots: StorageRoots): string { return join(roots.agentDir, 'omp-web'); }
export function databasePath(roots: StorageRoots): string { return join(appDirectory(roots), 'app.db'); }
function invalid(source: string, detail: string): never { throw new StorageError('migration_failed', `${source}: ${detail}. Repair the source and retry foxnio data migrate --offline.`, 'not_committed'); }
function json(text: string, source: string): unknown { try { return JSON.parse(text); } catch { return invalid(source, 'invalid JSON'); } }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function validId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value); }
function timestamp(value: unknown): value is string { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)); }
function stamp(path: string): string | null { try { const s = statSync(path); return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; } }
function capture(path: string): SourceDigest {
  const before = stamp(path); if (before === null) return { path, stamp: null, digest: null };
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (stamp(path) !== before) invalid(path, 'source changed during import');
  return { path, stamp: before, digest };
}
export function legacyPaths(roots: StorageRoots): string[] { return [join(roots.agentDir, 'projects.json'), join(appDirectory(roots), 'session-ui.json'), join(appDirectory(roots), 'notifications.db'), join(appDirectory(roots), 'notifications.json'), join(roots.foxDir, 'session.json'), join(roots.foxDir, 'service-state.json')]; }
export function hasLegacySources(roots: StorageRoots): boolean { return legacyPaths(roots).some(path => stamp(path) !== null); }
const INITIALIZATION_DIRECTORY = /^app\.db\.init-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
export interface InitializationStage { directory: string; path: string }
function verifyInitializationStage(roots: StorageRoots, name: string): InitializationStage {
  const match = INITIALIZATION_DIRECTORY.exec(name), directory = join(appDirectory(roots), name);
  if (!match || !lstatSync(directory).isDirectory()) throw new StorageError('restore_required', `Unrecognized initialization artifact: ${directory}`);
  const entries = readdirSync(directory);
  const marker = 'app.db.init-owner.json';
  if (entries.some(entry => !['app.db', 'app.db-wal', 'app.db-shm', marker].includes(entry) && !/^app\.db\.init-owner\.json\.[0-9a-f-]{36}\.tmp$/.test(entry))) throw new StorageError('restore_required', `Unexpected data in initialization staging directory: ${directory}`);
  const database = join(directory, 'app.db');
  if (!existsSync(join(directory, marker))) {
    // Before the ownership record is durable, the initializer creates no SQLite files.
    if (entries.some(entry => ['app.db', 'app.db-wal', 'app.db-shm'].includes(entry))) throw new StorageError('restore_required', `Initialization database has no ownership record: ${directory}`);
    return { directory, path: database };
  }
  const owner = json(readFileSync(join(directory, marker), 'utf8'), directory);
  if (!isRecord(owner) || owner.kind !== 'foxnio-initialization' || owner.installationId !== match[1] || owner.databasePath !== databasePath(roots) || owner.schemaVersion !== SCHEMA_VERSION) throw new StorageError('restore_required', `Initialization ownership record does not match: ${directory}`);
  return { directory, path: database };
}
export function initializationStages(roots: StorageRoots): InitializationStage[] {
  const directory = appDirectory(roots);
  return existsSync(directory) ? readdirSync(directory).filter(name => INITIALIZATION_DIRECTORY.test(name)).map(name => verifyInitializationStage(roots, name)) : [];
}
export function cleanupInitializationStages(roots: StorageRoots): void {
  for (const stage of initializationStages(roots)) rmSync(stage.directory, { recursive: true });
}
export function beginInitializationStage(roots: StorageRoots, manifest: ImportManifest): InitializationStage {
  const directory = join(appDirectory(roots), `app.db.init-${manifest.installationId}`);
  mkdirSync(directory, { mode: 0o700 });
  protectedWrite(join(directory, 'app.db.init-owner.json'), JSON.stringify({ kind: 'foxnio-initialization', installationId: manifest.installationId, schemaVersion: SCHEMA_VERSION, databasePath: databasePath(roots) }));
  syncDirectory(appDirectory(roots));
  return { directory, path: join(directory, 'app.db') };
}
export function assertNoLostDatabase(roots: StorageRoots): void {
  const db = databasePath(roots); if (existsSync(db)) return;
  const dir = appDirectory(roots);
  if (!existsSync(dir)) return;
  const staging = new Set(initializationStages(roots).map(stage => basename(stage.directory)));
  if (readdirSync(dir).some(name => name.startsWith('app.db') && name !== 'app.db.maintenance' && name !== 'app.db.maintenance.recovery' && !staging.has(name))) {
    throw new StorageError('restore_required', 'app.db is missing but initialization evidence remains. Restore a consistent app.db backup; legacy reimport is refused.', 'not_committed');
  }
}
export function validateLaunchConfig(value: unknown, source: string): ProjectLaunchConfig {
  if (!isRecord(value)) return invalid(source, 'invalid launchConfig');
  if (value.profile !== undefined && (typeof value.profile !== 'string' || !value.profile.trim() || value.profile.trim().startsWith('-'))) invalid(source, 'invalid launch profile');
  if (value.advisor !== undefined && typeof value.advisor !== 'boolean') invalid(source, 'invalid advisor option');
  if (value.extraArgs !== undefined && (!Array.isArray(value.extraArgs) || value.extraArgs.length > 32 || value.extraArgs.some(arg => typeof arg !== 'string' || !arg.length || arg.length > 256 || ['--mode', 'rpc-ui', '--cwd', '--resume'].includes(arg) || ['--mode=', '--cwd=', '--resume='].some(prefix => arg.startsWith(prefix))))) invalid(source, 'invalid or reserved launch arguments');
  if (Object.keys(value).some(key => !['profile', 'advisor', 'extraArgs'].includes(key))) invalid(source, 'unknown launch configuration field');
  return { ...(typeof value.profile === 'string' ? { profile: value.profile.trim() } : {}), ...(typeof value.advisor === 'boolean' ? { advisor: value.advisor } : {}), ...(Array.isArray(value.extraArgs) ? { extraArgs: value.extraArgs as string[] } : {}) };
}
function parseProjects(value: unknown, source: string, warnings: string[]): ProjectRegistryEntry[] {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.projects)) return invalid(source, 'expected version 1 project registry');
  const seen = new Set<string>();
  return value.projects.map(item => {
    if (!isRecord(item) || typeof item.path !== 'string' || !item.path.trim() || !timestamp(item.addedAt) || typeof item.hidden !== 'boolean') return invalid(source, 'invalid project identity/addedAt/hidden');
    let path = resolve(item.path.trim()); try { path = realpathSync(path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (seen.has(path)) invalid(source, `duplicate project ${path}`); seen.add(path);
    const result: ProjectRegistryEntry = { path, addedAt: item.addedAt, hidden: item.hidden };
    if (item.alias !== undefined) { if (typeof item.alias === 'string' && item.alias.trim()) result.alias = item.alias.trim(); else warnings.push(`${source}: omitted invalid optional alias for ${path}`); }
    for (const field of ['sortOrder', 'pinOrder'] as const) if (item[field] !== undefined) { if (finite(item[field])) result[field] = item[field]; else warnings.push(`${source}: omitted invalid optional ${field} for ${path}`); }
    if (item.launchConfig !== undefined) result.launchConfig = validateLaunchConfig(item.launchConfig, source);
    return result;
  });
}
function parsePins(value: unknown, source: string): PinnedSession[] {
  if (!isRecord(value) || !Array.isArray(value.pinned)) return invalid(source, 'invalid pin registry');
  const seen = new Set<string>();
  const pins = value.pinned.map(item => { if (!isRecord(item) || !validId(item.id) || !finite(item.at) || seen.has(item.id)) return invalid(source, 'invalid or duplicate pin'); seen.add(item.id); return { id: item.id, at: item.at }; });
  return pins.sort((a, b) => b.at - a.at).slice(0, 200);
}
export function validatePointer(value: unknown, source: string): FoxSessionRecord {
  if (!isRecord(value) || !Object.hasOwn(value, 'sessionId') || !Object.hasOwn(value, 'resetAt') || !Object.hasOwn(value, 'revokedSessionId') || value.sessionId !== null && !validId(value.sessionId) || value.revokedSessionId !== null && !validId(value.revokedSessionId) || value.resetAt !== null && !timestamp(value.resetAt)) return invalid(source, 'invalid FOX session pointer/reset epoch');
  return { sessionId: typeof value.sessionId === 'string' ? value.sessionId : null, resetAt: typeof value.resetAt === 'string' ? value.resetAt : null, revokedSessionId: typeof value.revokedSessionId === 'string' ? value.revokedSessionId : null };
}
export function validateObservation(value: unknown, source: string): FoxServiceState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.daily) || !isRecord(value.seen)) return invalid(source, 'unsupported observation state');
  for (const field of ['seededAt', 'lastTickAt', 'lastWakeAt']) if (value[field] !== null && !timestamp(value[field])) invalid(source, `invalid observation ${field}`);
  if (typeof value.daily.date !== 'string' || value.daily.date !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(value.daily.date) || !Number.isSafeInteger(value.daily.count) || Number(value.daily.count) < 0) invalid(source, 'invalid daily observation accounting');
  const seen: Record<string, string> = {};
  for (const [key, at] of Object.entries(value.seen)) { if (!key || !timestamp(at)) invalid(source, 'invalid seen event accounting'); seen[key] = at; }
  if (value.pending !== undefined && !Array.isArray(value.pending)) invalid(source, 'invalid observation pending state');
  // Pending is runtime-only. A durable writer excludes those keys from seen.
  for (const pending of Array.isArray(value.pending) ? value.pending : []) { if (!isRecord(pending) || typeof pending.key !== 'string') invalid(source, 'invalid pending observation'); delete seen[pending.key]; }
  return { version: 1, seededAt: value.seededAt as string | null, lastTickAt: value.lastTickAt as string | null, lastWakeAt: value.lastWakeAt as string | null, daily: { date: value.daily.date, count: Number(value.daily.count) }, seen, pending: [] };
}
export function validateNotification(value: unknown, source: string): NotificationEvent {
  if (!isRecord(value) || typeof value.type !== 'string' || !['completed', 'input', 'error', 'modelSwitch', 'test'].includes(value.type) || typeof value.sessionId !== 'string' || !value.sessionId || value.sessionName !== null && typeof value.sessionName !== 'string') return invalid(source, 'invalid notification event');
  for (const field of ['detail', 'from', 'to']) if (value[field] !== undefined && typeof value[field] !== 'string') invalid(source, 'invalid notification detail');
  if (value.aliases !== undefined && (!Array.isArray(value.aliases) || value.aliases.some(id => typeof id !== 'string'))) invalid(source, 'invalid notification aliases');
  return value as unknown as NotificationEvent;
}
function historyEntry(value: unknown, source: string): NotificationHistoryEntry {
  if (!isRecord(value) || !finite(value.at) || typeof value.read !== 'boolean') return invalid(source, 'invalid notification history row');
  const event = validateNotification(value.event, source);
  if (value.id !== `${event.sessionId}:${event.type}`) invalid(source, 'notification tag does not match event');
  return { id: value.id as string, event, at: value.at, read: value.read };
}
export function parseLegacy(roots: StorageRoots, discardObservation = false): LegacyImport {
  try { return parseLegacySources(roots, discardObservation); }
  catch (error) { if (error instanceof StorageError) throw error; return invalid('Legacy application data', String(error)); }
}
function parseLegacySources(roots: StorageRoots, discardObservation: boolean): LegacyImport {
  const paths = legacyPaths(roots), sources = paths.map(capture), warnings: string[] = [];
  const value = (index: number) => sources[index].stamp === null ? undefined : json(readFileSync(paths[index], 'utf8'), paths[index]);
  const projectValue = value(0), pinsValue = value(1), pointerValue = value(4);
  let notifications: NotificationHistoryEntry[] = [];
  if (sources[2].stamp !== null) {
    sources.push(capture(`${paths[2]}-wal`));
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(paths[2], { readOnly: true }); db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN');
      const check = db.prepare('PRAGMA quick_check').get(); if (!check || check.quick_check !== 'ok') invalid(paths[2], 'notification database integrity check failed');
      const rows = db.prepare('SELECT id,event,at,read FROM history ORDER BY at DESC,rowid DESC').all();
      notifications = rows.map(row => { if (row.read !== 0 && row.read !== 1) invalid(paths[2], 'invalid notification read flag'); return historyEntry({ ...row, event: json(String(row.event), paths[2]), read: row.read === 1 }, paths[2]); }).slice(0, 100);
      db.exec('ROLLBACK');
    } catch (e) { if (e instanceof StorageError) throw e; invalid(paths[2], `cannot read notification database: ${String(e)}`); } finally { db?.close(); }
  } else {
    const old = value(3);
    if (old !== undefined) {
      if (!isRecord(old) || old.history !== undefined && !Array.isArray(old.history)) invalid(paths[3], 'invalid notification JSON');
      notifications = (Array.isArray(old.history) ? old.history : []).map(entry => historyEntry(entry, paths[3])).sort((a, b) => b.at - a.at).slice(0, 100);
    }
  }
  let observation = emptyObservation() as FoxServiceState;
  if (sources[5].stamp !== null) {
    if (discardObservation) warnings.push(`${paths[5]}: observation accounting explicitly discarded by operator`);
    else observation = validateObservation(value(5), paths[5]);
  }
  const projects = projectValue === undefined ? [] : parseProjects(projectValue, paths[0], warnings);
  const pins = pinsValue === undefined ? [] : parsePins(pinsValue, paths[1]);
  const pointer = pointerValue === undefined ? { ...EMPTY_POINTER } : validatePointer(pointerValue, paths[4]);
  recheckSources(sources);
  return { projects, pins, notifications, pointer, observation,
    manifest: { installationId: randomUUID(), schemaVersion: SCHEMA_VERSION, completedAt: new Date().toISOString(), sources, warnings } };
}
export function recheckSources(sources: SourceDigest[]): void { for (const source of sources) if (stamp(source.path) !== source.stamp) invalid(source.path, 'source changed during offline migration'); }
export function importRows(db: DatabaseSync, data: LegacyImport): void {
  const project = db.prepare('INSERT INTO app_projects VALUES(?,?)'); for (const p of data.projects) project.run(p.path, JSON.stringify(p));
  const pin = db.prepare('INSERT INTO app_session_pins VALUES(?,?,?)'); data.pins.forEach((p, i) => pin.run(p.id, p.at, i));
  const event = db.prepare('INSERT INTO app_notification_history VALUES(?,?,?,?)'); for (const n of [...data.notifications].reverse()) event.run(n.id, JSON.stringify(n.event), n.at, n.read ? 1 : 0);
  db.prepare('UPDATE app_fox_pointer SET payload=? WHERE id=1').run(JSON.stringify(data.pointer));
  db.prepare('UPDATE app_fox_observation SET payload=? WHERE id=1').run(JSON.stringify(data.observation));
  db.prepare('INSERT INTO schema_migrations VALUES(?,?,?,?)').run(SCHEMA_VERSION, data.manifest.installationId, data.manifest.completedAt, JSON.stringify(data.manifest));
}
export function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function protectedWrite(path: string, content: string): void {
  const temp = `${path}.${randomUUID()}.tmp`, fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path); chmodSync(path, 0o600);
  // Persist the directory entry as well as the contents before any retirement.
  syncDirectory(dirname(path));
}
export function finishReceipt(roots: StorageRoots, manifest: ImportManifest): string[] {
  const warnings: string[] = [];
  const path = databasePath(roots), content = JSON.stringify(manifest);
  for (const suffix of ['.migration-receipt.json', '.initialized']) {
    const target = path + suffix;
    if (existsSync(target)) {
      const previous = json(readFileSync(target, 'utf8'), target);
      if (!isRecord(previous) || previous.installationId !== manifest.installationId || previous.schemaVersion !== SCHEMA_VERSION) throw new StorageError('restore_required', `${target} does not match this database installation`);
    } else protectedWrite(target, content);
  }
  // The old SQLite database remains in place with its WAL and retired secrets.
  for (const source of manifest.sources) {
    // Retired notification JSON may contain VAPID/device secrets; retain it only in place.
    if (!source.digest || !source.path.endsWith('.json') || basename(source.path) === 'notifications.json') continue;
    const destination = join(appDirectory(roots), `app.db.migration-backup-${basename(source.path)}-${manifest.installationId}`);
    try {
      if (existsSync(destination)) {
        if (createHash('sha256').update(readFileSync(destination)).digest('hex') !== source.digest) warnings.push(`Retained migration backup is damaged: ${destination}`);
        continue;
      }
      if (stamp(source.path) !== source.stamp) { warnings.push(`Retained migration backup is unavailable because its legacy source changed or was removed: ${destination}`); continue; }
      const contents = readFileSync(source.path, 'utf8');
      if (createHash('sha256').update(contents).digest('hex') !== source.digest) { warnings.push(`Retained migration backup is unavailable because its legacy source changed: ${destination}`); continue; }
      protectedWrite(destination, contents);
    } catch (error) { warnings.push(`Could not finish retained migration backup ${destination}: ${String(error)}`); }
  }
  return warnings;
}
export function refuseKnownWriters(roots: StorageRoots): void {
  if (!existsSync(roots.agentDir)) return;
  for (const name of readdirSync(roots.agentDir)) {
    const match = /^omp-web-interrupted-sessions-(\d+)\.json$/.exec(name); if (!match) continue;
    try { process.kill(Number(match[1]), 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') continue; }
    throw new StorageError('migration_required', `Known live foxnio process ${match[1]}; stop all instances before offline migration`, 'not_committed');
  }
}
function clearAbandonedMaintenance(path: string, identity: MaintenanceIdentity): void {
  const recovery = `${path}.recovery`;
  let fd: number;
  try { fd = openSync(recovery, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new StorageError('storage_busy', 'Maintenance recovery is in progress; inspect its guard if the recovery process crashed'); throw error; }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, owner: identity.owner }));
    let owner: unknown;
    try { owner = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new StorageError('storage_busy', 'Unrecognized offline maintenance guard; inspect it before retrying'); }
    if (!isRecord(owner) || typeof owner.pid !== 'number' || typeof owner.owner !== 'string') throw new StorageError('storage_busy', 'Unrecognized offline maintenance owner');
    let abandoned = owner.pid === process.pid && identity.abandonedOwners.includes(owner.owner);
    if (!abandoned) { try { process.kill(owner.pid, 0); } catch (error) { abandoned = (error as NodeJS.ErrnoException).code === 'ESRCH'; } }
    if (!abandoned) throw new StorageError('storage_busy', 'Offline data maintenance is in progress', 'not_committed');
    rmSync(path);
  } finally { closeSync(fd); rmSync(recovery); }
}
export function withMaintenance<T>(roots: StorageRoots, identity: MaintenanceIdentity, run: () => Promise<T>): Promise<T> {
  mkdirSync(appDirectory(roots), { recursive: true, mode: 0o700 });
  const path = databasePath(roots) + '.maintenance';
  if (existsSync(`${path}.recovery`)) throw new StorageError('storage_busy', 'Maintenance recovery is in progress');
  if (existsSync(path)) clearAbandonedMaintenance(path, identity);
  const acquisition = randomUUID();
  try { const fd = openSync(path, 'wx', 0o600); try { writeFileSync(fd, JSON.stringify({ pid: process.pid, owner: identity.owner, acquisition })); fsyncSync(fd); } finally { closeSync(fd); } }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new StorageError('storage_busy', 'Offline data maintenance is in progress', 'not_committed'); throw error; }
  return run().finally(() => {
    const current = json(readFileSync(path, 'utf8'), path);
    if (isRecord(current) && current.acquisition === acquisition) rmSync(path);
  });
}
export function assertNoMaintenance(roots: StorageRoots, identity: MaintenanceIdentity): void {
  const path = databasePath(roots) + '.maintenance';
  if (existsSync(`${path}.recovery`)) throw new StorageError('storage_busy', 'Maintenance recovery is in progress');
  if (existsSync(path)) clearAbandonedMaintenance(path, identity);
}
