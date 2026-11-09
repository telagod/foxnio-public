import { createHash } from "crypto";
import { basename } from "path";
import {
  audit,
  createApproval,
  createTicket,
  getAutonomy,
  listApprovals,
  type ChiefAutonomy,
} from "./chief-store";

/**
 * The action broker for FOX-initiated dispatches. It runs in the server's
 * agent-tool path before an action executes; approved actions re-enter the
 * same tools later. OMP's session operations stay the only execution path.
 */
export type FoxActionTool = "new_session" | "send_to_session";

export interface FoxActionRequest {
  toolName: FoxActionTool;
  args: Record<string, unknown>;
  sourceSessionId: string;
  sourceCwd: string;
  projectRef: string;
}

export interface FoxActionDecision {
  allowed: boolean;
  message?: string;
  ticketId?: string;
  approvalId?: string;
  autonomy: ChiefAutonomy;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function foxActionTask(toolName: FoxActionTool, args: Record<string, unknown>): string {
  return oneLine(
    toolName === "new_session"
      ? text(args.prompt) || text(args.name)
      : text(args.message),
    500,
  ) || "FOX dispatch";
}

function oneLine(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function actionKey(toolName: FoxActionTool, args: Record<string, unknown>): string {
  return createHash("sha1").update(JSON.stringify([toolName, args])).digest("hex");
}

export function evaluateFoxAction(request: FoxActionRequest): FoxActionDecision {
  const autonomy = getAutonomy(request.projectRef);
  const projectName = basename(request.projectRef.replace(/\\/g, "/")) || request.projectRef;
  const title = foxActionTask(request.toolName, request.args);
  const detail = `${request.toolName} → ${request.projectRef}: ${title}`;

  if (autonomy === "observe") {
    audit("action-denied", `${detail} (observe)`);
    return {
      allowed: false,
      autonomy,
      message: `FOX is in observe mode for ${projectName}; this action was not queued. Raise the project's autonomy in FOX → Chief before dispatching.`,
    };
  }

  if (autonomy === "auto") {
    audit("action-allowed", `${detail} (auto)`);
    return { allowed: true, autonomy };
  }

  // Suggest and approve both require a human decision. The trigger id makes a
  // model retry return the same ticket/approval instead of creating duplicates.
  const triggerId = `dispatch:${actionKey(request.toolName, request.args)}`;
  const ticket = createTicket({
    projectRef: request.projectRef,
    projectName,
    title,
    triggerId,
    state: "waiting_human",
    mandate: {
      kind: "explicit",
      requestedBy: request.sourceSessionId,
      scope: request.projectRef,
      policyVersion: "1",
    },
  });

  const pending = listApprovals("pending", 100).find((approval) => approval.ticketId === ticket.id);
  if (pending) {
    return {
      allowed: false,
      autonomy,
      ticketId: ticket.id,
      approvalId: pending.id,
      message: `Already waiting for approval (${pending.id}). Do not repeat the action; the user can approve it in FOX → Chief.`,
    };
  }

  const approval = createApproval({
    ticketId: ticket.id,
    projectRef: request.projectRef,
    projectName,
    title,
    action: {
      toolName: request.toolName,
      args: request.args,
      sourceSessionId: request.sourceSessionId,
      sourceCwd: request.sourceCwd,
    },
    evidence: `Source session ${request.sourceSessionId}; ${request.toolName} requested by FOX.`,
  });
  audit("action-queued", `${detail} (${approval.id})`);
  return {
    allowed: false,
    autonomy,
    ticketId: ticket.id,
    approvalId: approval.id,
    message: `Approval required before FOX can ${request.toolName === "new_session" ? "spawn a worker" : "send to a worker"} for ${projectName}. Queued as ${approval.id}; approve it in FOX → Chief. Do not repeat the action.`,
  };
}
