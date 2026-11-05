import { createHash } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import { resolve } from "path";
import { writeFileAtomic } from "./fs-atomic";
import { getAgentDir } from "./omp/paths";
import { isRecord } from "./type-guards";

/** omp-web's own server-side settings (omp's config.yml stays omp's). */
export interface WebServerSettings {
  /** Resume sessions that were mid-run when omp-web stopped. */
  autoResumeSessions: boolean;
  /**
   * Server-side agent tools (issue #275: list_sessions / new_session /
   * send_to_session). OFF by default: when on, any agent session may call
   * them to reach other sessions, with no browser tab required. Sessions
   * pick the tools up on their next host-tool registration (session start
   * or SSE reconnect).
   */
  agentToolsEnabled: boolean;
  /**
   * Environment variables merged into the `omp` child process (issue #104).
   * Stored as a validated record; lib/omp/agent-env.ts owns the policy and
   * re-checks every name before handing it to a spawn.
   */
  agentEnv: Record<string, string>;
}

const DEFAULTS: WebServerSettings = { autoResumeSessions: false, agentToolsEnabled: false, agentEnv: {} };

/** String-valued entries only — the allow-list lives in lib/omp/agent-env.ts. */
function readAgentEnvRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const entries: Array<[string, string]> = [];
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry === "string") entries.push([name, entry]);
  }
  return Object.fromEntries(entries);
}

function settingsPath(): string {
  return resolve(getAgentDir(), "omp-web-settings.json");
}

declare global {
  // Shared across module instances (instrumentation and route bundles).
  var __ompWebSettingsCache: { path: string; stamp: string; settings: WebServerSettings } | undefined;
}

/** Changes whenever the file is replaced or edited (manual edit, other process), so the cache never outlives the content it was read from. */
function fileStamp(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

export function loadWebServerSettings(): WebServerSettings {
  const path = settingsPath();
  const stamp = fileStamp(path);
  const cached = globalThis.__ompWebSettingsCache;
  if (cached?.path === path && cached.stamp === stamp) return cached.settings;
  let settings = DEFAULTS;
  try {
    if (existsSync(path)) {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isRecord(raw)) {
        settings = {
          autoResumeSessions: raw.autoResumeSessions === true,
          agentToolsEnabled: raw.agentToolsEnabled === true,
          agentEnv: readAgentEnvRecord(raw.agentEnv),
        };
      }
    }
  } catch {
    // Unreadable settings fall back to the defaults.
  }
  globalThis.__ompWebSettingsCache = { path, stamp, settings };
  return settings;
}

/** Atomic write (temp file + rename). The file holds agentEnv values (API keys),
 * so it is created owner-only and keeps whatever mode the user gave it. */
export function saveWebServerSettings(patch: Partial<WebServerSettings>): WebServerSettings {
  const path = settingsPath();
  const settings = { ...loadWebServerSettings(), ...patch };
  writeFileAtomic(path, `${JSON.stringify(settings, null, 2)}\n`);
  globalThis.__ompWebSettingsCache = { path, stamp: fileStamp(path), settings };
  return settings;
}

/** Identifies the stored agentEnv content. The editor sends it back with a save
 * so an environment changed meanwhile (another tab, a manual edit) is not
 * overwritten by a stale copy. */
export function agentEnvRevision(agentEnv: Record<string, string>): string {
  const entries = Object.entries(agentEnv).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
