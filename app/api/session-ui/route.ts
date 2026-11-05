import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { isValidSessionId } from "@/lib/session-file-references-core";
import { loadSessionUiState, MAX_PINNED_SESSIONS, updateSessionPins } from "@/lib/session-ui-state";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

// A full request carries two lists of at most MAX_PINNED_SESSIONS 36-character ids.
const MAX_BODY_BYTES = 32 * 1024;

const invalid = () => NextResponse.json({ error: "Invalid session-ui request", code: "invalid_session_ui_request" }, { status: 400 });

/** An absent field is an empty list; a present one must be a bounded list of valid session ids. */
function parseIdList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_PINNED_SESSIONS) return null;
  const ids: string[] = [];
  for (const id of value) {
    if (typeof id !== "string" || !isValidSessionId(id)) return null;
    ids.push(id);
  }
  return ids;
}

/** GET /api/session-ui -> { pinned: [{ id, at }] }, newest pin first. */
export async function GET() {
  try {
    return NextResponse.json(loadSessionUiState());
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** PATCH /api/session-ui { pin?: string[], unpin?: string[] } -> the updated state. */
export async function PATCH(req: Request) {
  let body: unknown;
  try {
    body = await parseJsonWithinLimit<unknown>(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Session-ui request is too large", code: "request_too_large" }, { status: 413 });
    }
    return invalid();
  }
  if (!isRecord(body) || (body.pin === undefined && body.unpin === undefined)) return invalid();
  const pin = parseIdList(body.pin);
  const unpin = parseIdList(body.unpin);
  if (!pin || !unpin) return invalid();
  try {
    return NextResponse.json(updateSessionPins({ pin, unpin }));
  } catch (error) {
    return apiErrorResponse(error);
  }
}
