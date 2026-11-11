import { join } from "node:path";
import { stat } from "node:fs/promises";
import { storageRequest, storageRoots, subscribeStorageChanges, closeStorage } from "./storage/client";
import { startSessionIndex, stopSessionIndex } from "./session-index";
import { subscribeRunningSessions } from "./rpc-manager";
import { subscribeFoxReports } from "./fox-report-store";
import { loadBriefingSnapshot } from "./briefing-server";
import { ensureFoxWorkspace } from "./fox-workspace";
import { formatFoxBriefing } from "./fox";
import { writeFileAtomic } from "./fs-atomic";
import { drainNotificationWrites } from "./notification-hub";
import { startFoxService, stopFoxService } from "./fox-service";

interface Runtime {
  stop: Array<() => void>;
  work: Set<Promise<unknown>>;
  timer?: NodeJS.Timeout;
  pending?: NodeJS.Timeout;
  mirroring: boolean;
  again: boolean;
  content: string | null;
  stopped: boolean;
  operatorStamp: string | null;
}
interface DataServices {
  stopped: boolean;
  retryMs: number;
  timer?: NodeJS.Timeout;
  starting?: Promise<void>;
}
declare global {
  var __foxDataRuntime: Runtime | undefined;
  var __foxDataRuntimeStart: Promise<void> | undefined;
  var __foxDataRuntimeStop: Promise<void> | undefined;
  var __foxDataRuntimeEpoch: number | undefined;
  var __foxDataServices: DataServices | undefined;
}

function track(runtime: Runtime, work: Promise<unknown>): void {
  runtime.work.add(work);
  void work.then(() => runtime.work.delete(work), () => runtime.work.delete(work));
}

function halt(runtime: Runtime): void {
  runtime.stopped = true;
  clearInterval(runtime.timer);
  clearTimeout(runtime.pending);
  for (const stop of runtime.stop.splice(0).reverse()) stop();
}

async function mirror(runtime: Runtime): Promise<void> {
  if (runtime.stopped) return;
  if (runtime.mirroring) { runtime.again = true; return; }
  runtime.mirroring = true;
  try {
    do {
      runtime.again = false;
      const { briefing } = await loadBriefingSnapshot({ days: 7 });
      if (runtime.stopped) return;
      const content = formatFoxBriefing(briefing);
      // generatedAt is presentation freshness, not a reason to rewrite unchanged facts.
      const identity = content.replace(/^Updated:.*$/m, "Updated:");
      if (identity !== runtime.content) {
        writeFileAtomic(join(ensureFoxWorkspace(), "BRIEFING.md"), content);
        runtime.content = identity;
      }
    } while (runtime.again && !runtime.stopped);
  } catch (error) {
    console.warn("[data-runtime] briefing projection unavailable:", error);
  } finally { runtime.mirroring = false; }
}
function scheduleMirror(runtime: Runtime): void {
  if (runtime.stopped || runtime.pending) return;
  runtime.pending = setTimeout(() => { runtime.pending = undefined; track(runtime, mirror(runtime)); }, 250);
  runtime.pending.unref?.();
}
async function checkOperatorFiles(runtime: Runtime): Promise<void> {
  const roots = storageRoots();
  const paths = [join(roots.agentDir, "omp-web-settings.json"), join(roots.foxDir, "service.json")];
  const stamps = await Promise.all(paths.map(async (path) => {
    try { const s = await stat(path); return `${path}:${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
    catch (error) { return `${path}:${(error as NodeJS.ErrnoException).code ?? "unavailable"}`; }
  }));
  const current = JSON.stringify(stamps);
  if (runtime.stopped) return;
  if (runtime.operatorStamp !== null && current !== runtime.operatorStamp) await storageRequest({ operation: "invalidate", topic: "operator-settings", keys: ["settings", "policy"] });
  runtime.operatorStamp = current;
}

/** One startup attempt, shared by callers that need a ready index before continuing. */
export async function startDataRuntime(): Promise<void> {
  if (globalThis.__foxDataRuntimeStop) throw new Error("Data runtime is stopping");
  if (globalThis.__foxDataRuntime) return;
  if (globalThis.__foxDataRuntimeStart) return globalThis.__foxDataRuntimeStart;
  const epoch = globalThis.__foxDataRuntimeEpoch ?? 0;
  const assertCurrent = () => {
    if ((globalThis.__foxDataRuntimeEpoch ?? 0) !== epoch) throw new Error("Data runtime startup canceled");
  };
  const starting = (async () => {
    const runtime: Runtime = { stop: [], work: new Set(), mirroring: false, again: false, content: null, stopped: false, operatorStamp: null };
    try {
      await storageRequest({ operation: "head" });
      assertCurrent();
      runtime.stop.push(await startSessionIndex());
      assertCurrent();
      runtime.stop.push(subscribeStorageChanges(() => scheduleMirror(runtime)));
      runtime.stop.push(subscribeRunningSessions(() => scheduleMirror(runtime)));
      runtime.stop.push(subscribeFoxReports(() => {
        if (runtime.stopped) return;
        track(runtime, storageRequest({ operation: "invalidate", topic: "fox-display", keys: ["reports"] })
          .catch((error) => console.warn("[data-runtime] report invalidation failed:", error)));
        scheduleMirror(runtime);
      }));
      await checkOperatorFiles(runtime);
      assertCurrent();
      runtime.timer = setInterval(() => {
        if (!runtime.stopped) track(runtime, checkOperatorFiles(runtime)
          .catch((error) => console.warn("[data-runtime] operator reconciliation failed:", error)));
      }, 5000);
      runtime.timer.unref?.();
      globalThis.__foxDataRuntime = runtime;
      scheduleMirror(runtime);
    } catch (error) {
      halt(runtime);
      await Promise.all(runtime.work);
      await stopSessionIndex();
      throw error;
    }
  })();
  globalThis.__foxDataRuntimeStart = starting;
  try { await starting; } finally { if (globalThis.__foxDataRuntimeStart === starting) globalThis.__foxDataRuntimeStart = undefined; }
}

/** Resident, browser-independent startup. Registration never waits for recovery. */
export function startDataServices(): void {
  if (globalThis.__foxDataRuntimeStop || globalThis.__foxDataServices) return;
  const services: DataServices = { stopped: false, retryMs: 1000 };
  globalThis.__foxDataServices = services;
  const attempt = () => {
    if (services.stopped) return;
    services.starting = (async () => {
      try {
        await startDataRuntime();
        if (services.stopped) return;
        await startFoxService();
      } catch (error) {
        if (services.stopped) return;
        console.warn("[data-runtime] data services unavailable; retrying:", error);
        services.timer = setTimeout(() => { services.timer = undefined; attempt(); }, services.retryMs);
        services.timer.unref?.();
        services.retryMs = Math.min(30_000, services.retryMs * 2);
      } finally {
        services.starting = undefined;
      }
    })();
  };
  attempt();
}

/** Cancel startup first, quiesce producers, then drain and release storage. */
export async function stopDataRuntime(): Promise<void> {
  if (globalThis.__foxDataRuntimeStop) return globalThis.__foxDataRuntimeStop;
  globalThis.__foxDataRuntimeEpoch = (globalThis.__foxDataRuntimeEpoch ?? 0) + 1;
  const services = globalThis.__foxDataServices;
  if (services) {
    services.stopped = true;
    clearTimeout(services.timer);
  }
  const runtime = globalThis.__foxDataRuntime;
  globalThis.__foxDataRuntime = undefined;
  if (runtime) halt(runtime);
  const stopping = (async () => {
    const errors: unknown[] = [];
    const finish = async (work: () => Promise<unknown>) => {
      try { await work(); } catch (error) { errors.push(error); }
    };
    // Close FOX admission immediately, including a storage-gated FOX startup.
    const foxStopping = finish(stopFoxService);
    await globalThis.__foxDataRuntimeStart?.catch(() => {});
    await services?.starting;
    await foxStopping;
    if (runtime) await finish(() => Promise.all(runtime.work));
    await finish(stopSessionIndex);
    await finish(drainNotificationWrites);
    await finish(closeStorage);
    if (errors.length) throw new AggregateError(errors, "Data services shutdown failed");
  })();
  globalThis.__foxDataRuntimeStop = stopping;
  try { await stopping; }
  finally {
    if (globalThis.__foxDataRuntimeStop === stopping) globalThis.__foxDataRuntimeStop = undefined;
    if (globalThis.__foxDataServices === services) globalThis.__foxDataServices = undefined;
  }
}
