import type { Briefing } from "./briefing";
import type { FoxServiceConfig } from "./fox-service-config";
import {
  extractFoxEvents,
  planFoxTick,
  recordWakeFailure,
  type FoxServiceState,
  type FoxTickPlan,
} from "./fox-service-core";

/**
 * One single-flight tick. The production wrapper supplies the session/RPC,
 * file and config I/O; tests can run the same decision path with fakes.
 */
export interface FoxServiceTarget {
  sessionId: string;
  resetAt?: string | null;
}

export interface FoxServiceEngineDeps {
  now: () => number;
  /** Read native attention and worker activity without writing a second ledger. */
  loadBriefing: () => Promise<Pick<Briefing, "needsYou" | "workers">>;
  loadConfig: () => FoxServiceConfig;
  loadState: () => FoxServiceState;
  saveState: (state: FoxServiceState) => void;
  /** The current FOX conversation, or null when one must be created. */
  resolveTarget: () => Promise<FoxServiceTarget | null>;
  isBusy: (target: FoxServiceTarget) => boolean;
  wake: (target: FoxServiceTarget | null, message: string) => Promise<void>;
  log?: (message: string, error?: unknown) => void;
}

export interface FoxServiceEngine {
  tick(now?: number): Promise<FoxTickPlan | null>;
  pendingCount(): number;
}

export function createFoxServiceEngine(deps: FoxServiceEngineDeps): FoxServiceEngine {
  let running: Promise<FoxTickPlan | null> | null = null;
  let runtimeState: FoxServiceState | null = null;
  const save = (state: FoxServiceState) => {
    deps.saveState(state);
    runtimeState = state;
  };

  async function run(now: number): Promise<FoxTickPlan | null> {
    const config = deps.loadConfig();
    let state = runtimeState ?? deps.loadState();

    let briefing: Pick<Briefing, "needsYou" | "workers">;
    try {
      briefing = await deps.loadBriefing();
    } catch (error) {
      deps.log?.("briefing load failed", error);
      return null;
    }

    const events = extractFoxEvents(briefing);
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

    const plan = planFoxTick({ events, state, config, now, foxBusy });
    if (plan.wake) {
      const wake = plan.wake;
      try {
        await deps.wake(target, wake.message);
      } catch (error) {
        state = recordWakeFailure(state, wake.events, now);
        save(state);
        deps.log?.("FOX wake failed; will retry", error);
        return { ...plan, state, wake: null, reason: "wake-failed" };
      }
    }

    save(plan.state);
    return plan;
  }

  return {
    pendingCount: () => runtimeState?.pending.length ?? 0,
    tick(now = deps.now()): Promise<FoxTickPlan | null> {
      if (running) return running;
      running = run(now).finally(() => {
        running = null;
      });
      return running;
    },
  };
}
