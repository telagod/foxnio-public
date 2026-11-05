import type { FetchLike } from "@/lib/session-store";
import type { AgentMessage, SessionInfo } from "@/lib/types";

const JSON_HEADERS = { "Content-Type": "application/json" };

const sessionUrl = (id: string): string => `/api/sessions/${encodeURIComponent(id)}`;

/** Resolves false when the server refuses. Network errors reject. */
export async function renameSessionRequest(fetchFn: FetchLike, id: string, name: string): Promise<boolean> {
  const response = await fetchFn(sessionUrl(id), { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ name }) });
  return response.ok;
}

export async function archiveSessionRequest(fetchFn: FetchLike, id: string): Promise<boolean> {
  const response = await fetchFn(`${sessionUrl(id)}/archive`, { method: "POST" });
  return response.ok;
}

export async function deleteSessionRequest(fetchFn: FetchLike, id: string): Promise<boolean> {
  const response = await fetchFn(sessionUrl(id), { method: "DELETE" });
  return response.ok;
}

/** The transcript of a session; rejects when the server refuses. */
export async function fetchTranscript(fetchFn: FetchLike, id: string): Promise<{ messages: AgentMessage[]; cwd: string | undefined }> {
  const response = await fetchFn(sessionUrl(id));
  if (!response.ok) throw new Error("Session transcript fetch failed");
  const data = await response.json() as { context?: { messages?: AgentMessage[] }; info?: { cwd?: string } };
  return { messages: data.context?.messages ?? [], cwd: data.info?.cwd };
}

export type ImportResult = { ok: true } | { ok: false; error: string };

/** Import an omp `.jsonl` session file. */
export async function importSessionRequest(fetchFn: FetchLike, fileName: string, content: string): Promise<ImportResult> {
  const response = await fetchFn("/api/sessions/import", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ fileName, content }) });
  const data = await response.json().catch(() => ({})) as { success?: boolean; error?: string };
  if (!response.ok || !data.success) return { ok: false, error: data.error ?? `HTTP ${response.status}` };
  return { ok: true };
}

/** Only leaf sessions can be archived: forks keep pointing at their parent. */
export function hasForkChildren(sessions: readonly SessionInfo[], id: string): boolean {
  return sessions.some((session) => session.parentSessionId === id);
}

/** Id for a session that is created lazily: omp is only spawned with the first message. */
export function newSessionId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Stand-in for a live session whose file is not on disk yet (it runs in
 * another tab or just started): enough to open it from the list.
 */
export function placeholderSession(id: string, cwd: string, projectRoot: string | null, now: Date = new Date()): SessionInfo {
  const timestamp = now.toISOString();
  return { id, path: "", cwd, created: timestamp, modified: timestamp, messageCount: 1, firstMessage: "", projectRoot: projectRoot ?? cwd };
}
