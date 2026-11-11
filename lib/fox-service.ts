import { join } from "path";
import { comparableProjectPath } from "./comparable-path";
import { loadBriefingSnapshot } from "./briefing-server";
import { createFoxServiceEngine, type FoxServiceEngine, type FoxServiceTarget } from "./fox-service-engine";
import { localDayKey, type FoxTickPlan } from "./fox-service-core";
import { foxDispatchPolicy, initializeFoxNativePolicy, readFoxServiceConfig, type FoxDispatchPolicy, type FoxServiceConfig } from "./fox-service-config";
import { claimFoxObservation, readFoxServiceState, settleFoxObservation, writeFoxServiceState } from "./fox-service-state";
import { formatFoxBriefing } from "./fox";
import { writeFileAtomic } from "./fs-atomic";
import { readFoxSessionRecord } from "./fox-session";
import { ensureFoxWorkspace, foxWorkspaceDir } from "./fox-workspace";
import {
  getRpcSession,
  resolveSpawnCwdResult,
  startRpcSession,
  type AgentSessionWrapper,
} from "./rpc-manager";
import { listAllSessions, readSessionHeader, resolveSessionPath } from "./session-reader";
import { readNativeSettings } from "./omp/settings-config";
import { loadWebServerSettings } from "./web-settings";
import { loadProjectRegistry } from "./project-registry";
import { reconcileFoxReports, startFoxReportDelivery, stopFoxReportDelivery, subscribeFoxReports } from "./fox-report-store";
import { foxGoalAllowsObservation, getFoxGoalSnapshot, reconcileFoxGoal } from "./fox-goal-service";
import { storageRequest } from "./storage/client";
import { drainNotificationWrites, notificationPersistenceError } from "./notification-hub";

/**
 * The resident FOX service: one 60s observation tick in the existing server
 * process. It never runs a second model loop; a wake is an ordinary prompt to
 * the existing FOX OMP session through startRpcSession/wrapper.send.
 *
 * Proactive turns observe and report only. The native tool hook blocks
 * dispatch and interactive questions during a wake; native todo and the
 * session transcript own the work, not this timer.
 */
const TICK_MS = 60_000;
const INITIAL_DELAY_MS = 5_000;

interface ResidentFoxService {
  engine: FoxServiceEngine;
  timer?: NodeJS.Timeout;
  initial?: NodeJS.Timeout;
  startedAt: string;
  detachReports?: () => void;
  stopped: boolean;
  work: Set<Promise<FoxTickPlan | null>>;
}
declare global {
  var __foxnioFoxService: ResidentFoxService | undefined;
  var __foxnioFoxServiceStart: Promise<void> | undefined;
  var __foxnioFoxServiceStop: Promise<void> | undefined;
  var __foxnioFoxServiceEpoch: number | undefined;
}

function assertServiceCurrent(epoch: number): void {
  if ((globalThis.__foxnioFoxServiceEpoch ?? 0) !== epoch) throw new Error("FOX service is stopping");
}

export interface FoxServiceStatus {
  config: FoxServiceConfig;
  seeded: boolean;
  lastTickAt: string | null;
  lastWakeAt: string | null;
  /** Native failure of the current FOX run; clears on native recovery, not a tick. */
  lastRunError: string | null;
  pending: number;
  dailyCount: number;
  persistenceError?: string | null;
  observationClaim?: { wakeId: string; status: string; targetSessionId?: string };
  capabilities?: { agentTools: boolean; memoryTools: boolean | null };
  projectPolicies?: Record<string, FoxDispatchPolicy>;
}

function log(message: string, error?: unknown): void {
  if (error) console.warn(`[fox-service] ${message}:`, error);
  else console.info(`[fox-service] ${message}`);
}

function foxCwdKey(): string {
  return comparableProjectPath(foxWorkspaceDir());
}

/**
 * The browser registers its FOX session through /api/fox/session. Before that
 * (or after a localStorage reset), fall back to the newest FOX-cwd session so
 * an existing resident conversation is not ignored.
 */
async function resolveFoxTarget(): Promise<FoxServiceTarget | null> {
  const record = await readFoxSessionRecord();
  const recorded = record.sessionId;
  if (!recorded) return null;

  const foxKey = foxCwdKey();
  // A just-created session has a live wrapper before omp writes its file.
  const live = getRpcSession(recorded);
  if (live?.isAlive() && comparableProjectPath(live.cwd) === foxKey) return { sessionId: recorded, resetAt: record.resetAt };

  const sessions = await listAllSessions();
  const match = sessions.find((session) => session.id === recorded);
  if (match && comparableProjectPath(match.cwd) === foxKey) return { sessionId: match.id, resetAt: record.resetAt };

  // The session may have fallen out of the list cache but still have a file.
  const file = await resolveSessionPath(recorded);
  const header = file ? readSessionHeader(file) : null;
  if (header && header.id === recorded && comparableProjectPath(header.cwd) === foxKey) return { sessionId: recorded, resetAt: record.resetAt };
  return null;
}

function isFoxTargetBusy(target: FoxServiceTarget): boolean {
  const wrapper = getRpcSession(target.sessionId);
  return Boolean(wrapper?.isAlive() && (
    wrapper.isRunning()
    || wrapper.pendingHumanRequests() > 0
  ));
}

/**
 * Deliver one proactive prompt. A missing or stale session is created rather
 * than reaching into an arbitrary project conversation.
 */
async function wakeFox(target: FoxServiceTarget | null, message: string, wakeId: string, epoch: number): Promise<void> {
  let wrapper: AgentSessionWrapper | null = null;
  try {
    assertServiceCurrent(epoch);
    if (!target) throw new Error("No active FOX conversation");
    const goal = await getFoxGoalSnapshot();
    if (!await foxGoalAllowsObservation(goal)) throw new Error("Observation turns cannot bypass granted or unverifiable native goal authority");
    assertServiceCurrent(epoch);
    const matches = async () => {
      const record = await readFoxSessionRecord();
      return record.resetAt === target.resetAt && (record.sessionId === target.sessionId
        || wrapper && getRpcSession(target.sessionId) === wrapper && record.sessionId === wrapper.sessionId);
    };
    if (!await matches()) throw new Error("FOX changed conversations before the wake");
    assertServiceCurrent(epoch);
    const file = await resolveSessionPath(target.sessionId);
    assertServiceCurrent(epoch);
    const header = file ? readSessionHeader(file) : null;
    if (file && header && comparableProjectPath(header.cwd) === foxCwdKey()) {
      const { cwd } = resolveSpawnCwdResult(header.cwd);
      wrapper = (await startRpcSession(target.sessionId, file, cwd, undefined, undefined, header.cwd)).session;
    } else {
      const live = getRpcSession(target.sessionId);
      if (live?.isAlive() && comparableProjectPath(live.cwd) === foxCwdKey()) wrapper = live;
    }
    if (!wrapper || !await matches()) throw new Error("FOX changed conversations during the wake");
    assertServiceCurrent(epoch);
    if (wrapper.isRunning() || wrapper.pendingHumanRequests() > 0) throw new Error("FOX is busy");
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { outcome: "not-submitted" });
  }
  // Beyond this boundary an error cannot prove non-delivery. The persisted
  // wake identity lets recovery inspect native evidence instead of replaying.
  await wrapper.send({ type: "prompt", message: `${message}\n\n[FOX observation wake: ${wakeId}]` });
  log("woke FOX for a proactive check");
}

async function loadFoxContext(epoch: number) {
  const snapshot = await loadBriefingSnapshot({ days: 7 });
  assertServiceCurrent(epoch);
  // The context must still be fresh when there is no browser tab open to
  // mirror a read-only snapshot for the resident conversation.
  writeFileAtomic(join(ensureFoxWorkspace(), "BRIEFING.md"), formatFoxBriefing(snapshot.briefing));
  return snapshot.briefing;
}

function createEngine(epoch: number): FoxServiceEngine {
  return createFoxServiceEngine({
    now: () => Date.now(),
    // Native worker activity is an observation, not a task state transition.
    // The model reviews the result before changing its own todo list, whether
    // or not a browser tab is open.
    loadBriefing: () => loadFoxContext(epoch),
    loadConfig: () => readFoxServiceConfig(),
    loadState: () => readFoxServiceState(),
    saveState: (state, version) => writeFoxServiceState(state, version),
    claimWake: (request) => claimFoxObservation(request),
    settleWake: (request) => settleFoxObservation(request),
    resolveTarget: resolveFoxTarget,
    isBusy: isFoxTargetBusy,
    wake: (target, message, wakeId) => wakeFox(target, message, wakeId, epoch),
    log,
  });
}

async function reconcileObservationWake(): Promise<void> {
  const loaded = await readFoxServiceState();
  const claim = loaded.claim;
  if (!claim?.targetSessionId) return;
  const filePath = await resolveSessionPath(claim.targetSessionId);
  if (!filePath) return;
  const proof = await storageRequest({ operation: "observation.evidence", filePath, wakeId: claim.wakeId });
  if (!proof.submittedAt) return;
  const next = { ...loaded.state, seen: { ...loaded.state.seen }, lastWakeAt: proof.submittedAt };
  for (const key of claim.eventKeys) next.seen[key] = proof.submittedAt;
  if (claim.status === "pending") {
    const day = localDayKey(Date.parse(proof.submittedAt));
    next.daily = { date: day, count: (next.daily.date === day ? next.daily.count : 0) + 1 };
  }
  await settleFoxObservation({ wakeId: claim.wakeId, owner: claim.owner, outcome: "delivered", state: next });
}

function runServiceTick(service: ResidentFoxService, reports: boolean): Promise<FoxTickPlan | null> {
  if (service.stopped) return Promise.resolve(null);
  const pending = (async () => {
    await reconcileObservationWake();
    if (service.stopped) return null;
    if (reports) {
      const sessions = await listAllSessions();
      if (service.stopped) return null;
      await reconcileFoxReports(sessions);
      if (service.stopped) return null;
    }
    await reconcileFoxGoal();
    if (service.stopped) return null;
    const goal = await getFoxGoalSnapshot();
    if (service.stopped) return null;
    const allowed = await foxGoalAllowsObservation(goal);
    if (service.stopped || !allowed) return null;
    return service.engine.tick();
  })();
  service.work.add(pending);
  void pending.then(() => service.work.delete(pending), () => service.work.delete(pending));
  return pending;
}

/** Run one tick now (the API uses this after enabling). */
export async function requestFoxServiceTick(): Promise<FoxTickPlan | null> {
  if (globalThis.__foxnioFoxServiceStop) return null;
  const epoch = globalThis.__foxnioFoxServiceEpoch ?? 0;
  await startFoxService();
  const service = globalThis.__foxnioFoxService;
  if (!service || (globalThis.__foxnioFoxServiceEpoch ?? 0) !== epoch) return null;
  return runServiceTick(service, false);
}

export async function foxServiceStatus(): Promise<FoxServiceStatus> {
  const config = readFoxServiceConfig();
  const [observation, pointer, registry] = await Promise.all([readFoxServiceState(), readFoxSessionRecord(), loadProjectRegistry()]);
  const { state } = observation;
  const today = localDayKey(Date.now());
  const sessionId = pointer.sessionId;
  const wrapper = sessionId ? getRpcSession(sessionId) : undefined;
  const lastRunError = wrapper && comparableProjectPath(wrapper.cwd) === foxCwdKey()
    ? wrapper.lastRunErrorMessage() : null;
  let memoryTools: boolean | null = null;
  try {
    const backend = readNativeSettings().settings.memory?.backend;
    memoryTools = backend === "mnemopi" || backend === "hindsight";
  } catch {}
  return {
    config,
    seeded: Boolean(state.seededAt),
    lastTickAt: state.lastTickAt,
    lastWakeAt: state.lastWakeAt,
    lastRunError,
    pending: globalThis.__foxnioFoxService?.engine.pendingCount() ?? 0,
    dailyCount: state.daily.date === today ? state.daily.count : 0,
    persistenceError: notificationPersistenceError(),
    ...(observation.claim ? { observationClaim: { wakeId: observation.claim.wakeId, status: observation.claim.status, targetSessionId: observation.claim.targetSessionId } } : {}),
    capabilities: { agentTools: loadWebServerSettings().agentToolsEnabled, memoryTools },
    projectPolicies: Object.fromEntries(registry.projects.map((project) => [project.path, foxDispatchPolicy(config, project.path)])),
  };
}

/** Idempotent for Next dev hot reloads and for repeated instrumentation calls. */
export async function startFoxService(): Promise<void> {
  if (globalThis.__foxnioFoxServiceStop || globalThis.__foxnioFoxService) return;
  if (globalThis.__foxnioFoxServiceStart) return globalThis.__foxnioFoxServiceStart;
  const epoch = globalThis.__foxnioFoxServiceEpoch ?? 0;
  const starting = (async () => {
    await storageRequest({ operation: "head" });
    if ((globalThis.__foxnioFoxServiceEpoch ?? 0) !== epoch) return;
    initializeFoxNativePolicy();
    const service: ResidentFoxService = {
      engine: createEngine(epoch), startedAt: new Date().toISOString(), stopped: false, work: new Set(),
    };
    let reportTick: NodeJS.Timeout | undefined;
    try {
      const detachReports = subscribeFoxReports(() => {
        if (service.stopped || reportTick) return;
        reportTick = setTimeout(() => {
          reportTick = undefined;
          void runServiceTick(service, false).catch((error) => log("report tick failed", error));
        }, 500);
        reportTick.unref?.();
      });
      service.detachReports = () => { detachReports(); clearTimeout(reportTick); };
      service.timer = setInterval(() => {
        void runServiceTick(service, true).catch((error) => log("tick failed", error));
      }, TICK_MS);
      service.timer.unref?.();
      service.initial = setTimeout(() => {
        void runServiceTick(service, true).catch((error) => log("initial tick failed", error));
      }, INITIAL_DELAY_MS);
      service.initial.unref?.();
      startFoxReportDelivery();
      globalThis.__foxnioFoxService = service;
      log("resident service started");
    } catch (error) {
      service.stopped = true;
      clearInterval(service.timer);
      clearTimeout(service.initial);
      service.detachReports?.();
      await stopFoxReportDelivery();
      throw error;
    }
  })();
  globalThis.__foxnioFoxServiceStart = starting;
  try { await starting; }
  finally { if (globalThis.__foxnioFoxServiceStart === starting) globalThis.__foxnioFoxServiceStart = undefined; }
}

export async function stopFoxService(): Promise<void> {
  if (globalThis.__foxnioFoxServiceStop) return globalThis.__foxnioFoxServiceStop;
  globalThis.__foxnioFoxServiceEpoch = (globalThis.__foxnioFoxServiceEpoch ?? 0) + 1;
  const service = globalThis.__foxnioFoxService;
  if (service) {
    service.stopped = true;
    clearInterval(service.timer);
    clearTimeout(service.initial);
    service.detachReports?.();
  }
  const stopping = (async () => {
    await globalThis.__foxnioFoxServiceStart?.catch(() => {});
    if (service) await Promise.allSettled(service.work);
    await stopFoxReportDelivery();
    await drainNotificationWrites();
  })();
  globalThis.__foxnioFoxServiceStop = stopping;
  try { await stopping; }
  finally {
    if (globalThis.__foxnioFoxService === service) globalThis.__foxnioFoxService = undefined;
    if (globalThis.__foxnioFoxServiceStop === stopping) globalThis.__foxnioFoxServiceStop = undefined;
  }
}
