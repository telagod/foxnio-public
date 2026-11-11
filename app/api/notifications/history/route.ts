import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { clearHistory, listHistory, markHistoryRead, removeHistory } from "@/lib/notification-history-store";
import { apiErrorResponse } from "@/lib/api-utils";
import { isRecord } from "@/lib/type-guards";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_IDS = 100;
const MAX_ID_LENGTH = 256;

const invalid = () => NextResponse.json({ error: "Invalid history request", code: "invalid_history_request" }, { status: 400 });
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;

/** GET /api/notifications/history — every entry, newest first. */
export async function GET() {
  try {
    return NextResponse.json({ entries: await listHistory() });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/** PATCH /api/notifications/history { ids } — mark entries read. A client marks what it shows, never entries it has not seen. */
export async function PATCH(req: Request) {
  let body: unknown;
  try {
    body = await parseJsonWithinLimit<unknown>(req, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return NextResponse.json({ error: "History request is too large", code: "request_too_large" }, { status: 413 });
    return invalid();
  }
  if (!isRecord(body) || !Array.isArray(body.ids) || body.ids.length > MAX_IDS || !body.ids.every(isId)) return invalid();
  try {
    await markHistoryRead(body.ids);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * DELETE /api/notifications/history?id=<id> removes one entry; ?all=1 clears the history.
 * Never a body: proxies may drop one, and a lost id must not become "clear everything".
 */
export async function DELETE(req: Request) {
  const params = new URL(req.url).searchParams;
  const id = params.get("id");
  try {
    if (isId(id)) await removeHistory(id);
    else if (id === null && params.get("all") === "1") await clearHistory();
    else return invalid();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
