// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

import { formatApiError } from "@/lib/i18n/api-error";
import type { AdvisorChoice } from "@/lib/advisor-default";

// Sessions with an explicit per-chat advisor choice. Every command for such a
// session carries it, so the route can spawn omp with --advisor (on), run
// `/advisor off` after the spawn (off), or switch an idle live child in place.
// Keyed by session id because those decisions happen inside the route, which
// only sees id + query string. Absent = no explicit choice (the default).
const advisorChoices = new Map<string, Exclude<AdvisorChoice, "inherit">>();

export function setSessionAdvisorSpawn(sessionId: string, choice: AdvisorChoice) {
  if (choice === "inherit") advisorChoices.delete(sessionId);
  else advisorChoices.set(sessionId, choice);
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  const choice = advisorChoices.get(sessionId);
  const query = choice ? `?advisor=${choice}` : "";
  const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const body = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
  };
  if (!res.ok || body.error) {
    // Routes attach a stable `code` for well-known failures; these messages are
    // surfaced to the user as notices, so localize before throwing.
    throw new Error(
      body.error || body.code ? formatApiError(body) : `HTTP ${res.status}`,
    );
  }
  return body.data as T;
}
