import { NextResponse } from "next/server";
import { clearFoxSessionId, readFoxSessionRecord } from "@/lib/fox-session";
import { isRecord } from "@/lib/type-guards";
import { controlFoxGoal } from "@/lib/fox-goal-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/fox/session/reset
 *
 * Forget the current FOX conversation pointer. The next prompt creates a new
 * ordinary FOX session; the old transcript is left untouched for the session
 * list/archive.
 */
export async function POST(request: Request) {
  try {
    const expected = await request.json().catch(() => null);
    if (!isRecord(expected)) return NextResponse.json({ error: "The current FOX conversation is required", code: "fox_session_required" }, { status: 400 });
    const current = readFoxSessionRecord();
    if (expected.sessionId !== current.sessionId || expected.resetAt !== current.resetAt) {
      return NextResponse.json({ error: "FOX changed conversations before reset", code: "fox_session_superseded" }, { status: 409 });
    }
    await controlFoxGoal("reset");
    const after = readFoxSessionRecord();
    if (after.sessionId !== current.sessionId || after.resetAt !== current.resetAt) {
      return NextResponse.json({ error: "FOX changed conversations during reset", code: "fox_session_superseded" }, { status: 409 });
    }
    const record = clearFoxSessionId();
    return NextResponse.json({ sessionId: null, resetAt: record.resetAt });
  } catch {
    return NextResponse.json({ error: "Could not reset the FOX conversation", code: "fox_session_reset_failed" }, { status: 503 });
  }
}
