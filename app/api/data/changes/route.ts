import { storageRequest } from "@/lib/storage/client";
import { DATA_HEADERS, dataErrorResponse, parseDataQuery } from "../http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const query = parseDataQuery(new URL(request.url), "changes");
    const result = await storageRequest({ operation: "changes", ...query });
    return Response.json(result, { headers: DATA_HEADERS });
  } catch (error) { return dataErrorResponse(error); }
}
