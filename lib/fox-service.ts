import { join } from "path";
import { comparableProjectPath } from "./comparable-path";
import { loadBriefingSnapshot } from "./briefing-server";
import { createFoxServiceEngine, type FoxServiceEngine, type FoxServiceTarget } from "./fox-service-engine";
import { localDayKey, type FoxTickPlan } from "./fox-service-core";
import { foxDispatchPolicy, initializeFoxNativePolicy, readFoxServiceConfig, type FoxDispatchPolicy, type FoxServiceConfig } from "./fox-service-config";
import { readFoxServiceState, writeFoxServiceState } from "./fox-service-state";
import { formatFoxBriefing } from "./fox";
import { writeFileAtomic } from "./fs-atomic";
import { readFoxSessionRecord } from "./fox-session";
import { ensureFoxWorkspace, foxWorkspaceDir } from "./fox-workspace";
import {
  getRpcSession,
  resolveSpawnCwdResult,
  startRpcSession,
} from "./rpc-manager";
import { listAllSessions, readSessionHeader, resolveSessionPath } from "./session-reader";
import { readNativeSettings } from "./omp/settings-config";
import { loadWebServerSettings } from "./web-settings";
import { loadProjectRegistry } from "./project-registry";
import { reconcileFoxReports, startFoxReportDelivery, stopFoxReportDelivery, subscribeFoxReports } from "./fox-report-store";

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

declare global {
  var __foxnioFoxService: {
    engine: FoxServiceEngine;
    timer: ReturnType<typeof setInterval>;
    initial: ReturnType<typeof setTimeout>;
    startedAt: string;
    detachReports?: () => void;
  } | undefined;
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
  const record = readFoxSessionRecord();
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
async function wakeFox(target: FoxServiceTarget | null, message: string): Promise<void> {
  if (!target) throw new Error("No active FOX conversation");
  const currentTarget = () => {
    const record = readFoxSessionRecord();
    return record.resetAt === target.resetAt && (record.sessionId === target.sessionId
      || wrapper && getRpcSession(target.sessionId) === wrapper && record.sessionId === wrapper.sessionId);
  };
  let wrapper = null as Awaited<ReturnType<typeof startRpcSession>>["session"] | null;
  if (!currentTarget()) throw new Error("FOX changed conversations before the wake");

  if (target) {
    const file = await resolveSessionPath(target.sessionId);
    const header = file ? readSessionHeader(file) : null;
    if (file && header && comparableProjectPath(header.cwd) === foxCwdKey()) {
      const { cwd } = resolveSpawnCwdResult(header.cwd);
      wrapper = (await startRpcSession(target.sessionId, file, cwd, undefined, undefined, header.cwd)).session;
    } else {
      const live = getRpcSession(target.sessionId);
      if (live?.isAlive() && comparableProjectPath(live.cwd) === foxCwdKey()) wrapper = live;
    }
  }

  if (!wrapper || !currentTarget()) throw new Error("FOX changed conversations during the wake");

  if (wrapper.isRunning() || wrapper.pendingHumanRequests() > 0) {
    throw new Error("FOX is busy");
  }
  await wrapper.send({ type: "prompt", message });
  log("woke FOX for a proactive check");
}

async function loadFoxContext() {
  const snapshot = await loadBriefingSnapshot({ days: 7 });
  // The context must still be fresh when there is no browser tab open to
  // mirror a read-only snapshot for the resident conversation.
  writeFileAtomic(join(ensureFoxWorkspace(), "BRIEFING.md"), formatFoxBriefing(snapshot.briefing));
  return snapshot.briefing;
}

function createEngine(): FoxServiceEngine {
  return createFoxServiceEngine({
    now: () => Date.now(),
    // Native worker activity is an observation, not a task state transition.
    // The model reviews the result before changing its own todo list, whether
    // or not a browser tab is open.
    loadBriefing: loadFoxContext,
    loadConfig: () => readFoxServiceConfig(),
    loadState: () => readFoxServiceState(),
    saveState: (state) => writeFoxServiceState(state),
    resolveTarget: resolveFoxTarget,
    isBusy: isFoxTargetBusy,
    wake: wakeFox,
    log,
  });
}

function getEngine(): FoxServiceEngine {
  if (!globalThis.__foxnioFoxService) {
    throw new Error("FOX service is not running");
  }
  return globalThis.__foxnioFoxService.engine;
}

/** Run one tick now (the API uses this after enabling). */
export async function requestFoxServiceTick(): Promise<FoxTickPlan | null> {
  return getEngine().tick();
}

export function foxServiceStatus(): FoxServiceStatus {
  const config = readFoxServiceConfig();
  const state = readFoxServiceState();
  const today = localDayKey(Date.now());
  const sessionId = readFoxSessionRecord().sessionId;
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
    capabilities: { agentTools: loadWebServerSettings().agentToolsEnabled, memoryTools },
    projectPolicies: Object.fromEntries(loadProjectRegistry().projects.map((project) => [project.path, foxDispatchPolicy(config, project.path)])),
  };
}

/** Idempotent for Next dev hot reloads and for repeated instrumentation calls. */
export function startFoxService(): void {
  if (globalThis.__foxnioFoxService) return;
  startFoxReportDelivery();
  initializeFoxNativePolicy();
  const engine = createEngine();
  const tick = async () => {
    await reconcileFoxReports(await listAllSessions());
    await engine.tick();
  };
  const timer = setInterval(() => {
    void tick().catch((error) => log("tick failed", error));
  }, TICK_MS);
  timer.unref?.();
  const initial = setTimeout(() => {
    void tick().catch((error) => log("initial tick failed", error));
  }, INITIAL_DELAY_MS);
  initial.unref?.();
  let reportTick: ReturnType<typeof setTimeout> | undefined;
  const detachReports = subscribeFoxReports(() => {
    if (reportTick) return;
    reportTick = setTimeout(() => {
      reportTick = undefined;
      void engine.tick().catch((error) => log("report tick failed", error));
    }, 500);
    reportTick.unref?.();
  });
  globalThis.__foxnioFoxService = {
    engine, timer, initial, startedAt: new Date().toISOString(),
    detachReports: () => { detachReports(); clearTimeout(reportTick); },
  };
  log("resident service started");
}

export function stopFoxService(): void {
  const service = globalThis.__foxnioFoxService;
  if (!service) return;
  clearInterval(service.timer);
  clearTimeout(service.initial);
  service.detachReports?.();
  void stopFoxReportDelivery();
  globalThis.__foxnioFoxService = undefined;
}
