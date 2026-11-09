import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { comparableProjectPath } from "../comparable-path.ts";
import { FOX_PERSONA } from "../fox-workspace.ts";
import { FOX_TOOL_NAMES, FOX_OPTIONAL_TOOL_NAMES } from "../fox.ts";
import { FOX_DISPATCH_RECEIPT_PREFIX, foxActionFingerprint } from "./fox-dispatch-guard.mjs";
import { FOX_REPORT_COMMAND } from "./fox-reports.mjs";

export const FOX_NATIVE_CONFIRM_TITLE = "FOX · Confirm dispatch";
const ALLOWED_TOOLS = new Set([...FOX_TOOL_NAMES, ...FOX_OPTIONAL_TOOL_NAMES, "ast_grep", "tool_search", "think", "list_sessions", "new_session", "send_to_session"]);

export function readFoxNativePolicy(foxCwd, projectCwd) {
  let config;
  try {
    config = JSON.parse(readFileSync(join(foxCwd, "service.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return "confirm";
    throw new Error("FOX dispatch policy could not be read. No action was executed.");
  }
  const policy = config?.dispatchPolicies?.[comparableProjectPath(realpathSync(projectCwd))];
  if (policy === undefined) return "confirm";
  if (["observe", "confirm", "auto"].includes(policy)) return policy;
  throw new Error("Invalid FOX dispatch policy. No action was executed.");
}

export async function guardFoxDispatch(event, ctx, proactive, readPolicy = readFoxNativePolicy) {
  if (!ALLOWED_TOOLS.has(event.toolName)) {
    return { block: true, reason: "FOX coordinates work using native plans, read-only context, memory and project workers. This tool is outside the coordinator's scope." };
  }
  if (proactive && event.toolName === "ask") {
    return { block: true, reason: "This is an automatic observation turn. Report the question for the user instead of opening a blocking dialog." };
  }
  if (event.toolName !== "new_session" && event.toolName !== "send_to_session") return;
  if (proactive) return { block: true, reason: "This is an automatic observation turn. Report the situation; do not dispatch work or ask for permission." };
  try {
    const input = event.input;
    if (!input || typeof input.cwd !== "string" || !isAbsolute(input.cwd) || !statSync(input.cwd).isDirectory()) {
      return { block: true, reason: "FOX dispatches require the exact project cwd. For a follow-up, use the worker's cwd and sessionId from list_sessions." };
    }
    const policy = readPolicy(ctx.cwd, input.cwd);
    if (policy === "observe") return { block: true, reason: "This project is observation-only. No work was dispatched." };
    const action = { sessionId: ctx.sessionManager.getSessionId(), toolCallId: event.toolCallId, toolName: event.toolName, input, projectKey: comparableProjectPath(realpathSync(input.cwd)) };
    const fingerprint = foxActionFingerprint(action);
    if (policy !== "auto") {
      if (!ctx.hasUI) return { block: true, reason: "A native confirmation surface is required. No work was dispatched." };
      const details = [
        `Project: ${input.cwd}`,
        ...(action.projectKey !== comparableProjectPath(input.cwd) ? [`Resolved project: ${action.projectKey}`] : []),
        ...(typeof input.sessionId === "string" ? [`Worker: ${input.sessionId}`] : []),
        ...(typeof input.model === "string" ? [`Model: ${input.model}`] : []),
        ...(typeof input.provider === "string" && typeof input.modelId === "string" ? [`Model: ${input.provider}/${input.modelId}`] : []),
        ...(typeof input.delivery === "string" ? [`Delivery: ${input.delivery}`] : []),
        "",
        typeof input.prompt === "string" ? input.prompt : typeof input.message === "string" ? input.message : "Create an idle project worker.",
      ].join("\n");
      if (await ctx.ui.confirm(FOX_NATIVE_CONFIRM_TITLE, details) !== true) {
        return { block: true, reason: "The user did not approve this action. Do not retry it unless they ask." };
      }
    }
    ctx.ui.notify(FOX_DISPATCH_RECEIPT_PREFIX + JSON.stringify({
      sessionId: action.sessionId,
      toolCallId: action.toolCallId,
      toolName: action.toolName,
      projectKey: action.projectKey,
      fingerprint,
      confirmation: policy === "auto" ? "automatic" : "confirmed",
    }), "info");
  } catch (error) {
    return { block: true, reason: error instanceof Error ? error.message : String(error) };
  }
}

export default function registerFoxNative(pi) {
  let proactive = true;
  pi.on("session_start", () => { proactive = true; });
  pi.on("session_switch", () => { proactive = true; });
  pi.on("before_agent_start", (event) => {
    if (event.reason !== "revive") proactive = event.prompt.startsWith("[FOX proactive check")
      || event.prompt.startsWith("[FOX worker report") || event.prompt.startsWith("[From session ")
      || event.prompt.startsWith(`/${FOX_REPORT_COMMAND}`);
    return { systemPrompt: [...event.systemPrompt, FOX_PERSONA] };
  });
  pi.on("tool_call", (event, ctx) => guardFoxDispatch(event, ctx, proactive));
}
