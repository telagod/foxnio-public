import type { SessionInfo } from "@/lib/types";
import type { SessionStore } from "@/lib/session-store";

/** A session record, `null` when the id is not in the list, "unavailable" when the list could not be read. */
export type ResolvedSession = SessionInfo | null | "unavailable";

/**
 * Looks a session up in the shared store, refreshing the list once when the
 * id is not there yet. Tells "the id is gone" apart from "the list could not
 * be loaded" so callers can keep history entries or fall back to a full page
 * load.
 */
export async function resolveStoreSession(store: Pick<SessionStore, "ensureSession" | "getSnapshot">, id: string): Promise<ResolvedSession> {
  const session = await store.ensureSession(id);
  if (session) return session;
  return store.getSnapshot().sessionsStatus === "error" ? "unavailable" : null;
}
