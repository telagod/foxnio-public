import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { RpcProcess } from "./rpc-process";

const COMMAND = "omp-web-session-mutation";
const REPLY = "omp-web-session-mutation:";
const TIMEOUT_MS = 60_000;

export class SessionMutationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "SessionMutationError";
  }
}

export interface SessionMutation {
  action: "rename" | "delete" | "archive";
  sessionId: string;
  filePath: string;
  name?: string;
  source?: "auto" | "user";
}

/** Execute inside OMP so the native lease covers the entire read/write operation. */
export async function mutateSession(request: SessionMutation): Promise<{ ok: boolean; archivedPath?: string }> {
  const proc = new RpcProcess({
    cwd: process.cwd(),
    extraArgs: ["--no-session", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-tools", "--no-title", "--extension", join(process.cwd(), "lib", "omp", "session-mutation-extension.mjs")],
  });
  const requestId = randomUUID();
  const reply = Promise.withResolvers<{ ok: boolean; archivedPath?: string }>();
  void reply.promise.catch(() => {});
  const timeout = setTimeout(() => reply.reject(new SessionMutationError("OMP did not confirm the session operation; refresh before retrying", "session_mutation_timeout")), TIMEOUT_MS);
  const detach = proc.onFrame((frame) => {
    if (frame.type === "agent_start") {
      reply.reject(new SessionMutationError("The maintenance command unexpectedly started an agent", "session_mutation_failed"));
      void proc.dispose();
    }
    if (frame.type !== "extension_ui_request" || frame.method !== "notify" || typeof frame.message !== "string" || !frame.message.startsWith(REPLY)) return;
    let value;
    try { value = JSON.parse(frame.message.slice(REPLY.length)); } catch { return; }
    if (value.requestId !== requestId) return;
    if (typeof value.error === "string") reply.reject(new SessionMutationError(value.error, typeof value.code === "string" ? value.code : "session_mutation_failed"));
    else if (value.result?.ok === true) reply.resolve(value.result);
    else reply.reject(new SessionMutationError("Invalid native session mutation receipt", "session_mutation_failed"));
  });
  try {
    const ready = await proc.waitReady(TIMEOUT_MS);
    await proc.negotiateProtocol(ready);
    const catalog = await proc.sendCommand<{ commands?: { name: string; source: string }[] }>({ type: "get_available_commands" });
    if (!catalog.commands?.some((command) => command.name === COMMAND && command.source === "extension")) throw new SessionMutationError("Native session ownership support is unavailable; update OMP before changing offline sessions", "session_ownership_unavailable");
    await proc.sendCommand({ type: "prompt", message: `/${COMMAND} ${JSON.stringify({ ...request, requestId })}` }, TIMEOUT_MS);
    return await reply.promise;
  } finally {
    clearTimeout(timeout);
    detach();
    await proc.dispose();
  }
}
