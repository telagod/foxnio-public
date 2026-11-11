import { storageRequest } from "@/lib/storage/client";
import { ensureSessionIndex } from "@/lib/session-index";
import { DATA_HEADERS, dataErrorResponse, parseDataQuery } from "../http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only the first open waits for the once-per-process initial index, never a page. */
export async function GET(request: Request): Promise<Response> {
  let token: string | undefined;
  let aborted = request.signal.aborted;
  const close = () => { if (token) void storageRequest({ operation: "snapshot.close", token }).catch(() => {}); };
  const onAbort = () => { aborted = true; close(); };
  request.signal.addEventListener("abort", onAbort, { once: true });
  try {
    ({ token } = parseDataQuery(new URL(request.url), "snapshot"));
    if (aborted) throw new Error("Snapshot request aborted");
    if (!token) await ensureSessionIndex();
    if (aborted) throw new Error("Snapshot request aborted");
    if (token) {
      const page = await storageRequest({ operation: "snapshot.page", token });
      if (aborted || !page.next) await storageRequest({ operation: "snapshot.close", token });
      return Response.json(page, { headers: DATA_HEADERS });
    }
    const opened = await storageRequest({ operation: "snapshot.open" });
    token = opened.token;
    if (aborted || !opened.next) await storageRequest({ operation: "snapshot.close", token });
    return Response.json(opened, { headers: DATA_HEADERS });
  } catch (error) {
    close();
    return dataErrorResponse(error);
  } finally {
    request.signal.removeEventListener("abort", onAbort);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const { token } = parseDataQuery(new URL(request.url), "snapshot");
    if (!token) return Response.json({ code: "invalid_request", error: "Snapshot token required" }, { status: 400, headers: DATA_HEADERS });
    await storageRequest({ operation: "snapshot.close", token });
    return Response.json({ ok: true }, { headers: DATA_HEADERS });
  } catch (error) { return dataErrorResponse(error); }
}
