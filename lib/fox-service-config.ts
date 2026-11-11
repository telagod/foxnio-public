import { existsSync, readFileSync, realpathSync } from "fs";
import { isAbsolute, join } from "path";
import { DatabaseSync } from "node:sqlite";
import { comparableProjectPath } from "./comparable-path";
import { writeFileAtomic } from "./fs-atomic";
import { getAgentDir } from "./omp/paths";
import { foxWorkspaceDir } from "./fox-workspace";

/**
 * User-controlled policy for the resident FOX service. It is intentionally
 * small and auditable: a global switch, quiet hours and a daily message cap.
 * Per-project dispatch permissions are enforced by the native tool hook; this
 * file stores policy, never tasks or pending approvals.
 */
export type FoxDispatchPolicy = "observe" | "confirm" | "auto";

export interface FoxServiceConfig {
  enabled: boolean;
  /** Local server time, HH:MM. A window may wrap midnight (22:00 → 08:00). */
  quietStart: string;
  quietEnd: string;
  /** Proactive FOX turns per local day. */
  maxDailyMessages: number;
  /** Unsolicited goal outcome/decision notifications; never gates execution. */
  maxDailyGoalNotifications: number;
  dispatchPolicies?: Record<string, FoxDispatchPolicy>;
  nativePolicyVersion?: 1;
}

export const DEFAULT_FOX_SERVICE_CONFIG: FoxServiceConfig = {
  enabled: false,
  quietStart: "22:00",
  quietEnd: "08:00",
  maxDailyMessages: 3,
  maxDailyGoalNotifications: 10,
};

const FILE = "service.json";
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function foxServiceConfigPath(home?: string): string {
  return join(foxWorkspaceDir(home), FILE);
}

function validTime(value: unknown): value is string {
  return typeof value === "string" && TIME.test(value);
}

/** Normalize user input and persisted JSON; every invalid field falls back. */
export function normalizeFoxServiceConfig(value: unknown): FoxServiceConfig {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const max = typeof raw.maxDailyMessages === "number" && Number.isFinite(raw.maxDailyMessages)
    ? Math.min(10, Math.max(1, Math.trunc(raw.maxDailyMessages)))
    : DEFAULT_FOX_SERVICE_CONFIG.maxDailyMessages;
  const goalMax = typeof raw.maxDailyGoalNotifications === "number" && Number.isFinite(raw.maxDailyGoalNotifications)
    ? Math.min(100, Math.max(1, Math.trunc(raw.maxDailyGoalNotifications)))
    : DEFAULT_FOX_SERVICE_CONFIG.maxDailyGoalNotifications;
  return {
    enabled: raw.enabled === true,
    quietStart: validTime(raw.quietStart) ? raw.quietStart : DEFAULT_FOX_SERVICE_CONFIG.quietStart,
    quietEnd: validTime(raw.quietEnd) ? raw.quietEnd : DEFAULT_FOX_SERVICE_CONFIG.quietEnd,
    maxDailyMessages: max,
    maxDailyGoalNotifications: goalMax,
    ...(raw.dispatchPolicies && typeof raw.dispatchPolicies === "object" && !Array.isArray(raw.dispatchPolicies)
      ? { dispatchPolicies: Object.fromEntries(Object.entries(raw.dispatchPolicies).map(([key, value]) => [
        key, value === "auto" || value === "confirm" ? value : "observe",
      ])) as Record<string, FoxDispatchPolicy> }
      : {}),
    ...(raw.nativePolicyVersion === 1 ? { nativePolicyVersion: 1 as const } : {}),
  };
}

export function readFoxServiceConfig(home?: string): FoxServiceConfig {
  try {
    return normalizeFoxServiceConfig(JSON.parse(readFileSync(foxServiceConfigPath(home), "utf8")));
  } catch {
    return { ...DEFAULT_FOX_SERVICE_CONFIG };
  }
}

export function writeFoxServiceConfig(config: FoxServiceConfig, home?: string): FoxServiceConfig {
  const normalized = normalizeFoxServiceConfig(config);
  const path = foxServiceConfigPath(home);
  writeFileAtomic(path, JSON.stringify(normalized, null, 2), { backup: true });
  return normalized;
}

export function foxDispatchProjectKey(cwd: string): string {
  return comparableProjectPath(existsSync(cwd) ? realpathSync(cwd) : cwd);
}

export function foxDispatchPolicy(config: FoxServiceConfig, cwd: string): FoxDispatchPolicy {
  return config.dispatchPolicies?.[foxDispatchProjectKey(cwd)] ?? "confirm";
}

export function initializeFoxNativePolicy(home?: string, legacyPath = join(getAgentDir(), "omp-web", "chief.db")): FoxServiceConfig {
  const configPath = foxServiceConfigPath(home);
  const config = existsSync(configPath)
    ? normalizeFoxServiceConfig(JSON.parse(readFileSync(configPath, "utf8")))
    : { ...DEFAULT_FOX_SERVICE_CONFIG };
  if (config.nativePolicyVersion === 1) return config;
  const dispatchPolicies: Record<string, FoxDispatchPolicy> = {};
  const priority = { auto: 0, confirm: 1, observe: 2 };
  if (existsSync(legacyPath)) {
    const database = new DatabaseSync(legacyPath, { readOnly: true });
    try {
      for (const row of database.prepare("SELECT project_ref, level FROM autonomy").all()) {
        if (typeof row.project_ref !== "string" || !isAbsolute(row.project_ref)) continue;
        const key = foxDispatchProjectKey(row.project_ref);
        const policy = row.level === "auto" ? "auto" : row.level === "suggest" || row.level === "approve" ? "confirm" : "observe";
        if (!dispatchPolicies[key] || priority[policy] > priority[dispatchPolicies[key]]) dispatchPolicies[key] = policy;
      }
    } finally {
      database.close();
    }
  }
  return writeFoxServiceConfig({
    ...config,
    dispatchPolicies: { ...dispatchPolicies, ...config.dispatchPolicies },
    nativePolicyVersion: 1,
  }, home);
}
