import { NextResponse } from "next/server";
import { readSessionHeader } from "@/lib/session-reader";
import { apiErrorResponse, resolveSessionPathOr404 } from "@/lib/api-utils";
import { startRpcSession, getRpcSession, resolveSpawnCwdResult, isWebRpcError, webRpcErrorStatus, WebRpcError } from "@/lib/rpc-manager";
import { isRecord } from "@/lib/type-guards";
import { RpcCommandError } from "@/lib/omp/rpc-process";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { MAX_AGENT_COMMAND_REQUEST_BYTES } from "@/lib/image-attachments";
import { parseAdvisorChoice } from "@/lib/advisor-default";
import { isFoxToolPolicy, isFoxWorkspacePath } from "@/lib/fox";

// Commands that ride whatever child is alive and never spawn or replace one:
// keystroke predictions, and the side-question reads/cancel omp-web sends in
// the background (SSE connect, reconcile). Without a live process there is no
// ghost text, no running side question and nothing to cancel, so the reply is
// known without omp. Asking (`btw`) and opening the history start omp first.
const NO_SPAWN_REPLIES: Record<string, unknown> = {
  predict_word: { suffix: null },
  predict_word_feedback: null,
  get_btw_history: { records: [] },
  btw_cancel: { cancelled: false },
  claim_host_tool: { token: null },
  host_tool_result: null,
};

// Live diagnostics of a skill-resolving omp. A saved or exited session has none,
// and resuming a full child (MCP, LSP) just to answer a read-only inspection or
// flip one setting is not what the click asked for: with no live wrapper these
// answer 409 instead of starting omp, and a live idle child is never replaced
// because the advisor flag differs.
const LIVE_SESSION_ONLY = new Set(["get_skill_diagnostics", "set_skill_startup_diagnostics"]);

/** omp-web's own failures carry a stable code the client can localize; omp's
 * errors stay opaque English text. */
function commandErrorResponse(error: unknown) {
  if (error instanceof RequestBodyTooLargeError) {
    return NextResponse.json({ error: "Agent command is too large", code: "request_too_large" }, { status: 413 });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  if (isWebRpcError(error)) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: webRpcErrorStatus(error) });
  }
  if (error instanceof RpcCommandError) {
    return NextResponse.json({ error: error.message, code: error.code ?? "rpc_command_failed" }, { status: 400 });
  }
  return apiErrorResponse(error);
}

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await parseJsonWithinLimit<unknown>(req, MAX_AGENT_COMMAND_REQUEST_BYTES);
    if (!isRecord(body)) {
      return NextResponse.json({ error: "Request body must be a JSON object", code: "invalid_request" }, { status: 400 });
    }
    if (typeof body.type !== "string" || !body.type.trim()) {
      return NextResponse.json({ error: "command type is required", code: "command_type_required" }, { status: 400 });
    }

    // The chat's advisor choice (`on` / `off`; absent = no explicit choice)
    // rides on the query string, never the RPC body, which is forwarded to omp
    // verbatim. It matters when this request spawns the session's omp process
    // or reaches an idle live one whose advisor differs.
    const advisor = parseAdvisorChoice(new URL(req.url).searchParams.get("advisor"));

    // Fast path: already-running session. An idle child takes the choice in
    // place through omp's `/advisor on|off`; busy children keep running and
    // get it with a later request. Only an omp without that command needs a
    // respawn, and only to turn the advisor on (the --advisor flag).
    const existing = getRpcSession(id);
    // FOX is a coordinator and must not keep a legacy full-tool child: a live
    // child bypasses startRpcSession's tool override, and its system prompt is
    // already loaded. Replace it before the next command, even when the old
    // child is still finishing a direct project edit.
    const foxPolicyMismatch = existing?.isAlive()
      && isFoxWorkspacePath(existing.cwd)
      && !isFoxToolPolicy(existing.toolNames);
    const noSpawn = Object.hasOwn(NO_SPAWN_REPLIES, body.type);
    const liveOnly = LIVE_SESSION_ONLY.has(body.type);
    if (existing?.isAlive() && !foxPolicyMismatch) {
      const reuse = noSpawn || liveOnly || existing.isRunning() || existing.isEditingHistory()
        || await existing.applyAdvisorChoice(advisor)
        // `off` has no spawn flag, so a respawn could not apply it either.
        || advisor !== "on";
      if (reuse) {
        if (getRpcSession(id) !== existing) throw new WebRpcError("The requested conversation changed before the command was sent", "session_busy");
        const result = await existing.send(body);
        return NextResponse.json({ success: true, data: result });
      }
      await existing.destroyAndWait();
    } else if (existing?.isAlive()) {
      await existing.destroyAndWait("fox-tool-policy");
    }
    if (noSpawn) return NextResponse.json({ success: true, data: NO_SPAWN_REPLIES[body.type] });
    if (liveOnly) {
      return NextResponse.json(
        { error: "Skill diagnostics require a running session", code: "skill_diagnostics_unavailable" },
        { status: 409 },
      );
    }

    const resolved = await resolveSessionPathOr404(id);
    if ("response" in resolved) return resolved.response;
    const filePath = resolved.filePath;

    const header = readSessionHeader(filePath);
    const { cwd } = resolveSpawnCwdResult(header?.cwd);

    // A cold set_model must reach omp before the saved model is restored:
    // spawning with only --resume lets omp exit on an unrestorable saved
    // model before the RPC below ever runs (#277). Binding the requested
    // model at spawn time skips that restore check. Live children never
    // reach this path (they take the fast path above), and any other command
    // keeps the previous spawn behavior.
    const spawnModel =
      body.type === "set_model" &&
      typeof body.provider === "string" &&
      typeof body.modelId === "string" &&
      body.provider.trim() &&
      body.modelId.trim() &&
      !body.provider.startsWith("-") &&
      !body.modelId.startsWith("-") &&
      !/\s/.test(body.provider) &&
      !/\s/.test(body.modelId)
        ? `${body.provider}/${body.modelId}`
        : undefined;

    const { session } = await startRpcSession(id, filePath, cwd, undefined, advisor, header?.cwd, undefined, spawnModel);
    if (getRpcSession(id) !== session) throw new WebRpcError("The requested conversation changed while it was starting", "session_busy");
    if (spawnModel) {
      // Try the normal RPC first: when it succeeds it also records the new
      // model in the session, so later spawns restore it without an override.
      // But in omp 18.12.6 set_model can fail spuriously with "Model not
      // found" for a catalog model whose provider has no credentials
      // configured, even though the spawn already bound it. In that case the
      // switch itself succeeded — verify from live state and report success
      // rather than a false failure. A mismatch (e.g. an omp without --model
      // precedence) rethrows the RPC error, so a real failure still surfaces.
      try {
        const result = await session.send(body);
        return NextResponse.json({ success: true, data: result });
      } catch (error) {
        const state = (await session.send({ type: "get_state" })) as {
          model?: { id?: unknown; provider?: unknown };
        } | null;
        if (state?.model?.provider === body.provider && state?.model?.id === body.modelId) {
          return NextResponse.json({ success: true, data: { id: body.modelId, provider: body.provider } });
        }
        throw error;
      }
    }
    const result = await session.send(body);

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    return commandErrorResponse(error);
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }
    try {
      const state = await session.send({ type: "get_state" });
      return NextResponse.json({ running: true, state, toolPreset: session.toolPreset });
    } catch (error) {
      if (isWebRpcError(error) && error.code === "session_unresponsive") {
        return NextResponse.json({ running: false, recovered: true });
      }
      throw error;
    }
  } catch (error) {
    return commandErrorResponse(error);
  }
}
