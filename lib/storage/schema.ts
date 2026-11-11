import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { StorageError } from './protocol';

export const SCHEMA_VERSION = 1;
export const EMPTY_POINTER = { sessionId: null, resetAt: null, revokedSessionId: null };
export function emptyObservation() { return { version: 1 as const, seededAt: null, lastTickAt: null, lastWakeAt: null, daily: { date: '', count: 0 }, seen: {}, pending: [] }; }
export const INITIAL_HEALTH = { complete: false, staleSources: [], warnings: [] };
export function configureDatabase(db: DatabaseSync): void {
  db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
}
export function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, installation_id TEXT NOT NULL, completed_at TEXT NOT NULL, manifest TEXT NOT NULL);
    CREATE TABLE app_projects(path TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE app_session_pins(id TEXT PRIMARY KEY, at REAL NOT NULL, position INTEGER NOT NULL);
    CREATE TABLE app_notification_history(id TEXT PRIMARY KEY, event TEXT NOT NULL, at REAL NOT NULL, read INTEGER NOT NULL CHECK(read IN (0,1)));
    CREATE TABLE app_fox_pointer(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, version INTEGER NOT NULL);
    CREATE TABLE app_fox_observation(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL, version INTEGER NOT NULL, claim TEXT);
    CREATE TABLE projection_sources(path TEXT PRIMARY KEY, stamp TEXT NOT NULL, payload TEXT, error TEXT);
    CREATE TABLE projection_sessions(path TEXT PRIMARY KEY REFERENCES projection_sources(path) ON DELETE CASCADE, session_id TEXT NOT NULL, modified TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX projection_sessions_order ON projection_sessions(modified DESC,path);
    CREATE INDEX projection_sessions_id ON projection_sessions(session_id);
    CREATE TABLE projection_views(key TEXT PRIMARY KEY, source_version TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE projection_health(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
    CREATE TABLE data_clock(id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT NOT NULL, revision INTEGER NOT NULL);
    CREATE TABLE data_changes(revision INTEGER NOT NULL, topic TEXT NOT NULL, keys TEXT NOT NULL, reset INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(revision,topic));
  `);
  db.prepare('INSERT INTO app_fox_pointer VALUES(1,?,0)').run(JSON.stringify(EMPTY_POINTER));
  db.prepare('INSERT INTO app_fox_observation VALUES(1,?,0,NULL)').run(JSON.stringify(emptyObservation()));
  db.prepare('INSERT INTO projection_health VALUES(1,?)').run(JSON.stringify(INITIAL_HEALTH));
  db.prepare('INSERT INTO data_clock VALUES(1,?,0)').run(randomUUID());
  db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
}
export function assertSchema(db: DatabaseSync): void {
  const versionRow = db.prepare('PRAGMA user_version').get();
  const version = Number(versionRow?.user_version);
  if (version !== SCHEMA_VERSION) throw new StorageError('schema_unsupported', `Unsupported app.db schema ${version}; supported version is ${SCHEMA_VERSION}`);
  const completed = db.prepare('SELECT version FROM schema_migrations WHERE version=?').get(SCHEMA_VERSION);
  if (!completed) throw new StorageError('migration_failed', 'app.db has no committed initialization record; restore a consistent backup');
  db.prepare('SELECT generation,revision FROM data_clock WHERE id=1').get();
}
