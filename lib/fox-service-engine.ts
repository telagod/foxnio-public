import { randomUUID } from "node:crypto";
import type { Briefing } from "./briefing";
import type { FoxServiceConfig } from "./fox-service-config";
import type { VersionedObservation } from "./storage/protocol";
import type { FoxObservationClaimRequest, FoxObservationSettleRequest } from "./fox-service-state";
import { extractFoxEvents, planFoxTick, recordWakeFailure, type FoxServiceState, type FoxTickPlan } from "./fox-service-core";

export interface FoxServiceTarget {
  sessionId: string;
  resetAt?: string | null;
}

/** External native effects are never retried based on an expired DB lease. */
export interface FoxServiceEngineDeps {
  now: () => number;
  loadBriefing: () => Promise<Pick<Briefing, "needsYou" | "workers">>;
  loadConfig: () => FoxServiceConfig;
  loadState: () => Promise<VersionedObservation>;
  saveState: (state: FoxServiceState, expectedVersion: number) => Promise<VersionedObservation>;
  claimWake: (request: FoxObservationClaimRequest) => Promise<{ claimed: boolean; version: number }>;
  settleWake: (request: FoxObservationSettleRequest) => Promise<VersionedObservation>;
  resolveTarget: () => Promise<FoxServiceTarget | null>;
  isBusy: (target: FoxServiceTarget) => boolean;
  /** Reject with outcome:not-submitted ONLY when no native prompt was submitted. */
  wake: (target: FoxServiceTarget | null, message: string, wakeId: string) => Promise<void>;
  log?: (message: string, error?: unknown) => void;
}

export interface FoxServiceEngine {
  tick(now?: number): Promise<FoxTickPlan | null>;
  pendingCount(): number;
}

export function createFoxServiceEngine(deps: FoxServiceEngineDeps): FoxServiceEngine {
  const owner = randomUUID();
  let running: Promise<FoxTickPlan | null> | null = null;
  let runtimeState: FoxServiceState | null = null;
  let runtimeVersion: number | null = null;

  function remember(state: FoxServiceState, version: number): void {
    runtimeState = state;
    runtimeVersion = version;
  }

  async function run(now: number): Promise<FoxTickPlan | null> {
    // Reread every tick: another process may have delivered a wake or claimed it.
    const loaded = await deps.loadState();
    if (loaded.claim) {
      remember(loaded.state, loaded.version);
      return { state: loaded.state, wake: null, reason: loaded.claim.status === "uncertain" ? "wake-uncertain" : "wake-claimed" };
    }
    const state = runtimeState && runtimeVersion === loaded.version ? runtimeState : loaded.state;
    const config = deps.loadConfig();
    let briefing: Pick<Briefing, "needsYou" | "workers">;
    try {
      briefing = await deps.loadBriefing();
    } catch (error) {
      deps.log?.("briefing load failed", error);
      return null;
    }

    let target: FoxServiceTarget | null = null;
    let foxBusy = false;
    if (config.enabled) {
      try {
        target = await deps.resolveTarget();
        foxBusy = target ? deps.isBusy(target) : true;
      } catch (error) {
        deps.log?.("FOX target resolution failed", error);
        return null;
      }
    }
    const plan = planFoxTick({ events: extractFoxEvents(briefing), state, config, now, foxBusy });
    if (!plan.wake) {
      const saved = await deps.saveState(plan.state, loaded.version);
      remember(plan.state, saved.version);
      return plan;
    }

    const wakeId = randomUUID();
    const claim = await deps.claimWake({ expectedVersion: loaded.version, wakeId, targetSessionId: target?.sessionId, eventKeys: plan.wake.events.map((event) => event.key), owner, now, leaseMs: 60_000 });
    if (!claim.claimed) {
      runtimeState = null;
      runtimeVersion = null;
      return null;
    }

    let outcome: "delivered" | "not-submitted" | "uncertain" = "delivered";
    let wakeError: unknown;
    try {
      await deps.wake(target, plan.wake.message, wakeId);
    } catch (error) {
      wakeError = error;
      outcome = error && typeof error === "object" && "outcome" in error && error.outcome === "not-submitted" ? "not-submitted" : "uncertain";
    }
    const next = outcome === "not-submitted" ? recordWakeFailure(state, plan.wake.events, now) : plan.state;
    // A settlement failure leaves the persistent claim blocking replay, including
    // worker loss after COMMIT. Do not classify it as a failed native submission.
    const settled = await deps.settleWake({ wakeId, owner, outcome, state: next });
    remember(next, settled.version);
    if (outcome === "not-submitted") {
      deps.log?.("FOX wake was not submitted; will retry", wakeError);
      return { ...plan, state: next, wake: null, reason: "wake-failed" };
    }
    if (outcome === "uncertain") {
      deps.log?.("FOX wake outcome unknown; awaiting native evidence", wakeError);
      return { ...plan, state: next, wake: null, reason: "wake-uncertain" };
    }
    return plan;
  }

  return {
    pendingCount: () => runtimeState?.pending.length ?? 0,
    tick(now = deps.now()): Promise<FoxTickPlan | null> {
      if (running) return running;
      running = run(now).finally(() => { running = null; });
      return running;
    },
  };
}
