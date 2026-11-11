// Runs only inside the installed OMP process; Node never imports the OMP SDK.
import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { archiveSessionFileWithArtifacts, deleteSessionFileWithArtifacts, listSessionFiles, readSessionHeaderSync, setSessionTitle } from "./session-files.ts";
import { getSessionsDir } from "./paths.ts";
import { sessionPathKey } from "../paths.ts";

export const SESSION_MUTATION_COMMAND = "omp-web-session-mutation";
export const SESSION_MUTATION_REPLY = "omp-web-session-mutation:";

function failure(message, code) {
  return Object.assign(new Error(message), { code });
}

export async function mutateNativeSession(native, request) {
  if (!request || typeof request.sessionId !== "string" || typeof request.filePath !== "string"
    || !["rename", "delete", "archive"].includes(request.action)) throw failure("Invalid session mutation", "invalid_session_mutation");
  if (request.action === "rename" && (typeof request.name !== "string" || !request.name.trim())) throw failure("A session name is required", "session_name_required");
  if (typeof native?.tryAcquireSessionLease !== "function") throw failure("This OMP version cannot safely mutate offline sessions; update OMP first", "session_ownership_unavailable");
  const file = realpathSync(request.filePath);
  const root = realpathSync(getSessionsDir());
  const path = relative(root, file);
  if (!path || path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path) || !file.endsWith(".jsonl")) throw failure("Session is outside the active session directory", "invalid_session_path");
  const lease = native.tryAcquireSessionLease(request.sessionId);
  if (!lease) throw failure("Another OMP process owns this session; stop it before changing the session", "session_busy");
  try {
    const header = readSessionHeaderSync(file);
    if (header?.id !== request.sessionId) throw failure("The session changed before the operation", "session_changed");
    if (request.action === "rename") {
      if (!setSessionTitle(file, request.name, request.source === "auto" ? "auto" : "user")) throw failure("The session title could not be saved", "session_rename_failed");
      return { ok: true };
    }
    // Parent lineage is ownership, not just sidebar grouping. Never orphan or
    // silently transfer workers, including children in other project folders.
    for (const candidate of await listSessionFiles(root)) {
      const child = readSessionHeaderSync(candidate);
      let parentFile;
      try { if (child?.parentSession) parentFile = realpathSync(child.parentSession); } catch { /* Bare ids are compared below. */ }
      if (child?.parentSession && (child.parentSession === header.id || parentFile && sessionPathKey(parentFile) === sessionPathKey(file))) {
        throw failure("Remove or archive child sessions first", "session_has_children");
      }
    }
    if (request.action === "archive") return { ok: true, archivedPath: archiveSessionFileWithArtifacts(file, { sessionsRoot: root }) };
    deleteSessionFileWithArtifacts(file);
    return { ok: true };
  } finally {
    lease.release();
  }
}

export default function registerSessionMutation(api) {
  api.registerCommand(SESSION_MUTATION_COMMAND, {
    description: "Perform an offline session mutation under native ownership",
    handler: async (args, ctx) => {
      let request;
      try {
        request = JSON.parse(args);
        if (typeof request.requestId !== "string") return;
        const result = await mutateNativeSession(api.pi, request);
        ctx.ui.notify(SESSION_MUTATION_REPLY + JSON.stringify({ requestId: request.requestId, result }), "info");
      } catch (error) {
        if (typeof request?.requestId !== "string") return;
        ctx.ui.notify(SESSION_MUTATION_REPLY + JSON.stringify({ requestId: request.requestId, error: error instanceof Error ? error.message : String(error), code: error?.code ?? "session_mutation_failed" }), "info");
      }
    },
  });
}
