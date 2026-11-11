import { StorageError, type DataCursor } from "@/lib/storage/protocol";

class DataQueryError extends Error {}
function parseCursor(raw: string | null): DataCursor {
  let value: unknown;
  try { value = JSON.parse(raw ?? "null"); } catch { throw new DataQueryError("Invalid data cursor"); }
  if (!value || typeof value !== "object" || !("generation" in value) || !("revision" in value)
    || typeof value.generation !== "string" || !value.generation || value.generation.length > 256
    || typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0) throw new DataQueryError("Invalid data cursor");
  return { generation: value.generation, revision: value.revision };
}
export function parseDataQuery(url: URL, kind: "snapshot"): { token?: string };
export function parseDataQuery(url: URL, kind: "changes"): { cursor: DataCursor; through?: DataCursor };
export function parseDataQuery(url: URL, kind: "snapshot" | "changes"): { token?: string } | { cursor: DataCursor; through?: DataCursor } {
  const allowed = kind === "snapshot" ? ["token"] : ["cursor", "through"];
  for (const key of url.searchParams.keys()) if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new DataQueryError("Invalid data query");
  if (kind === "changes") {
    const cursor = parseCursor(url.searchParams.get("cursor"));
    return { cursor, ...(url.searchParams.has("through") ? { through: parseCursor(url.searchParams.get("through")) } : {}) };
  }
  if (!url.searchParams.has("token")) return {};
  const token = url.searchParams.get("token");
  if (!token || token.length > 256 || !/^[a-zA-Z0-9_-]+$/.test(token)) throw new DataQueryError("Invalid snapshot token");
  return { token };
}
export function dataErrorResponse(error: unknown): Response {
  const code = error instanceof StorageError ? error.code : error instanceof DataQueryError ? "invalid_request" : "storage_unavailable";
  const status = code === "invalid_request" ? 400 : code === "reset_required" ? 409 : 503;
  return Response.json({ code, error: error instanceof Error ? error.message : "Durable storage unavailable" }, { status, headers: { "Cache-Control": "no-store", ...(status === 503 ? { "Retry-After": "1" } : {}) } });
}
export const DATA_HEADERS = { "Cache-Control": "no-store" };
