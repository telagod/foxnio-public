import type { SessionInfo, ProjectLaunchConfig } from '../types';
import type { ProjectRegistryEntry, ProjectRegistryFile } from '../project-registry';
import type { PinnedSession } from '../session-ui-state';
import type { NotificationEvent, NotificationHistoryEntry } from '../notification-events';
import type { FoxSessionRecord } from '../fox-session';
import type { FoxServiceState } from '../fox-service-core';
import type { FoxGoalSnapshot } from '../fox-goal-types';
import type { FoxReportView } from '../fox-report-types';

export interface DataCursor { generation: string; revision: number }
export type DataTopic = 'sessions' | 'projects' | 'pins' | 'notification-history' | 'fox-pointer' | 'fox-observation' | 'fox-display' | 'operator-settings';
export interface DataChange { revision: number; topic: DataTopic; keys: string[]; reset?: boolean }
export interface DataHealth { complete: boolean; staleSources: string[]; warnings: string[] }
export interface DataSnapshot extends DataHealth {
  cursor: DataCursor;
  data: { sessions: SessionInfo[]; projects: ProjectRegistryEntry[]; pins: PinnedSession[]; notifications: NotificationHistoryEntry[]; foxPointer: FoxSessionRecord; foxObservation: FoxServiceState; foxWorkspace: string };
}
export interface StorageRoots { agentDir: string; sessionsDir: string; foxDir: string }
export class StorageError extends Error {
  constructor(public readonly code: string, message = code, public readonly outcome?: 'not_committed' | 'uncertain') { super(message); this.name = 'StorageError'; }
}
export interface ProjectPatch { path: string; register?: boolean; addedAt?: string; hidden?: boolean; alias?: string | null; sortOrder?: number | null; pinOrder?: number | null; launchConfig?: ProjectLaunchConfig | null }
export interface IndexedSource { path: string; stamp: string; session?: SessionInfo; error?: string }
export interface IndexSource { path: string; stamp: string; payload?: SessionInfo; error?: string }
export interface IndexScanRequest { operation: 'index.scan'; paths?: string[]; scanToken?: string; force?: boolean }
export interface NativeScanResult extends DataHealth {
  updates: IndexedSource[]; removedPaths?: string[]; nextScanToken?: string;
  /** Internal scanner-to-engine CAS bases; stripped from the worker response. */
  expectedSources?: Record<string, string | null>;
}
export interface ObservationClaim { wakeId: string; owner: string; targetSessionId?: string; eventKeys: string[]; leaseUntil: number; status: 'pending' | 'uncertain' }
export interface VersionedObservation { state: FoxServiceState; version: number; claim?: ObservationClaim }
export type StorageRequest =
  | { operation: 'status' | 'head' | 'snapshot.open' | 'projects.get' | 'pins.get' | 'notifications.list' | 'notifications.clear' | 'foxPointer.get' | 'foxObservation.get' | 'index.sources' | 'index.rebuild' | 'backup' }
  | { operation: 'snapshot.page' | 'snapshot.close'; token: string }
  | { operation: 'changes'; cursor: DataCursor; through?: DataCursor; limit?: number }
  | { operation: 'projects.patch'; updates: ProjectPatch[]; expectedRevision?: number }
  | { operation: 'pins.patch'; pin?: string[]; unpin?: string[]; now?: number }
  | { operation: 'notifications.record'; event: NotificationEvent; at?: number; read?: boolean; settleInputIds?: string[] }
  | { operation: 'notifications.read'; ids: string[] }
  | { operation: 'notifications.remove'; id: string }
  | { operation: 'foxPointer.cas'; expected: FoxSessionRecord; next: FoxSessionRecord }
  | { operation: 'foxPointer.reset'; expected?: FoxSessionRecord }
  | { operation: 'foxObservation.save'; state: FoxServiceState; expectedVersion: number }
  | { operation: 'observation.claim'; expectedVersion: number; wakeId: string; eventKeys: string[]; owner: string; targetSessionId?: string; now: number; leaseMs: number }
  | { operation: 'observation.evidence'; filePath: string; wakeId: string }
  | { operation: 'observation.settle'; wakeId: string; owner: string; outcome: 'delivered' | 'not-submitted' | 'uncertain'; state?: FoxServiceState }
  | { operation: 'index.get'; ids?: string[] }
  | { operation: 'index.apply'; updates: IndexedSource[]; removedPaths?: string[]; health?: DataHealth; expectedSources?: Record<string, string | null> }
  | IndexScanRequest
  | { operation: 'views.get'; key: string; sourceVersion: string }
  | { operation: 'views.goal' | 'views.report'; filePath: string }
  | { operation: 'views.put'; key: string; sourceVersion: string; value: unknown }
  | { operation: 'invalidate'; topic: DataTopic; keys: string[] }
  | { operation: 'migrate'; offline: true; discardObservation?: boolean };
export interface StorageResults {
  status: { ready: boolean; cursor?: DataCursor; error?: { code: string; message: string } };
  head: DataCursor;
  'snapshot.open': DataHealth & { token: string; cursor: DataCursor; data: DataSnapshot['data']; next: boolean };
  'snapshot.page': { cursor: DataCursor; sessions: SessionInfo[]; next: boolean };
  'snapshot.close': void;
  changes: { cursor: DataCursor; through: DataCursor; changes: DataChange[]; hasMore: boolean };
  'projects.get': ProjectRegistryFile; 'projects.patch': ProjectRegistryFile;
  'pins.get': { pinned: PinnedSession[] }; 'pins.patch': { pinned: PinnedSession[] };
  'notifications.list': NotificationHistoryEntry[]; 'notifications.record': NotificationHistoryEntry;
  'notifications.read': void; 'notifications.remove': void; 'notifications.clear': void;
  'foxPointer.get': FoxSessionRecord; 'foxPointer.cas': FoxSessionRecord | null; 'foxPointer.reset': FoxSessionRecord;
  'foxObservation.get': VersionedObservation; 'foxObservation.save': VersionedObservation;
  'observation.claim': { claimed: boolean; version: number }; 'observation.settle': VersionedObservation;
  'observation.evidence': { submittedAt: string | null };
  'index.get': DataHealth & { sessions: SessionInfo[]; missing: string[]; cursor: DataCursor };
  'index.apply': DataCursor; 'index.sources': { sources: IndexSource[] }; 'index.rebuild': DataCursor;
  'index.scan': Omit<NativeScanResult, 'expectedSources'>;
  'views.get': { value: unknown } | null; 'views.put': DataCursor;
  'views.goal': { value: FoxGoalSnapshot; sourceVersion: string };
  'views.report': { value: FoxReportView; sourceVersion: string };
  invalidate: DataCursor;
  migrate: { cursor: DataCursor; warnings: string[]; alreadyMigrated: boolean };
  backup: { path: string; cursor: DataCursor };
}
const SAFE_QUERIES: Record<string, true> = { status: true, head: true, 'snapshot.open': true, 'snapshot.page': true, 'snapshot.close': true, changes: true, 'projects.get': true, 'pins.get': true, 'notifications.list': true, 'foxPointer.get': true, 'foxObservation.get': true, 'observation.evidence': true, 'index.get': true, 'index.sources': true, 'views.get': true };
export function isStorageMutation(request: StorageRequest): boolean { return !SAFE_QUERIES[request.operation]; }
