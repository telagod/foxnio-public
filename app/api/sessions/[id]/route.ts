import { NextResponse } from "next/server";
import { statSync } from "node:fs";
import { mutateSession, SessionMutationError } from "@/lib/omp/session-mutation";
import {
  resolveParentSessionId,
  listAllSessions,
  invalidateSessionPathCache,
  invalidateSessionCaches,
  getSessionDisplay,
  getSessionLoadError,
  readSessionHeader,
  SessionFileTooLargeError,
  SessionHistoryWorkerError,
} from "@/lib/session-reader";
import { resolveSessionPathOr404 } from "@/lib/api-utils";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { clearExitedRpcSession, getRpcSession, isWebRpcError } from "@/lib/rpc-manager";

/** Stable, client-safe error body for catch-all handlers: details go to the
 *  server log only, never to the browser. */
function sessionsErrorResponse(error: unknown): NextResponse {
  if (error instanceof SessionMutationError || isWebRpcError(error) && error.code === "session_busy") {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 409 });
  }
  if (error instanceof SessionHistoryWorkerError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: 503 });
  }
  if (error instanceof SessionFileTooLargeError) {
    return NextResponse.json(
      { error: "Session file is too large to open in foxnio", code: "session_file_too_large" },
      { status: 413 },
    );
  }
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "Request body is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  console.error("[api/sessions]", error);
  return NextResponse.json({ error: "Session request failed", code: "session_request_failed" }, { status: 500 });
}


export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;

    const searchParams = new URL(req.url).searchParams;
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const includeState = searchParams.has("includeState");

    // Header reads stay bounded; materialization and tree/context projection
    // run in the history worker, including the malformed-header path.
    const header = readSessionHeader(filePath);
    if (header === null) {
      // Distinguish "missing/too large" from "malformed": the header read is
      // bounded; a malformed file yields null exactly like a missing one.
      if (await getSessionLoadError(filePath) === "too_large") {
        return NextResponse.json(
          { error: "Session file is too large to open in foxnio", code: "session_file_too_large" },
          { status: 413 },
        );
      }
      return NextResponse.json({ error: "Session file is missing or malformed", code: "session_file_malformed" }, { status: 404 });
    }
    const { leafId, tree, context } = await getSessionDisplay(filePath, { deferThinking, deferToolResultImages });

    let modified = header.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header.parentSession
      ? await resolveParentSessionId(header.parentSession)
      : undefined;
    const info = {
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: header.title,
      created: header.timestamp,
      modified,
      messageCount: context.messages.length,
      firstMessage: context.messages.find((m) => m.role === "user")
        ? (() => {
            const msg = context.messages.find((m) => m.role === "user")!;
            const c = (msg as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
    };

    // ?includeState=1 inlines the wrapper's live agent state (same shape as
    // GET /api/agent/[id]) so the client's post-turn refresh is one request
    // instead of two. On a get_state failure the field is omitted entirely —
    // callers treat a missing `agent` as "fetch it separately".
    let agent: { running: boolean; state?: unknown } | undefined;
    if (includeState) {
      const rpc = getRpcSession(id);
      if (rpc?.isAlive()) {
        try {
          agent = { running: true, state: await rpc.send({ type: "get_state" }) };
        } catch {
          // Leave agent unset; the session payload is still valid without it.
        }
      } else {
        agent = { running: false };
      }
    }

    return NextResponse.json({
      sessionId: id,
      filePath,
      info,
      leafId,
      tree,
      context,
      ...(agent ? { agent } : {}),
    });
  } catch (error) {
    return sessionsErrorResponse(error);
  }
}

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { name } = await parseJsonWithinLimit<{ name?: string }>(req, 64 * 1024);
    if (typeof name !== "string" || !name.trim()) {
      return NextResponse.json({ error: "name is required", code: "session_name_required" }, { status: 400 });
    }
    // A running omp process owns its session file; route the rename through it
    // so the in-memory title cannot clobber ours on the next flush. This runs
    // before the path check because omp does not create the session file until
    // the history holds an assistant message.
    const rpc = getRpcSession(id);
    if (rpc?.isAlive?.()) {
      // A failed native rename must never fall back to an unowned file write.
      await rpc.send({ type: "set_session_name", name: name.trim() });
    } else {
      const resolved = await resolveSessionPathOr404(id);
      if ("response" in resolved) return resolved.response;
      const header = readSessionHeader(resolved.filePath);
      await mutateSession({ action: "rename", sessionId: header?.id ?? id, filePath: resolved.filePath, name: name.trim() });
      invalidateSessionCaches(resolved.filePath);
      return NextResponse.json({ ok: true });
    }
    invalidateSessionCaches();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return sessionsErrorResponse(error);
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;

    const header = readSessionHeader(filePath);
    // Match archive semantics before stopping a live parent. The native
    // maintenance process repeats this check under the ownership lease.
    if ((await listAllSessions()).some((session) => session.parentSessionId === (header?.id ?? id))) {
      return NextResponse.json({ error: "Remove or archive child sessions first", code: "session_has_children" }, { status: 409 });
    }

    // Await the child's exit before unlinking: omp flushes session state on
    // shutdown and would recreate the file if it were still running.
    await getRpcSession(id)?.destroyAndWait?.();
    await mutateSession({ action: "delete", sessionId: header?.id ?? id, filePath });
    clearExitedRpcSession(id);
    invalidateSessionPathCache(id);
    invalidateSessionCaches(); // deletion drops the file: full flush is correct
    return NextResponse.json({ ok: true });
  } catch (error) {
    return sessionsErrorResponse(error);
  }
}
