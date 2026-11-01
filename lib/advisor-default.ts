/**
 * Which advisor state a chat runs with, and why.
 *
 * Two layers decide it:
 * - The default: omp enables the advisor on its own when `advisor.enabled: true`
 *   is set in the agent dir's config.yml (verified against omp 18.14.1 in rpc
 *   mode, no flag needed), and omp-web adds `--advisor` when the workspace
 *   launch config says so.
 * - The chat's own choice: `inherit` (follow the default), `on` or `off`. An
 *   explicit choice overrides the default in both directions. Turning it on
 *   spawns with `--advisor` (or runs `/advisor on` on a live child); turning it
 *   off runs omp's native `/advisor off` after every spawn, because omp has no
 *   launch flag that disables a configured advisor.
 *
 * Pure and `fs`-free: the settings UI, the chat hook and the API routes share it.
 */

export interface AdvisorDefault {
  /** True when either source enables the advisor for every chat. */
  enabled: boolean;
  /** `advisor.enabled: true` in the omp config.yml the chat's omp reads. */
  ompConfig: boolean;
  /** `launchConfig.advisor: true` on the chat's registered workspace. */
  project: boolean;
}

export const NO_ADVISOR_DEFAULT: AdvisorDefault = { enabled: false, ompConfig: false, project: false };

/** Dispatched on `window` after the persistent default changes in Settings. */
export const ADVISOR_DEFAULT_CHANGED_EVENT = "omp-advisor-default-changed";

/** Combine the two default sources; only a literal `true` counts. */
export function resolveAdvisorDefault(sources: { ompConfig?: unknown; project?: unknown }): AdvisorDefault {
  const ompConfig = sources.ompConfig === true;
  const project = sources.project === true;
  return { enabled: ompConfig || project, ompConfig, project };
}

/** Read the `/api/advisor-default` payload; anything malformed means no default. */
export function parseAdvisorDefault(data: unknown): AdvisorDefault {
  if (!data || typeof data !== "object") return NO_ADVISOR_DEFAULT;
  const record = data as Record<string, unknown>;
  return resolveAdvisorDefault({ ompConfig: record.ompConfig, project: record.project });
}

/** A chat's own advisor setting; `inherit` follows the default. */
export type AdvisorChoice = "inherit" | "on" | "off";

/** Parse a wire value (query string, request body); anything but on/off inherits. */
export function parseAdvisorChoice(value: unknown): AdvisorChoice {
  return value === "on" || value === "off" ? value : "inherit";
}

/** The state the chat actually runs with: an explicit choice wins, otherwise the default. */
export function resolveEffectiveAdvisor(advisorDefault: AdvisorDefault, choice: AdvisorChoice): boolean {
  if (choice === "on") return true;
  if (choice === "off") return false;
  return advisorDefault.enabled;
}

/**
 * Read a persisted choice. The first per-chat toggle stored the strings
 * "true"/"false" (a chat's own on/off, written only after the user clicked), so
 * they migrate to `on`/`off`. Missing or unknown values inherit.
 */
export function parseStoredAdvisorChoice(raw: string | null | undefined): AdvisorChoice {
  if (raw === "on" || raw === "true") return "on";
  if (raw === "off" || raw === "false") return "off";
  return "inherit";
}

function advisorChoiceStorageKey(sessionId: string): string {
  return `omp-advisor-enabled:${sessionId}`;
}

/** The chat's stored choice; private mode or a missing key inherits. */
export function readStoredAdvisorChoice(sessionId: string): AdvisorChoice {
  try {
    return parseStoredAdvisorChoice(localStorage.getItem(advisorChoiceStorageKey(sessionId)));
  } catch {
    return "inherit";
  }
}

/** Persist the chat's choice; `inherit` clears it. Best effort (in-memory state still applies). */
export function storeAdvisorChoice(sessionId: string, choice: AdvisorChoice): void {
  try {
    if (choice === "inherit") localStorage.removeItem(advisorChoiceStorageKey(sessionId));
    else localStorage.setItem(advisorChoiceStorageKey(sessionId), choice);
  } catch {
    // Private mode: the choice lasts for this page load only.
  }
}

/** Which source to name when explaining a default (config wins when both apply). */
export function advisorDefaultSource(advisorDefault: AdvisorDefault): "omp-config" | "project" | null {
  if (advisorDefault.ompConfig) return "omp-config";
  if (advisorDefault.project) return "project";
  return null;
}
