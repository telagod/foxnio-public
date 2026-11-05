import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { listAllSessions, listSessionsByIds } from "@/lib/session-reader";
import { getRunningRpcSessions } from "@/lib/rpc-manager";
import { isValidSessionId } from "@/lib/session-file-references-core";

// The session list mixes on-disk sessions with the live runningSessionIds set,
// which changes on every agent turn, so it must never be cached by proxies or
// the browser. An ETag is still computed so conditional GETs short-circuit to
// a 304 when nothing changed (cheap client-side polling, server-side response
// body skipped).
const SESSION_LIST_HEADERS = {
  "Cache-Control": "no-store",
  Vary: "Cookie",
} as const;

/** Most sessions one `?ids=` request may ask for. */
const MAX_PARTIAL_SESSION_IDS = 100;

/**
 * GET /api/sessions?ids=<id>,<id>... — only these sessions, built exactly like
 * list entries, for clients that learned from the event stream which sessions
 * changed and should not re-download the whole list. Answers
 * `{ sessions, missing, runningSessionIds, runningSessions, partial: true }`;
 * `missing` lists requested ids with no session file. Small, so no ETag.
 */
async function partialSessions(rawIds: string): Promise<NextResponse> {
  const ids = [...new Set(rawIds.split(","))];
  if (ids.length > MAX_PARTIAL_SESSION_IDS || !ids.every((id) => isValidSessionId(id))) {
    return NextResponse.json(
      { error: `ids must be 1-${MAX_PARTIAL_SESSION_IDS} comma-separated session ids`, code: "invalid_session_ids" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  const { sessions, missing } = await listSessionsByIds(ids);
  const runningSessions = getRunningRpcSessions();
  return NextResponse.json(
    { sessions, missing, runningSessionIds: runningSessions.map((s) => s.id), runningSessions, partial: true },
    { headers: SESSION_LIST_HEADERS },
  );
}

export async function GET(req: Request) {
  try {
    const rawIds = new URL(req.url).searchParams.get("ids");
    if (rawIds !== null) return await partialSessions(rawIds);
    const sessions = await listAllSessions();
    const runningSessions = getRunningRpcSessions();
    const runningSessionIds = runningSessions.map((s) => s.id);
    const body = { sessions, runningSessionIds, runningSessions };
    const bodyJson = JSON.stringify(body);
    const etag = `"${createHash("sha1").update(bodyJson).digest("hex").slice(0, 16)}"`;
    if (req.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag, ...SESSION_LIST_HEADERS } });
    }
    return new NextResponse(bodyJson, { headers: { ETag: etag, "Content-Type": "application/json", ...SESSION_LIST_HEADERS } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error), code: "internal_error" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
