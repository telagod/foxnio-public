import { NextResponse } from "next/server";
import { comparableProjectPath } from "@/lib/comparable-path";
import { foxWorkspaceDir } from "@/lib/fox-workspace";
import { readFoxSessionRecord, compareAndSetFoxSessionId } from "@/lib/fox-session";
import { listAllSessions, readSessionHeader, resolveSessionPath } from "@/lib/session-reader";
import { isRecord } from "@/lib/type-guards";
import { getRpcSession } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

const SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/;

/** GET /api/fox/session → the active session and the last reset epoch. */
export async function GET() {
  try {
    const record = readFoxSessionRecord();
    return NextResponse.json(
      { sessionId: record.sessionId, resetAt: record.resetAt },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "Could not read the FOX session record", code: "fox_session_read_failed" }, { status: 503 });
  }
}

/**
 * POST /api/fox/session
 *
 * The browser owns the FOX conversation id in localStorage; this route lets
 * it tell the server-side proactive service which conversation to wake. Only a
 * session whose cwd is FOX's workspace is accepted, and a session created
 * before the last reset cannot revive itself.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body", code: "invalid_json" }, { status: 400 });
  }
  if (!isRecord(body) || typeof body.sessionId !== "string" || !SESSION_ID.test(body.sessionId)) {
    return NextResponse.json({ error: "A valid sessionId is required", code: "invalid_session" }, { status: 400 });
  }

  const sessionId = body.sessionId;
  let record;
  try { record = readFoxSessionRecord(); } catch {
    return NextResponse.json({ error: "Could not read the FOX session record", code: "fox_session_read_failed" }, { status: 503 });
  }
  if (record.revokedSessionId === sessionId || (body.resetAt ?? null) !== record.resetAt
    || record.sessionId !== sessionId && (body.expectedSessionId ?? null) !== record.sessionId) {
    return NextResponse.json(
      { error: "That FOX conversation was reset; start a new one", code: "fox_session_superseded" },
      { status: 409 },
    );
  }

  const foxKey = comparableProjectPath(foxWorkspaceDir());
  let valid = false;
  let createdAt: number | null = null;
  try {
    const sessions = await listAllSessions();
    const match = sessions.find((session) => session.id === sessionId);
    if (match) {
      const header = readSessionHeader(match.path);
      valid = Boolean(header && header.id === sessionId && comparableProjectPath(header.cwd) === foxKey);
      const parsed = Date.parse(header?.timestamp ?? "");
      createdAt = Number.isFinite(parsed) ? parsed : null;
    } else {
      const file = await resolveSessionPath(sessionId);
      const header = file ? readSessionHeader(file) : null;
      valid = Boolean(header && header.id === sessionId && comparableProjectPath(header.cwd) === foxKey);
      const timestamp = header ? Date.parse(header.timestamp) : NaN;
      createdAt = Number.isFinite(timestamp) ? timestamp : null;
      if (!header) {
        const live = getRpcSession(sessionId);
        if (live?.isAlive() && live.sessionId === sessionId && comparableProjectPath(live.cwd) === foxKey) {
          valid = true;
          createdAt = live.createdAt;
        }
      }
    }
  } catch {
    valid = false;
  }

  if (!valid) {
    return NextResponse.json({ error: "That session is not FOX's workspace", code: "not_fox_session" }, { status: 400 });
  }

  if (record.resetAt) {
    const resetAt = Date.parse(record.resetAt);
    if (!Number.isFinite(resetAt) || createdAt === null || !Number.isFinite(createdAt) || createdAt <= resetAt) {
      return NextResponse.json(
        { error: "That FOX conversation was reset; start a new one", code: "fox_session_superseded" },
        { status: 409 },
      );
    }
  }

  try {
    if (!compareAndSetFoxSessionId(sessionId, record)) {
      return NextResponse.json({ error: "FOX changed conversations during registration", code: "fox_session_superseded" }, { status: 409 });
    }
  } catch (error) {
    console.error("[api/fox/session]", error);
    return NextResponse.json({ error: "Could not store the FOX session", code: "fox_session_write_failed" }, { status: 500 });
  }
  return NextResponse.json({ sessionId, resetAt: record.resetAt });
}
