import { NextResponse } from "next/server";
import { resolveSessionPath } from "./session-reader";

const SESSION_NOT_FOUND = { error: "Session not found", code: "session_not_found" } as const;

/** Resolve a session id to its file path, or a 404 JSON response. Replaces the
 * repeated `resolveSessionPath(id)` + "Session not found" guard across routes. */
export async function resolveSessionPathOr404(
  id: string,
): Promise<{ filePath: string } | { response: NextResponse }> {
  const filePath = await resolveSessionPath(id);
  if (!filePath) return { response: NextResponse.json(SESSION_NOT_FOUND, { status: 404 }) };
  return { filePath };
}

/** Uniform JSON error body used by most API routes. */
export function apiErrorResponse(error: unknown, status = 500): NextResponse {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
  const storageError = code && (code.startsWith("storage_") || code.startsWith("migration_") || code === "restore_required" || code === "reset_required" || code === "schema_unsupported");
  const effectiveStatus = storageError ? (code === "storage_conflict" || code === "reset_required" ? 409 : 503) : status;
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error), ...(storageError ? { code } : {}) }, { status: effectiveStatus });
}
