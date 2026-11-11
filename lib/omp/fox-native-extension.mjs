import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { comparableProjectPath } from "../comparable-path.ts";
import { FOX_PERSONA } from "../fox-workspace.ts";
import { FOX_TOOL_NAMES, FOX_OPTIONAL_TOOL_NAMES } from "../fox.ts";
import { FOX_DISPATCH_RECEIPT_PREFIX, foxActionFingerprint } from "./fox-dispatch-guard.mjs";
import { FOX_REPORT_COMMAND } from "./fox-reports.mjs";
import { FOX_GOAL_TOOL, assertFoxGoalComplete, assertFoxGoalGrant } from "./fox-goals.mjs";
import { foxGoalRuntime, readFoxNativePolicy } from "./fox-goal-extension.mjs";

export const FOX_NATIVE_CONFIRM_TITLE = "FOX · Confirm dispatch";
const ALLOWED_TOOLS = new Set([...FOX_TOOL_NAMES, ...FOX_OPTIONAL_TOOL_NAMES, FOX_GOAL_TOOL, "goal", "ast_grep", "tool_search", "think", "list_sessions", "new_session", "send_to_session"]);


export async function guardFoxDispatch(event, ctx, proactive, readPolicy = readFoxNativePolicy) {
  if (!ALLOWED_TOOLS.has(event.toolName)) {
    return { block: true, reason: "FOX coordinates work using native plans, read-only context, memory and project workers. This tool is outside the coordinator's scope." };
  }
  if (event.toolName === FOX_GOAL_TOOL) {
    return foxGoalRuntime() ? undefined : { block: true, reason: "The native goal extension is unavailable; no metadata action was authorized." };
  }
  if (event.toolName === "goal") {
    if (event.input?.op === "get") return;
    if (event.input?.op !== "complete") return { block: true, reason: "Native goal lifecycle changes are host-only. Authorize scope through fox_goal, and use the user's goal controls." };
    try {
      const runtime = foxGoalRuntime();
      if (!runtime) throw new Error("Native goal evidence gate is unavailable");
      assertFoxGoalComplete(await runtime.snapshot(ctx));
      return;
    } catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
  }
  if (proactive && event.toolName === "ask") {
    try {
      const runtime = foxGoalRuntime();
      if (runtime) { assertFoxGoalGrant(await runtime.snapshot(ctx)); return; }
    } catch { /* Observation-only or unavailable authority keeps the legacy ask gate closed. */ }
    return { block: true, reason: "This is an automatic observation turn. Report the question for the user instead of opening a blocking dialog." };
  }
  if (event.toolName !== "new_session" && event.toolName !== "send_to_session") return;
  try {
    const runtime = foxGoalRuntime();
    if (runtime && await runtime.admit(event, ctx, readPolicy)) return;
    if (event.input?.coordination) return { block: true, reason: "The native goal extension is unavailable; goal dispatch cannot fall back to per-call permission." };
  } catch (error) { return { block: true, reason: error instanceof Error ? error.message : String(error) }; }
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
