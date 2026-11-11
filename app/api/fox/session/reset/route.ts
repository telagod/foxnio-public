import { NextResponse } from "next/server";
import { clearFoxSessionId, readFoxSessionRecord } from "@/lib/fox-session";
import { isRecord } from "@/lib/type-guards";
import { controlFoxGoal } from "@/lib/fox-goal-service";
import { apiErrorResponse } from "@/lib/api-utils";
import { StorageError } from "@/lib/storage/protocol";

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
    const current = await readFoxSessionRecord();
    if (expected.sessionId !== current.sessionId || expected.resetAt !== current.resetAt) {
      return NextResponse.json({ error: "FOX changed conversations before reset", code: "fox_session_superseded" }, { status: 409 });
    }
    await controlFoxGoal("reset");
    const record = await clearFoxSessionId(undefined, current);
    return NextResponse.json({ sessionId: null, resetAt: record.resetAt });
  } catch (error) {
    if (error instanceof StorageError) {
      if (error.code === "storage_conflict") return NextResponse.json({ error: "FOX changed conversations during reset", code: "fox_session_superseded" }, { status: 409 });
      return apiErrorResponse(error);
    }
    return NextResponse.json({ error: "Could not reset the FOX conversation", code: "fox_session_reset_failed" }, { status: 503 });
  }
}
