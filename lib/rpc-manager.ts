import { randomUUID } from "crypto";
import { existsSync, realpathSync, statSync, mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { validateAgentImages } from "./image-attachments";
import { hasVisibleAssistantContent } from "./assistant-response";
import { invalidateModelsCache } from "./models-cache";
import { RpcCommandError, RpcCommandTimeoutError, RpcProcess, type RpcFrame } from "./omp/rpc-process";
import { readNativeSettings } from "./omp/settings-config";
import { getAgentEnvOverrides } from "./omp/agent-env";
import { editSessionHistory, isSessionEditReply, SESSION_EDIT_COMMAND, SESSION_EDIT_EXTENSION_PATH, SessionEditAgentInvocationError, type SessionEditResult } from "./omp/session-edit";
import {
  cacheSessionPath,
  invalidateSessionEntriesCache,
  invalidateSessionListCache,
  listAllSessions,
  readSessionHeader,
  resolveSessionPath,
} from "./session-reader";
import { allowFileRoot } from "./file-access";
import { loadWebServerSettings } from "./web-settings";
import {
  AGENT_TOOL_DEFINITIONS,
  AGENT_TOOL_NAMES,
  AgentToolGuard,
  executeAgentTool,
  type AgentToolDeliverInput,
  type AgentToolDeliverResult,
  type AgentToolSessionOps,
} from "./agent-tools";
import { markShuttingDown, recordRunningSessions, RESUME_PROMPT, takeInterruptedSessions } from "./session-resume";
import { getToolPresetStatus, PRESET_FULL, type ToolPresetStatus } from "./tool-presets";
import { effectiveToolNamesForCwd, isFoxToolPolicy, isFoxWorkspacePath } from "./fox";
import { FoxDispatchReceipts } from "./omp/fox-dispatch-guard.mjs";
import { foxDispatchPolicy, foxDispatchProjectKey, initializeFoxNativePolicy } from "./fox-service-config";
import { acceptFoxReport, configureFoxReportDelivery, foxWorkerParent, recoverFoxWorkerReports, wakeFoxReportDelivery } from "./fox-report-store";
import type { FoxWorkerReport } from "./fox-report-types";
import { deliverNativeFoxReport, FoxReportAgentInvocationError, isFoxReportReply } from "./omp/fox-report-delivery";
import { FOX_REPORT_COMMAND, FOX_REPORT_EVENT_PREFIX, FOX_REPORT_READY_PREFIX, FOX_REPORT_TOOL, FOX_REPORT_TOOL_DEFINITION, parseFoxReport } from "./omp/fox-reports.mjs";
import { comparableProjectPath } from "./comparable-path";
import { compareAndSetFoxSessionId, readFoxSessionRecord } from "./fox-session";
import { nativeSessionLineage, sameNativeConversation } from "./omp/session-lineage";
import { samePath } from "./paths";
import { isRecord } from "./type-guards";
import { BLOCKING_UI_METHODS, createNotificationDetector } from "./notification-events";
import { publishNotification, settleNotificationInputs } from "./notification-hub";
import { parseSkillDiagnosticsSnapshot, type SkillDiagnosticsSnapshot } from "./skill-diagnostics";
import { isReservedLaunchArg, loadProjectRegistry } from "./project-registry";
import { eventWithToolResultImageUrls } from "./media-cache";
import type {
  BashResultInfo,
  OmpModel,
  RpcAvailableSlashCommand,
  RpcSessionState,
  SessionStatsInfo,
  WebSessionState,
} from "./pi-types";
import type { AgentMessage, CrossSessionHostToolCall, ExitedRpcSession, ExtensionWidgetItem, ProjectLaunchConfig } from "./types";
import type { SessionLiveSnapshot, SessionLiveToolEvent, SessionStreamCursor } from "./session-sync";
import type { AdvisorChoice } from "./advisor-default";
import type { FoxGoalSnapshot, FoxGoalCoordination, NativeGoal, NativeGoalModeState } from "./fox-goal-types";
import { FOX_GOAL_TOOL, FOX_GOAL_TOOL_DEFINITION, FOX_GOAL_COMMAND, FOX_GOAL_REPLY_PREFIX, FOX_GOAL_EVENT_PREFIX, parseFoxGoalCoordination, validateFoxGoalDispatch } from "./omp/fox-goals.mjs";
import { readFoxGoalJournal } from "./fox-goal-journal";

interface FoxHostAdmission {
  coordination: FoxGoalCoordination;
  admissionId: string;
  projectKey: string;
  input: Record<string, unknown>;
  toolName: string;
  sessionId: string;
  toolCallId: string;
  effectStarted?: boolean;
}

// ============================================================================
// Types
// ============================================================================

export interface AgentEvent {
  type: string;
  web: SessionStreamCursor;
  [key: string]: unknown;
}

type EventListener = (event: AgentEvent) => void;
type UnsequencedAgentEvent = { type: string; [key: string]: unknown };

interface CompactionResultLike {
  summary?: string;
  tokensBefore?: number;
  estimatedTokensAfter?: number;
  /** omp ≥17.4 reports the real post-compaction count when available. */
  tokensAfter?: number;
}

const IDLE_DESTROY_MS = 10 * 60 * 1000;
const FOX_NATIVE_EXTENSION_PATH = join(process.cwd(), "lib", "omp", "fox-native-extension.mjs");
const FOX_REPORT_EXTENSION_PATH = join(process.cwd(), "lib", "omp", "fox-report-extension.mjs");
const FOX_GOAL_EXTENSION_PATH = join(process.cwd(), "lib", "omp", "fox-goal-extension.mjs");

function foxGoalOverlay(enabled: boolean): { args: string[]; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), "foxnio-goal-"));
  const file = join(directory, "config.yml");
  writeFileSync(file, `goal:\n  continuationModes: ${enabled ? "[rpc]" : "[]"}\n`, { mode: 0o600 });
  return { args: ["--config", file], cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
/**
 * How long a session may sit with **no web UI attached** before its omp child is
 * torn down. IDLE_DESTROY_MS (10min) is the backstop for a session that keeps
 * receiving traffic; this is the much faster path for "the user closed the tab
 * and walked away", so abandoned children don't hold a slot for 10 minutes.
 *
 * The floor is set by the *client*, not the server: when an SSE stream dies the
 * browser retries with capped backoff (`EVENT_STREAM_RETRY_MAX_MS` = 30s in
 * `hooks/useAgentSession-stream.ts`), and a backgrounded tab clamps its timers
 * to ~1/min. A window anywhere near 60s therefore races the reconnect and turns
 * a returning tab into a 409 "Session is not managed by omp-web" plus a cold
 * respawn. 120s keeps ~2x the retry ceiling and still reclaims 5x faster than
 * the idle backstop. Set `OMP_WEB_DISCONNECT_DESTROY_MS=0` to disable reaping
 * and fall back to IDLE_DESTROY_MS alone.
 */
const DISCONNECT_DESTROY_MS = process.env.OMP_WEB_DISCONNECT_DESTROY_MS !== undefined
  ? Math.max(0, Number(process.env.OMP_WEB_DISCONNECT_DESTROY_MS) || 0)
  : 120_000;
const READY_TIMEOUT_MS = 120_000;
const MCP_LIST_TIMEOUT_MS = 15_000;
const GET_STATE_TIMEOUT_MS = 5_000;
/** Cap on the *acknowledgement* of a prompt frame — not on model execution.
 * omp acks a prompt as soon as it accepts it and the run then reports through
 * events (agent_start/agent_end), so an ack that never arrives means the child
 * is wedged: without this the API request (and the UI spinner behind it) would
 * stay pending forever. Generous enough to cover slow local startup work the
 * child does before acking. */
const PROMPT_ACK_TIMEOUT_MS = 30_000;
/** Title generation is an LLM call on omp's side. */
const GENERATE_TITLE_TIMEOUT_MS = 60_000;
const RENAME_POLL_INTERVAL_MS = 500;
const RENAME_POLL_TIMEOUT_MS = 20_000;
/** Background title requests per session. omp declines low-signal openers
 * (a bare greeting), so a later turn of the same session retries. */
const AUTO_TITLE_MAX_ATTEMPTS = 3;
/** command_output lines printed by omp's argument-less `/rename`. */
const RENAME_OUTPUT_RE = /^(Session renamed to |Could not generate a session title|Session name not changed|Rename failed:)/;
/** command_output lines printed by omp's `/advisor on|off`. */
const ADVISOR_OUTPUT_RE = /^(Advisor (?:enabled|disabled)\.|Advisor setting enabled, but no model)/;
const NON_TERMINAL_CONTINUATION_GRACE_MS = 2_000;
const AWAITING_AGENT_START_TIMEOUT_MS = 10_000;
const RESTARTING_MESSAGE = "This session is restarting — retry in a moment.";
const BASH_EXCLUDE_MESSAGE =
  "omp cannot run a shell command with its output excluded from the model context (`!!`): the RPC bash command has no exclusion option, so the output would silently enter the context anyway. Run it with a single `!` to share the output with the model, or use a terminal outside foxnio.";

/**
 * Failure raised by omp-web itself (not by omp) carrying a stable snake_case
 * code. API routes forward `{ error, code }` so the client dictionary can
 * localize it via `errors.<code>` while unknown codes fall back to the text.
 */
export class WebRpcError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "WebRpcError";
    this.code = code;
  }
}

/** HTTP status for a WebRpcError: transient states the client may retry get 409 / 504, everything else is a bad request. */
const WEB_RPC_ERROR_STATUS: Record<string, number> = {
  session_busy: 409,
  session_restarting: 409,
  session_changed: 409,
  session_cwd_unavailable: 409,
  mcp_list_loading: 409,
  session_unresponsive: 504,
  session_state_timeout: 504,
  mcp_list_timeout: 504,
};

export function webRpcErrorStatus(error: WebRpcError): number {
  return WEB_RPC_ERROR_STATUS[error.code] ?? 400;
}

/** Name-based, so a route still recognizes an error thrown by another copy of this module (separate bundler layers, test loaders). */
export function isWebRpcError(error: unknown): error is WebRpcError {
  return error instanceof WebRpcError || (error instanceof Error && error.name === "WebRpcError");
}

/** Entries of a set_host_tools / set_host_uri_schemes payload. A missing list is an empty registration; anything else must be a list of objects. */
function hostRegistrationEntries(value: unknown, field: string): Array<Record<string, unknown>> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new WebRpcError(`${field} must be an array of objects`, "invalid_request");
  }
  return value;
}

/** Shape check for an ask-dialog `answers` payload; omp validates the content. */
function isAskAnswers(value: unknown): boolean {
  return Array.isArray(value) && value.every((answer: unknown) =>
    isRecord(answer)
    && typeof answer.id === "string"
    && Array.isArray(answer.selectedOptions)
    && answer.selectedOptions.every((option: unknown) => typeof option === "string")
    && (answer.customInput === undefined || typeof answer.customInput === "string"));
}

// Commands forwarded to omp verbatim (request shape already matches rpc-types).
const PASSTHROUGH_COMMANDS = new Set([
  "abort",
  "abort_and_prompt",
  "set_thinking_level",
  "cycle_thinking_level",
  "cycle_model",
  "get_available_models",
  "set_auto_compaction",
  "set_auto_retry",
  "abort_retry",
  "abort_bash",
  "set_todos",
  "set_steering_mode",
  "set_follow_up_mode",
  "set_interrupt_mode",
  "get_branch_messages",
  "get_messages",
  "get_messages_page",
  "export_html",
  "handoff",
  "get_subagents",
  "get_subagent_messages",
  "set_subagent_subscription",
  "get_login_providers",
  "login",
  "predict_word",
  "predict_word_feedback",
  "btw",
  "btw_cancel",
  "get_btw_history",
]);

// Outlasts omp's cold prediction-daemon start (up to 3 × 30s start rounds plus a
// 30s first completion), so omp's answer or error decides; a wedged daemon still
// cannot pin the request forever.
const PREDICT_WORD_TIMEOUT_MS = 125_000;

// Commands that can carry user-attached images to the model. All of them must
// pass the same server-side per-image/count/aggregate validation before the
// payload reaches omp — a client is free to POST any of them directly.
const IMAGE_BEARING_COMMANDS = new Set(["prompt", "steer", "follow_up", "abort_and_prompt"]);

// These commands can append to, replace, or resume the active history. Edits
// fence them across every attached client, including mutations already awaiting
// a native acknowledgement when an edit arrives. Read-only queries and dialog
// replies remain available while a navigation hook is running.
const HISTORY_MUTATING_COMMANDS = new Set([
  "edit_message", "prompt", "steer", "follow_up", "abort", "abort_and_prompt",
  "abort_and_restore_queue", "remove_queued_message", "promote_queued_message",
  "fork", "new_session", "switch_session", "compact", "abort_compaction",
  "reload", "bash", "abort_bash", "handoff", "set_todos", "set_session_name",
  "set_model", "cycle_model", "set_thinking_level", "cycle_thinking_level",
  "set_fast_mode", "set_slow_mode", "set_auto_compaction", "set_auto_retry", "abort_retry",
]);

// pi-web commands with no omp RPC equivalent. The UI tolerates these failing.
const UNSUPPORTED_COMMANDS: Record<string, string> = {
  navigate_tree: "Branch navigation is not supported over the omp RPC protocol",
  clear_queue: "Recalling queued messages is not supported over the omp RPC protocol",
  get_tools: "Per-session tool listing is not supported over the omp RPC protocol",
  set_tools: "Changing tools on a running session is not supported over the omp RPC protocol; tool presets apply to new sessions",
  extension_ui_input: "Extension custom UI is not supported over the omp RPC protocol",
};

// omp aliases "find"->"glob" and has no "ls" tool; the web UI presets still use
// the pi names (lib/tool-presets.ts), so translate before building --tools.
const TOOL_NAME_ALIASES: Record<string, string> = { find: "glob", search: "grep" };
const DROPPED_TOOL_NAMES = new Set(["ls"]);

/** Translate pi-web preset tool names into omp builtin tool names. */
export function mapPresetToolNames(toolNames: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of toolNames) {
    const lower = raw.toLowerCase();
    if (DROPPED_TOOL_NAMES.has(lower)) continue;
    const mapped = TOOL_NAME_ALIASES[lower] ?? lower;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

const FULL_PRESET_KEY = [...PRESET_FULL].map((n) => n.toLowerCase()).sort().join(",");

/** Extra CLI args for spawning `omp --mode rpc-ui` for a session. */
export function buildSessionSpawnArgs(sessionFile: string, toolNames?: readonly string[], advisor = false, launchConfig?: ProjectLaunchConfig, modelOverride?: string, reapplyToolPresetOnResume = false): string[] {
  const args: string[] = [];
  if (sessionFile) {
    // An absolute path (or anything containing "/") resolves deterministically:
    // omp's createSessionManager opens it directly via SessionManager.open
    // without any interactive resume/fork prompts (main.ts resume handling).
    args.push("--resume", sessionFile);
    // An explicitly chosen model replaces the saved model and skips its
    // restore check (omp's --model at startup). Without this, resuming a
    // session whose saved model can no longer be restored dies before any
    // set_model RPC can run (#277). Args are passed as an argv array, never
    // through a shell, so only whitespace / flag-smuggled values are kept out.
    if (modelOverride && !modelOverride.startsWith("-") && !/\s/.test(modelOverride)) {
      args.push("--model", modelOverride);
    }
  }
  if (toolNames !== undefined && (!sessionFile || reapplyToolPresetOnResume)) {
    const presetKey = toolNames.map((n) => n.toLowerCase()).sort().join(",");
    if (toolNames.length === 0) {
      args.push("--no-tools");
    } else if (presetKey !== FULL_PRESET_KEY) {
      const mapped = mapPresetToolNames(toolNames);
      if (mapped.length > 0) args.push("--tools", mapped.join(","));
    }
  }
  if (advisor) args.push("--advisor");
  else if (launchConfig?.advisor) args.push("--advisor");
  // Defense in depth: the registry is hand-editable, so re-strip reserved
  // args and dash-leading profiles at the spawn boundary even though the
  // API validates them on write.
  if (launchConfig?.profile && !launchConfig.profile.startsWith("-")) args.push("--profile", launchConfig.profile);
  if (launchConfig?.extraArgs) args.push(...launchConfig.extraArgs.filter((arg) => !isReservedLaunchArg(arg)));
  return args;
}

function toImageContents(value: unknown): Array<{ type: "image"; data: string; mimeType: string }> | undefined {
  const images = value as Array<{ type: "image"; data: string; mimeType: string }> | undefined;
  return images?.length ? images : undefined;
}

/** A resumed conversation must never execute in a substituted workspace. */
export function resolveSpawnCwdResult(recordedCwd?: string | null): { cwd: string } {
  try {
    if (recordedCwd && statSync(recordedCwd).isDirectory()) return { cwd: recordedCwd };
  } catch { /* Missing or inaccessible is not permission to choose another cwd. */ }
  throw new WebRpcError("This session's working directory is unavailable. Restore the original directory or start a new session in the intended workspace; history remains readable.", "session_cwd_unavailable");
}

/** omp's CompactionResult historically omitted any post-compaction token
 * count; approximate it from the summary so the compaction banner can show
 * savings instead of "→ 0 tokens". Newer omp reports a real `tokensAfter` —
 * prefer it when present. */
function patchEstimatedTokensAfter(result: unknown): void {
  if (!result || typeof result !== "object") return;
  const compaction = result as CompactionResultLike;
  if (compaction.estimatedTokensAfter === undefined) {
    // Prefer omp ≥17.4's real post-compaction count; fall back to the
    // summary-length estimate for older builds.
    const rawTokensAfter = typeof compaction.tokensAfter === "number"
      ? Math.max(0, compaction.tokensAfter)
      : (compaction.summary?.length ?? 0) / 4;
    compaction.estimatedTokensAfter = Math.round(rawTokensAfter);
  }
}

// ============================================================================
// AgentSessionWrapper
// Wraps one spawned `omp --mode rpc-ui` process with the interface the rest of
// the app expects (same command surface pi-web's in-process wrapper offered).
// ============================================================================

function titleFromResult(result: unknown): string | null {
  const value = typeof result === "string" ? result : isRecord(result) ? (result.title ?? result.name ?? result.sessionName) : null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

interface IdentityChangeOptions {
  /** The old id still names this wrapper (session moved files, not switched). */
  keepOldId?: boolean;
}

export class AgentSessionWrapper {
  private listeners: EventListener[] = [];
  private foxDispatchReceipts = new FoxDispatchReceipts();
  private foxReportingAvailable = false;
  private foxGoalAvailable = false;
  private foxGoalAdmissionClosed = false;
  private foxGoalControlVersion = 0;
  private foxGoalDurableControlVersion = 0;
  private foxGoalContinuation = false;
  private foxGoalActivationPending = false;
  private foxGoalActivation: Promise<boolean> | null = null;
  private foxGoalInternalCommands = 0;
  private foxGoalExclusive = false;
  private foxGoalEffects: Promise<unknown> = Promise.resolve();
  private foxMetadataQueue: Promise<unknown> = Promise.resolve();
  private foxGoalEvents = new Map<string, { sessionId: string; op: string; snapshot: FoxGoalSnapshot; consentEntryId?: string; hostControlVersion: number }>();
  private foxGoalWaiters = new Set<(error: Error) => void>();
  private nativeGoalState: NativeGoalModeState | null = null;
  readonly createdAt = Date.now();
  private unpersistedFoxWorkerId: string | null = null;
  private foxReportCalls = new Map<string, Promise<FoxWorkerReport>>();
  private foxReportInbox: Promise<void> | null = null;
  private hostToolClaims = new Map<string, { token: string; timer: NodeJS.Timeout }>();
  private pendingUiRequests = new Map<string, UnsequencedAgentEvent>();
  private uiExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private extensionStatuses = new Map<string, string>();
  private extensionWidgets = new Map<string, ExtensionWidgetItem>();
  private promptRunning = false;
  private promptDispatchPendingCount = 0;
  private historyMutationPendingCount = 0;
  private historyEditInFlight = false;
  private sessionTransitionInFlight = false;
  private awaitingAgentStart = false;
  private awaitingAgentStartDeadline = 0;
  private continuationGraceUntil = 0;
  private bashRunning = false;
  private streaming = false;
  private compacting = false;
  private streamId = randomUUID();
  private streamSequence = 0;
  private streamingMessage: Partial<AgentMessage> | null = null;
  private liveToolEvents = new Map<string, SessionLiveToolEvent>();
  /** Positive evidence for this run, retained after native completion but before disk append. */
  private responseObserved = false;
  private responseRunActive = false;
  /** Last failed run's message; cleared when the next run starts or succeeds. */
  private lastRunError: string | null = null;
  private fastModeEnabled = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Lazily-armed deadline for tearing down a session nobody is watching. */
  private reapTimer: ReturnType<typeof setTimeout> | null = null;
  private reapDeadline = 0;
  private lastActivityAt = 0;
  /** In-flight `send()` calls: the reaper must never dispose the child out from
   * under a command that is still awaiting its response. */
  private pendingCommands = 0;
  /** The start handshake (ready + protocol negotiation + get_state) is in flight. */
  private handshaking = false;
  private readonly disconnectDestroyMs: number;
  private onDestroyCallback: (() => void) | null = null;
  private onIdentityChangeCallback: ((oldId: string, newId: string, options?: IdentityChangeOptions) => void | Promise<void>) | null = null;
  private identityPersistence: Promise<void> = Promise.resolve();
  private identityPersistenceError: Error | null = null;
  /** omp reported a `session-persistence` notice: its next identity change is
   * the same conversation moving to a sibling file, not a session switch. */
  private sessionMovePending = false;
  private unsubscribeFrames: (() => void) | null = null;
  private readonly detectNotification = createNotificationDetector();
  /** Agent activity since the last `session_settled`: background work may still run after the turn ended. */
  private unsettled = false;
  /** Ids this conversation had before omp moved it to a new file. */
  private readonly movedFromIds: string[] = [];
  private initPromise: Promise<void> | null = null;
  private restarting = false;
  private mcpListWaiter: { resolve: (text: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Synchronous mutex for getMcpList: checked+set before any await, so two
   *  concurrent callers can never both enter (the waiter/promptRunning
   *  bookkeeping alone is not an atomic gate). */
  private mcpListInFlight = false;
  private _alive = true;
  /** Host tools the web UI registered via set_host_tools (agent-callable). */
  private hostToolNames: Set<string> = new Set();
  /** The last set_host_tools registration (UI tools + server agent tools), re-sent after a restart. */
  private hostToolDefinitions: object[] = [];
  /** host_tool_call ids awaiting a host_tool_result from the browser. */
  private pendingHostTools: Map<string, UnsequencedAgentEvent> = new Map();
  /** URI schemes the web UI registered via set_host_uri_schemes. */
  private hostUriSchemes: Map<string, { writable?: boolean }> = new Map();
  /** The last set_host_uri_schemes registration, re-sent after a restart. */
  private hostUriDefinitions: Array<Record<string, unknown>> = [];
  /** host_uri_request ids awaiting a host_uri_result from the browser. */
  private pendingHostUris: Map<string, UnsequencedAgentEvent> = new Map();
  /** Settle functions of outstanding waitForTurnEnd calls; destroy rejects them. */
  private turnWaiters: Set<(error: Error | null) => void> = new Set();
  /** Resolves once an in-flight destroyAndWait finishes; null when idle. Read
   * by startRpcSession so a replacement spawn awaits the old child's exit. */
  destroyPromise: Promise<void> | null = null;
  private _sessionId = "";
  private _sessionFile = "";
  private _sessionName: string | undefined;
  private proc: RpcProcess;
  /** Process whose exit is expected because reload is deliberately disposing it. */
  private expectedExitProc: RpcProcess | null = null;
  readonly cwd: string;
  /** The chat's explicit advisor choice this child reflects: `on` when it was
   * spawned with --advisor for the chat (or `/advisor on` was applied), `off`
   * after `/advisor off`, `inherit` when the chat never chose (the child then
   * follows omp's config and the workspace launch flag). Restarts reuse it. */
  private _advisorChoice: AdvisorChoice;
  /** OMP builtin tool preset used by the currently running child. */
  private _toolPreset: ToolPresetStatus | null;
  /** Original requested tool names; null means a resumed session's preset is unknown. */
  private readonly _toolNames: readonly string[] | null | undefined;
  /** Original workspace for validating cold resumes before the handshake. */
  private readonly recordedCwd: string | null;

  // Plain field assignments (not TS parameter properties) keep this module
  // runnable under Node's strip-only TypeScript mode for probes/tests.
  constructor(
    proc: RpcProcess,
    cwd: string,
    recordedCwd?: string | null,
    advisorChoice: AdvisorChoice = "inherit",
    expectedSessionId = "",
    /** Test seam: the real value is DISCONNECT_DESTROY_MS (120s), far too long
     *  for a unit test. 0 disables reaping for that wrapper. */
    disconnectDestroyMs: number = DISCONNECT_DESTROY_MS,
    toolPreset: ToolPresetStatus | null = "full",
    toolNames: readonly string[] | null | undefined = undefined,
  ) {
    this.proc = proc;
    this.cwd = cwd;
    this.recordedCwd = recordedCwd ?? null;
    this._advisorChoice = advisorChoice;
    this._toolPreset = toolPreset;
    this._toolNames = toolNames === null ? null : toolNames ? [...toolNames] : undefined;
    this._sessionId = expectedSessionId;
    this.disconnectDestroyMs = disconnectDestroyMs;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get sessionFile(): string {
    return this._sessionFile;
  }
  get toolPreset(): ToolPresetStatus | null {
    return this._toolPreset;
  }
  get toolNames(): readonly string[] | null | undefined {
    return this._toolNames;
  }

  isAlive(): boolean {
    return this._alive && this.proc.isAlive;
  }

  /** Process replacement retains exclusive ownership of this conversation. */
  isRestarting(): boolean { return this.restarting; }

  isRunning(): boolean {
    // A human/host response can outlive the current streaming turn. Reaping it
    // closes stdin and OMP records "Request was aborted", even without a Stop.
    return this.isAlive() && (this.promptRunning || this.streaming || this.compacting || this.bashRunning
      || this.pendingUiRequests.size > 0 || this.pendingHostTools.size > 0 || this.pendingHostUris.size > 0);
  }

  /** Local history navigation is busy control work, not an interruptible model turn. */
  isEditingHistory(): boolean {
    return this.historyEditInFlight || this.sessionTransitionInFlight || Boolean(this.foxReportInbox);
  }

  /** Number of UI requests waiting for a human answer. Read-only; no state. */
  pendingHumanRequests(): number {
    return this.pendingUiRequests.size;
  }

  /** The first pending dialog's title/message/question, for the FOX brief. */
  pendingHumanRequestDetail(): string | null {
    for (const request of this.pendingUiRequests.values()) {
      const title = typeof request.title === "string" ? request.title.trim() : "";
      const message = typeof request.message === "string" ? request.message.trim() : "";
      const instructions = typeof request.instructions === "string" ? request.instructions.trim() : "";
      const first = Array.isArray(request.questions) && isRecord(request.questions[0])
        ? request.questions[0]
        : null;
      const header = first && typeof first.header === "string" ? first.header.trim() : "";
      const question = first && typeof first.question === "string" ? first.question.trim() : "";
      const text = [title || header, message || question || instructions].filter(Boolean).join(" — ");
      if (text) return text.length > 240 ? `${text.slice(0, 239)}…` : text;
    }
    return null;
  }

  /** Last failed run's message, or null after a successful/new run. Read-only. */
  lastRunErrorMessage(): string | null {
    return this.lastRunError;
  }

  /** A web UI (SSE stream) is currently attached to this session. */
  hasSubscribers(): boolean {
    return this.listeners.length > 0;
  }

  /**
   * Any real use of the session: an attached UI, a command from an API route, or
   * a frame from the child. `resetIdleTimer()` is the single choke point for all
   * three (start(), handleFrame(), send()), so driving reaping from here means
   * the deadline can never drift away from what the session is actually doing.
   *
   * Deliberately does NOT touch a timer: only the *deadline* moves, and
   * `armReap` keeps at most one timer alive, so a 100fps token stream costs a
   * timestamp write instead of clearTimeout/setTimeout churn.
   */
  private noteActivity(): void {
    this.lastActivityAt = Date.now();
    this.reapDeadline = this.lastActivityAt + this.disconnectDestroyMs;
    this.armReap();
  }

  private armReap(): void {
    if (this.reapTimer || this.disconnectDestroyMs <= 0) return;
    if (this.hasSubscribers() || !this.isAlive()) return;
    this.reapTimer = setTimeout(() => {
      this.reapTimer = null;
      this.reapIfDisconnected();
    }, Math.max(0, this.reapDeadline - Date.now()));
    // Never pin the event loop for a cleanup deadline (cf. the MCP waiter and
    // lib/session-resume.ts): an unref'd reap must not delay process exit.
    this.reapTimer.unref?.();
  }

  /**
   * Tear the child down only when nobody can observe the loss. Every condition
   * here is a hard invariant, not a heuristic:
   *  - a subscriber means an open HTTP 200 stream that `destroy()` would leave
   *    half-open (the route holds its own detach + heartbeat), so the run would
   *    vanish silently and the tab would only notice via a later 409;
   *  - isRunning() covers an in-flight turn that no listener is watching;
   *  - handshaking covers a spawn that has not finished its startup handshake;
   *  - pendingCommands covers a route command (predict_word, mcp list, export)
   *    whose response the child still owes us;
   *  - the deadline check absorbs activity that landed while this fired.
   * Anything else keeps the session and re-arms for the remaining window.
   */
  private reapIfDisconnected(): void {
    if (!this.isAlive() || this.hasSubscribers() || this.isRunning()
      || this.handshaking || this.pendingCommands > 0) {
      // A paused human dialog produces no frames. Do not spin a zero-delay
      // timer once the old deadline has passed while protected work remains.
      this.reapDeadline = Math.max(this.reapDeadline, Date.now() + this.disconnectDestroyMs);
      this.armReap();
      return;
    }
    if (Date.now() < this.reapDeadline) {
      this.reapDeadline = this.lastActivityAt + this.disconnectDestroyMs;
      this.armReap();
      return;
    }
    console.info("[omp-web] automatic-session-cleanup", JSON.stringify({ sessionId: this._sessionId, reason: "disconnected-idle", at: new Date().toISOString() }));
    this.destroy("disconnected-idle");
  }

  /** NDJSON messages are fresh snapshots; copy containers, not token payloads. */
  getStreamSnapshot(): SessionLiveSnapshot {
    return {
      cursor: { streamId: this.streamId, sequence: this.streamSequence },
      isStreaming: this.streaming,
      isPromptRunning: this.promptRunning,
      isCompacting: this.compacting,
      responseObserved: this.responseObserved,
      streamingMessage: this.streamingMessage ? { ...this.streamingMessage } : null,
      toolEvents: Array.from(this.liveToolEvents.values(), (event) => ({ ...event })),
    };
  }

  private clearLiveSnapshots(): void {
    this.streamingMessage = null;
    this.liveToolEvents.clear();
    this.streamSequence += 1;
  }

  private resetStream(): void {
    this.clearLiveSnapshots();
    this.responseObserved = false;
    this.responseRunActive = false;
    this.streamId = randomUUID();
    this.streamSequence = 0;
  }

  start(): void {
    this.unsubscribeFrames = this.proc.onFrame((frame) => this.handleFrame(frame));
    this.resetIdleTimer();
    notifyRunningChange();
  }

  /** Resolves once the child announced readiness and identity is known. */
  waitUntilReady(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.initialize();
    return this.initPromise;
  }

  private async initialize(): Promise<void> {
    // READY_TIMEOUT_MS and the reap window are the same order of magnitude, so
    // the handshake itself counts as in-flight work: a child that is slow to
    // announce itself must be torn down by its own startup timeout (which
    // reports a real error), never by the reaper.
    this.handshaking = true;
    try {
      if (this.recordedCwd) resolveSpawnCwdResult(this.recordedCwd);
      const ready = await this.proc.waitReady(READY_TIMEOUT_MS);
      await this.proc.negotiateProtocol(ready);
      // Subscribe to subagent lifecycle/progress/event frames so the UI can show
      // a live subagent roster. Older omp builds may not know the command —
      // degrade silently (the UI falls back to no subagent info).
      await this.proc.sendCommand({ type: "set_subagent_subscription", level: "events" }).catch(() => {});
      // Opt into omp's all-questions ask dialog; older omp rejects the command
      // and keeps the per-question select/editor fallback.
      // Bounded like get_state so a child that never answers cannot stall startup.
      await this.proc.sendCommand({ type: "set_ask_dialog", enabled: true }, GET_STATE_TIMEOUT_MS).catch(() => {});
      const state = await this.getStateWithTimeout();
      // omp >= 18.13.2 resumes the newest copy of a conversation that went on in
      // another file (header `continuationOf`), so a resumed child can report
      // another session than the file it was given. Same conversation: keep the
      // requested id as an alias, as for a move.
      if (this._sessionId && state.sessionId !== this._sessionId) this.sessionMovePending = true;
      this.applyIdentity(state);
      const catalog = await this.proc.sendCommand<{ commands?: RpcAvailableSlashCommand[] }>({ type: "get_available_commands" }, GET_STATE_TIMEOUT_MS).catch(() => null);
      this.foxReportingAvailable ||= Boolean(Array.isArray(catalog?.commands) && catalog.commands.some((command) => command.name === FOX_REPORT_COMMAND && command.source === "extension"));
      this.foxGoalAvailable = Boolean(catalog?.commands?.some((command) => command.name === FOX_GOAL_COMMAND && command.source === "extension"));
    } finally {
      this.handshaking = false;
      // The handshake is real activity, so the reap clock restarts from here
      // rather than from spawn (a slow start must not eat the whole window).
      this.noteActivity();
    }
  }

  private applyIdentity(state: RpcSessionState): void {
    const oldId = this._sessionId;
    const identityChanged = Boolean(oldId) && (state.sessionId !== oldId || (state.sessionFile && state.sessionFile !== this._sessionFile));
    // omp >= 18.5 moves a session it does not own onto a new file on its first
    // write (`session-persistence` notice). The conversation continues, so the
    // live stream and run state must survive; only the id changes.
    const moved = identityChanged && this.sessionMovePending;
    if (identityChanged && !moved && this._sessionFile) {
      for (const reject of this.foxGoalWaiters) reject(new Error("Native goal conversation identity changed"));
      this.foxGoalEvents.clear();
      this.foxDispatchReceipts.clear();
      this.foxGoalAdmissionClosed = true;
      this.foxGoalActivationPending = false;
      this.nativeGoalState = null;
    }
    if (identityChanged && !moved) {
      this.resetStream();
      this.promptRunning = false;
      this.awaitingAgentStart = false;
      this.awaitingAgentStartDeadline = 0;
      this.continuationGraceUntil = 0;
      // A different conversation now: the old one's ids must not suppress its notifications.
      this.movedFromIds.length = 0;
    }
    this._sessionId = state.sessionId;
    this._sessionFile = state.sessionFile ?? "";
    this._sessionName = state.sessionName;
    this.streaming = state.isStreaming;
    this.compacting = state.isCompacting;
    this.fastModeEnabled = state.fastModeEnabled ?? state.fastMode ?? this.fastModeEnabled;
    if (this._sessionFile) cacheSessionPath(this._sessionId, this._sessionFile);
    if (moved) {
      this.sessionMovePending = false;
      if (oldId !== this._sessionId) {
        // Tabs still showing the old id are still viewing this conversation.
        this.movedFromIds.push(oldId);
        // Keep the old id routable: other tabs still address it, and a fresh
        // `--resume` of the old file would fork again (its owner lives on).
        this.recordIdentityChange(oldId, this._sessionId, { keepOldId: true });
        this.invalidateSessionLists();
      }
    }
  }

  /** Whether omp answered `generate_title` with "Unknown command" (cached per child). */
  private generateTitleUnsupported = false;
  /** Background title requests made per session id (see autoTitle). */
  private autoTitleAttempts = new Map<string, number>();
  private autoTitleInFlight = false;
  /** Until this time, drop the chat output of a background `/rename`. */
  private quietRenameUntil = 0;
  /** Until this time, drop the chat output of an `/advisor on|off` sent for the chat's advisor choice. */
  private quietAdvisorUntil = 0;

  /**
   * Ask omp to generate a title for this session with its own title generator.
   * Prefers the native `generate_title` RPC command and falls back to the
   * argument-less `/rename` slash command. Returns null when omp cannot do
   * either right now (older omp, or the session is mid-run, where `/rename`
   * would be queued as a prompt). With `quiet`, the `/rename` fallback skips
   * the prompt bookkeeping (the UI never sees a run) and its output stays out
   * of the chat.
   */
  async generateTitle({ quiet = false }: { quiet?: boolean } = {}): Promise<string | null> {
    if (this.restarting) throw new WebRpcError(RESTARTING_MESSAGE, "session_restarting");
    if (!this.isAlive()) throw new Error("Session is no longer running");

    if (this.isEditingHistory()) throw new WebRpcError("Wait for the history edit to finish", "session_busy");
    this.historyMutationPendingCount += 1;
    try {
      return await this.generateSessionTitle(quiet);
    } finally {
      this.historyMutationPendingCount -= 1;
    }
  }

  private async generateSessionTitle(quiet = false): Promise<string | null> {
    if (!this.generateTitleUnsupported) {
      try {
        const result = await this.proc.sendCommand<unknown>({ type: "generate_title" }, GENERATE_TITLE_TIMEOUT_MS);
        const title = titleFromResult(result) ?? (await this.readSessionName());
        if (title) this.adoptSessionName(title);
        return title;
      } catch (error) {
        if (!(error instanceof Error && error.message.includes("Unknown command"))) throw error;
        this.generateTitleUnsupported = true;
      }
    }

    // `/rename` without arguments generates a title (omp >= 18.6). It is a
    // prompt, so it must never be sent while a run is in flight.
    if (this.isRunning()) return null;
    const before = (await this.readSessionName()) ?? "";
    if (quiet) {
      // omp saves the title before it prints the result, so the poll below can
      // finish first: the window closes on that output or on expiry instead.
      this.quietRenameUntil = Date.now() + GENERATE_TITLE_TIMEOUT_MS;
      await this.proc.sendCommand({ type: "prompt", message: "/rename" }, PROMPT_ACK_TIMEOUT_MS);
    } else {
      await this.send({ type: "prompt", message: "/rename" });
    }
    const deadline = Date.now() + RENAME_POLL_TIMEOUT_MS;
    let title = await this.readSessionName();
    while (!(title && title !== before) && Date.now() < deadline && this.isAlive()) {
      await new Promise((resolve) => setTimeout(resolve, RENAME_POLL_INTERVAL_MS));
      title = await this.readSessionName();
    }
    if (title) this.adoptSessionName(title);
    return title;
  }

  /**
   * omp does not title sessions on its own in RPC mode
   * (can1357/oh-my-pi#14616), so once a turn finishes, ask its title generator
   * to name an untitled session, as omp's terminal UI does.
   */
  private autoTitle(): void {
    const sessionId = this._sessionId;
    if (!sessionId || this._sessionName || this.autoTitleInFlight) return;
    // omp writes the session file once the history holds an assistant message.
    if (!this._sessionFile || !existsSync(this._sessionFile)) return;
    const attempts = this.autoTitleAttempts.get(sessionId) ?? 0;
    if (attempts >= AUTO_TITLE_MAX_ATTEMPTS) return;
    this.autoTitleAttempts.set(sessionId, attempts + 1);
    this.autoTitleInFlight = true;
    this.generateTitle({ quiet: true })
      .catch((error) => {
        console.warn(`[omp-web] could not title session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.autoTitleInFlight = false;
      });
  }

  private async readSessionName(): Promise<string | null> {
    const state = await this.getStateWithTimeout();
    const name = typeof state.sessionName === "string" ? state.sessionName.trim() : "";
    return name || null;
  }

  private adoptSessionName(title: string): void {
    this._sessionName = title;
    this.invalidateSessionLists();
    notifyRunningChange({ refreshSessionList: true });
  }

  /** Re-read identity after omp reported that it moved this session to a new file. */
  private async followSessionMove(): Promise<void> {
    this.sessionMovePending = true;
    try {
      const state = await this.getStateWithTimeout();
      if (this._alive) this.applyIdentity(state);
    } catch {
      // The next get_state-driven refresh still applies the pending move.
    } finally {
      // A persistence warning that is not a move changes no identity; do not
      // let it mask a later genuine session switch.
      if (this.sessionMovePending && this._alive) this.sessionMovePending = false;
      notifyRunningChange({ refreshSessionList: true });
    }
  }

  handleProcessExit(
    { code, signal, stderrTail }: { code: number | null; signal: NodeJS.Signals | null; stderrTail: string },
    sourceProc: RpcProcess = this.proc,
  ): void {
    if (!this._alive || sourceProc === this.expectedExitProc) return;
    const detail = (stderrTail.trim().split("\n").pop() ?? "").slice(-500);
    const status = signal ? `signal ${signal}` : `code ${code ?? "null"}`;
    // Recorded before destroy(): its running-change broadcast must carry the
    // record so sidebars that missed the notice below still see the exit.
    if (this._sessionId) getExitedMap().set(this._sessionId, { id: this._sessionId, cwd: this.cwd, at: Date.now(), code, signal, detail });
    this.emit({
      type: "notice",
      level: "error",
      message: `The omp process for this session exited unexpectedly (${status})${detail ? `: ${detail}` : "."}`,
    });
    // Terminal agent_end so a client mid-stream stops spinning immediately
    // instead of waiting for the reconcile poll.
    if (this.streaming || this.promptRunning) this.emit({ type: "agent_end", isTerminal: true, messages: [] });
    if (this.streaming || this.promptRunning || this.unsettled) {
      this.publishNotifications({ type: "process_exit", detail: detail || status });
    }
    this.destroy();
  }

  private publishNotifications(frame: Record<string, unknown>): void {
    if (!this._sessionId) return;
    const session = {
      sessionId: this._sessionId,
      sessionName: this._sessionName || this.cwd.split(/[\\/]/).filter(Boolean).pop() || null,
    };
    for (const notification of this.detectNotification(frame, session)) {
      publishNotification(this.movedFromIds.length ? { ...notification, aliases: this.movedFromIds } : notification);
    }
  }

  private handleFrame(frame: RpcFrame): void {
    // The helper has its own process listener. Its correlated control replies
    // must never become browser notices, replayed dialogs, or notifications,
    // even when they arrive after a failed/timed-out edit.
    if (isSessionEditReply(frame) || isFoxReportReply(frame)) return;
    if (isFoxWorkspacePath(this.cwd) && this.foxDispatchReceipts.capture(frame)) return;
    if (frame.type === "extension_ui_request" && frame.method === "notify" && typeof frame.message === "string") {
      if (frame.message.startsWith(FOX_GOAL_REPLY_PREFIX)) return;
      if (frame.message.startsWith(FOX_GOAL_EVENT_PREFIX)) {
        try {
          const value = JSON.parse(frame.message.slice(FOX_GOAL_EVENT_PREFIX.length));
          if (isFoxWorkspacePath(this.cwd) && value.sessionId === this.sessionId && value.op === "pause-required"
            && value.reason === "handoff-uncertain" && typeof value.grantEntryId === "string"
            && typeof value.nativeGoalId === "string" && typeof value.handoffEntryId === "string") {
            void this.pauseFoxGoalHandoff(value.grantEntryId, value.nativeGoalId, value.handoffEntryId)
              .catch((error) => this.emit({ type: "notice", level: "warning", message: `FOX handoff pause failed: ${String(error)}` }));
            return;
          }
          if (isFoxWorkspacePath(this.cwd) && value.sessionId === this.sessionId && value.op === "pause-required"
            && typeof value.grantEntryId === "string" && typeof value.nativeGoalId === "string"
            && ["expired", "dispatch-limit", "rework-limit", "agent-tools-disabled"].includes(value.reason)) {
            void this.pauseFoxGoalResource(value.grantEntryId, value.nativeGoalId, value.reason)
              .catch((error) => this.emit({ type: "notice", level: "warning", message: `FOX resource pause failed: ${String(error)}` }));
            return;
          }
          if (isFoxWorkspacePath(this.cwd) && typeof value.sessionId === "string" && typeof value.toolCallId === "string" && value.snapshot) {
            if (this.foxGoalEvents.size >= 64) this.foxGoalEvents.delete(this.foxGoalEvents.keys().next().value!);
            this.foxGoalEvents.set(value.toolCallId, { ...value, hostControlVersion: this.foxGoalControlVersion });
          }
        } catch {}
        return;
      }
      if (frame.message.startsWith(FOX_REPORT_READY_PREFIX)) {
        this.foxReportingAvailable = true;
        return;
      }
      if (frame.message.startsWith(FOX_REPORT_EVENT_PREFIX)) {
        let report;
        try { report = parseFoxReport(JSON.parse(frame.message.slice(FOX_REPORT_EVENT_PREFIX.length))); } catch { return; }
        if (!report) return;
        const pending = this.captureFoxReport(report as FoxWorkerReport);
        if (report.toolCallId) this.foxReportCalls.set(report.toolCallId, pending);
        void pending.catch((error) => this.emit({ type: "notice", level: "warning", message: `Worker report delivery is pending: ${error instanceof Error ? error.message : String(error)}` }));
        return;
      }
    }
    this.resetIdleTimer();
    const event = frame.type === "available_commands_update" && Array.isArray(frame.commands)
      ? { ...frame, commands: (frame.commands as RpcAvailableSlashCommand[]).filter((command) => command.name !== SESSION_EDIT_COMMAND && command.name !== FOX_REPORT_COMMAND && command.name !== FOX_GOAL_COMMAND) }
      : frame;
    let refreshSessionList = false;

    switch (event.type) {
      case "goal_updated":
        this.nativeGoalState = isRecord(event.state) ? event.state as unknown as NativeGoalModeState : null;
        break;
      case "command_output": {
        // `/mcp list` is a local OMP command. Capture its authoritative text for
        // Settings instead of adding an invisible command to the chat stream.
        const waiter = this.mcpListWaiter;
        if (waiter && typeof event.text === "string") {
          clearTimeout(waiter.timer);
          this.mcpListWaiter = null;
          waiter.resolve(event.text);
          notifyRunningChange();
          return;
        }
        // The output of a background `/rename` (see autoTitle) is not chat content.
        if (Date.now() < this.quietRenameUntil && typeof event.text === "string" && RENAME_OUTPUT_RE.test(event.text)) {
          this.quietRenameUntil = 0;
          return;
        }
        if (Date.now() < this.quietAdvisorUntil && typeof event.text === "string" && ADVISOR_OUTPUT_RE.test(event.text)) {
          this.quietAdvisorUntil = 0;
          return;
        }
        break;
      }
      case "agent_start":
        this.unsettled = true;
        this.promptRunning = true;
        this.streaming = true;
        this.awaitingAgentStart = false;
        this.awaitingAgentStartDeadline = 0;
        this.continuationGraceUntil = 0;
        // The session file can appear just after the prompt acknowledgement.
        // Invalidate and signal the sidebar now rather than waiting for the
        // agent's first reply or terminal event.
        this.invalidateSessionLists();
        refreshSessionList = true;
        // If the file is not on disk yet, the sidebar refresh above may walk
        // the sessions dir before it exists — and the mtime-keyed walk cache
        // then stays stale (NTFS does not bump the sessions-root mtime for
        // files added inside a project subdirectory), hiding the running
        // session from the list until the next invalidation (agent_end).
        // Re-signal once the file actually lands.
        if (this._sessionFile && !existsSync(this._sessionFile)) {
          this.signalWhenSessionFileAppears();
        }
        break;
      case "agent_end":
        if (event.isTerminal !== false) {
          this.streaming = false;
          this.promptRunning = false;
          this.awaitingAgentStart = false;
          this.awaitingAgentStartDeadline = 0;
          this.continuationGraceUntil = 0;
          this.invalidateSessionLists();
          this.autoTitle();
        } else {
          this.continuationGraceUntil = Date.now() + NON_TERMINAL_CONTINUATION_GRACE_MS;
        }
        break;
      case "session_settled":
        this.unsettled = false;
        if (isFoxWorkspacePath(this.cwd)) wakeFoxReportDelivery(this.sessionId);
        if (this.foxGoalActivationPending && !this.foxGoalExclusive && this.foxGoalInternalCommands === 0 && !this.isRunning()) queueMicrotask(() => {
          void this.activateFoxGoal().catch((error) => this.emit({ type: "notice", level: "warning", message: `FOX goal remains paused: ${error instanceof Error ? error.message : String(error)}` }));
        });
        break;
      case "prompt_result":
        if (this.unsettled && this.streaming) return;
        if (this.foxGoalInternalCommands > 0) return;
        // Local-only prompt (builtin/extension slash command) — no agent run.
        this.promptRunning = false;
        this.awaitingAgentStart = false;
        this.awaitingAgentStartDeadline = 0;
        break;
      case "auto_compaction_start":
        this.compacting = true;
        break;
      case "auto_compaction_end":
        this.compacting = false;
        // Same patch the manual `compact` path applies — the client reads
        // event.result.estimatedTokensAfter for the banner.
        patchEstimatedTokensAfter(event.result);
        this.invalidateSessionLists();
        break;
      case "notice":
        if (event.source === "session-persistence") void this.followSessionMove();
        break;
      case "session_info_update":
        if (typeof event.title === "string") this._sessionName = event.title;
        this.invalidateSessionLists();
        refreshSessionList = true;
        break;
      case "skill_diagnostics_update":
        this.emit({
          type: "skill_diagnostics_update",
          data: parseSkillDiagnosticsSnapshot(event.data),
        });
        notifyRunningChange();
        return;
      case "response": {
        // Unsolicited failed responses surface async prompt failures (omp
        // reuses the original command id after the immediate ack). Some omp
        // versions omit `command` on that second response, so the active run
        // is also a terminal-failure signal. Otherwise this frame would be
        // ignored and the UI would stop with no explanation.
        if (event.success === false) {
          const promptFailure =
            event.command === "prompt" ||
            (!event.command && (this.promptRunning || this.streaming));
          const detail = typeof event.error === "string"
            ? event.error
            : typeof event.message === "string"
              ? event.message
              : "RPC command failed";
          if (!promptFailure) {
            this.emit({ type: "error", error: event.error, message: detail, command: event.command });
            notifyRunningChange();
            return;
          }
          this.promptRunning = false;
          this.awaitingAgentStart = false;
          this.awaitingAgentStartDeadline = 0;
          const promptError = { type: "prompt_error", errorMessage: detail, error: event.error, command: event.command, terminal: !this.streaming };
          this.publishNotifications(promptError);
          this.emit(promptError);
          notifyRunningChange();
          return;
        }
        break;
      }
      case "extension_ui_request": {
        if (this.trackExtensionUiRequest(event)) {
          notifyRunningChange();
          return;
        }
        break;
      }
      case "host_tool_call": {
        const id = typeof event.id === "string" ? event.id : "";
        const toolName = typeof event.toolName === "string" ? event.toolName : "";
        // Server-side agent tools (#275) are answered here, before any
        // browser routing, so they work with no tab open. A disabled gate
        // is an explicit error, not a silent hang and not a browser call.
        if (id && toolName && (AGENT_TOOL_NAMES.has(toolName) || toolName === FOX_REPORT_TOOL || toolName === FOX_GOAL_TOOL)) {
          if (toolName === FOX_REPORT_TOOL || toolName === FOX_GOAL_TOOL || loadWebServerSettings().agentToolsEnabled) {
            void this.answerServerAgentTool(event);
          } else {
            this.proc.sendFrame({
              type: "host_tool_result",
              id,
              isError: true,
              result: {
                content: [{
                  type: "text",
                  text: "Agent tools are disabled. Enable \"Agent tools\" in foxnio Settings (System & Updates) first.",
                }],
              },
            });
            this.emit({ type: "notice", level: "warning", message: `Rejected disabled agent tool: ${toolName}` });
            if (isFoxWorkspacePath(this.cwd) && this.nativeGoalState?.goal.status === "active") {
              this.closeFoxGoalAdmission();
              void this.nativeGoal("pause").then(() => this.foxGoalCommand("control", { action: "pause" }))
                .catch((error) => this.emit({ type: "notice", level: "warning", message: `FOX goal capability was disabled; pause persistence failed: ${String(error)}` }));
            }
          }
          return;
        }
        // Route REGISTERED host tools to an attached UI (the browser answers
        // via host_tool_result). With no tab on this session, hand the call to
        // any open omp-web tab (the user switched sessions mid-run). Otherwise
        // reject immediately so the agent never hangs on a tool nobody will
        // answer.
        if (id && toolName && this.hostToolNames.has(toolName)) {
          if (this.listeners.length > 0) {
            this.pendingHostTools.set(id, event);
            this.emit(event);
            notifyRunningChange();
            return;
          }
          const otherTabs = getHostToolListeners();
          if (otherTabs.size > 0) {
            this.pendingHostTools.set(id, { ...event, webCrossSession: true });
            const args = event.arguments && typeof event.arguments === "object" ? event.arguments as Record<string, unknown> : {};
            const call: CrossSessionHostToolCall = { sessionId: this.sessionId, id, toolName, arguments: args };
            for (const listener of otherTabs) {
              try { listener(call); } catch { /* ignore listener errors */ }
            }
            notifyRunningChange();
            return;
          }
        }
        // Unregistered tool / no listener: reject (emits a notice) and do NOT
        // re-emit the frame — the UI must not answer a call nobody routed.
        this.rejectUnexpectedHostTool(event);
        return;
      }
      case "host_tool_cancel": {
        const targetId = typeof event.targetId === "string" ? event.targetId : "";
        if (targetId && this.pendingHostTools.delete(targetId)) {
          this.releaseHostToolClaim(targetId);
          this.emit(event);
          notifyRunningChange();
          return;
        }
        break;
      }
      case "host_uri_request": {
        const id = typeof event.id === "string" ? event.id : "";
        const url = typeof event.url === "string" ? event.url : "";
        // Route registered schemes to an attached UI (the browser answers via
        // host_uri_result); unknown schemes / no listener are rejected so the
        // agent's read/write never hangs.
        const scheme = url.split(":")[0] ?? "";
        const operation = event.operation === "write" ? "write" : "read";
        const registered = this.hostUriSchemes.get(scheme);
        if (id && scheme && registered && (operation !== "write" || registered.writable) && this.listeners.length > 0) {
          this.pendingHostUris.set(id, event);
          this.emit(event);
          notifyRunningChange();
          return;
        }
        this.proc.sendFrame({
          type: "host_uri_result",
          id,
          isError: true,
          error: `URI scheme \"${scheme}\" is not registered by foxnio`,
        });
        return;
      }
      case "host_uri_cancel": {
        const targetId = typeof event.targetId === "string" ? event.targetId : "";
        if (targetId && this.pendingHostUris.delete(targetId)) {
          this.emit(event);
          notifyRunningChange();
          return;
        }
        break;
      }
    }

    this.publishNotifications(event);
    this.emit(event);
    notifyRunningChange({ refreshSessionList });
  }

  /** Forget a pending dialog and its expiry timer. */
  private forgetPendingUiRequest(id: string): void {
    this.pendingUiRequests.delete(id);
    const timer = this.uiExpiryTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.uiExpiryTimers.delete(id);
    }
  }

  private clearPendingUiRequests(): void {
    const hadPending = this.pendingUiRequests.size > 0;
    for (const timer of this.uiExpiryTimers.values()) clearTimeout(timer);
    this.uiExpiryTimers.clear();
    this.pendingUiRequests.clear();
    if (hadPending) this.settleInputNotification();
  }

  /**
   * A blocking dialog ended without the user answering it (timeout, cancel,
   * restart, or an answer from another client): the recorded "input"
   * notification is stale and must not keep the sidebar on "waiting for
   * input". Only settle once no other dialog is pending.
   */
  private settleInputNotification(): void {
    if (this.pendingUiRequests.size > 0) return;
    const ids = [this._sessionId, ...this.movedFromIds].filter(Boolean);
    if (ids.length === 0) return;
    void settleNotificationInputs(ids.map((id) => `${id}:input`));
    notifyRunningChange();
  }

  private trackExtensionUiRequest(event: UnsequencedAgentEvent): boolean {
    const method = event.method as string;
    const id = event.id as string;
    if (method === "cancel") {
      this.forgetPendingUiRequest(event.targetId as string);
      this.settleInputNotification();
      return false;
    }
    // Only the “Allow tool: <name>” confirmation is covered. Other extension
    // prompts, including login/editor confirmations, remain interactive.
    let autoApproveExtension = false;
    try {
      autoApproveExtension = readNativeSettings().settings.tools?.approval?.extension === "allow";
    } catch {
      // A malformed config must not prevent normal interactive approval.
    }
    if (method === "confirm" && typeof event.title === "string" && /^allow tool\s*:/i.test(event.title) && autoApproveExtension) {
      this.forgetPendingUiRequest(id);
      this.proc.sendFrame({ type: "extension_ui_response", id, confirmed: true });
      this.settleInputNotification();
      return true;
    }
    // Blocking dialogs stay pending until the client answers (replayed to
    // newly-attached SSE listeners so dialogs survive reconnects).
    if (BLOCKING_UI_METHODS.has(method)) {
      this.forgetPendingUiRequest(id);
      const timeout = typeof event.timeout === "number" ? event.timeout : undefined;
      if (timeout && timeout > 0) {
        event.expiresAt = Date.now() + timeout;
        const timer = setTimeout(() => {
          this.forgetPendingUiRequest(id);
          this.settleInputNotification();
        }, timeout);
        timer.unref?.();
        this.uiExpiryTimers.set(id, timer);
      }
      this.pendingUiRequests.set(id, event);
      return false;
    }
    if (method === "setStatus") {
      const key = event.statusKey as string;
      const text = event.statusText as string | undefined;
      if (text === undefined) this.extensionStatuses.delete(key);
      else this.extensionStatuses.set(key, text);
      return false;
    }
    if (method === "setWidget") {
      const key = event.widgetKey as string;
      const lines = event.widgetLines as string[] | undefined;
      if (lines === undefined) {
        this.extensionWidgets.delete(key);
      } else {
        this.extensionWidgets.set(key, {
          key,
          lines,
          placement: (event.widgetPlacement as "aboveEditor" | "belowEditor" | undefined) ?? "aboveEditor",
        });
      }
    }
    return false;
  }

  /**
   * Settle a host_tool_call the UI did not register (or arrived with no
   * attached listener) with an explicit error so its agent turn cannot hang
   * forever waiting for a response. Registered host tools are routed to
   * listeners in handleFrame (see the host_tool_call case).
   */
  private rejectUnexpectedHostTool(event: UnsequencedAgentEvent): void {
    const id = typeof event.id === "string" ? event.id : "";
    if (!id) return;
    const toolName = typeof event.toolName === "string" ? event.toolName : "unknown";
    this.proc.sendFrame({
      type: "host_tool_result",
      id,
      isError: true,
      result: {
        content: [{
          type: "text",
          text: `Host tool \"${toolName}\" is not available in foxnio. Use OMP's built-in tools within the selected workspace.`,
        }],
      },
    });
    this.emit({ type: "notice", level: "warning", message: `Rejected unavailable host tool: ${toolName}` });
  }

  private releaseHostToolClaim(id: string): void {
    const claim = this.hostToolClaims.get(id);
    if (claim) clearTimeout(claim.timer);
    this.hostToolClaims.delete(id);
  }

  /**
   * Reject outstanding host tool calls (browser disconnected / destroy): "own" ones went to this session's
   * stream, "cross" ones to other open tabs (see subscribeHostToolCalls).
   */
  private rejectPendingHostTools(message: string, which: "all" | "own" | "cross" = "all"): void {
    for (const [id, event] of this.pendingHostTools) {
      const cross = event.webCrossSession === true;
      if ((which === "own" && cross) || (which === "cross" && !cross)) continue;
      this.pendingHostTools.delete(id);
      this.releaseHostToolClaim(id);
      this.proc.sendFrame({
        type: "host_tool_result",
        id,
        isError: true,
        result: { content: [{ type: "text", text: message }] },
      });
    }
  }

  /** The last other tab left: settle calls routed to other tabs. */
  rejectCrossSessionHostTools(): void {
    this.rejectPendingHostTools("The web UI disconnected while the agent was waiting for this host tool", "cross");
  }

  /** Reject every outstanding host URI request (browser disconnected / destroy). */
  private rejectPendingHostUris(message: string): void {
    for (const id of this.pendingHostUris.keys()) {
      this.proc.sendFrame({
        type: "host_uri_result",
        id,
        isError: true,
        error: message,
      });
    }
    this.pendingHostUris.clear();
  }

  private finishPromptRun(): void {
    this.responseRunActive = false;
    this.streaming = false;
    this.compacting = false;
    this.promptRunning = false;
    this.clearLiveSnapshots();
  }

  private emit(nativeEvent: UnsequencedAgentEvent): void {
    // Tool-result images go out (and into the replay snapshot) as media URLs:
    // big screenshots must never sit in the browser's chat state as base64.
    const event = eventWithToolResultImageUrls(nativeEvent);
    // `web` belongs to this wrapper, never to native/extension-supplied frames.
    // Strip it before caching tool snapshots as well as before wire emission.
    delete event.web;
    switch (event.type) {
      case "agent_start":
        this.lastRunError = null;
        this.responseObserved = false;
        this.responseRunActive = true;
        this.clearLiveSnapshots();
        break;
      case "agent_end":
        if (event.isTerminal === false) break;
        this.responseRunActive = false;
        this.streaming = false;
        this.promptRunning = false;
        this.compacting = false;
        this.clearLiveSnapshots();
        break;
      case "prompt_error": {
        this.lastRunError = typeof event.errorMessage === "string" && event.errorMessage.trim()
          ? event.errorMessage
          : typeof event.detail === "string" && event.detail.trim() ? event.detail : "Run failed";
        this.finishPromptRun();
        break;
      }
      case "prompt_result": {
        if (event.agentInvoked !== false) {
          if (event.status === "error") {
            const error = isRecord(event.error) ? event.error : undefined;
            this.lastRunError = error && typeof error.message === "string" && error.message.trim()
              ? error.message
              : this.lastRunError ?? "Run failed";
          } else if (event.status === "completed" || event.status === "aborted") {
            this.lastRunError = null;
          }
        }
        this.finishPromptRun();
        break;
      }
      case "message_start":
      case "message_update": {
        const message = event.message as Partial<AgentMessage> | undefined;
        if (message && message.role !== "user") this.streamingMessage = message;
        if (this.responseRunActive && hasVisibleAssistantContent(message)) this.responseObserved = true;
        break;
      }
      case "message_end": {
        const message = event.message as Partial<AgentMessage> | undefined;
        if (this.responseRunActive && hasVisibleAssistantContent(message)) this.responseObserved = true;
        if (message?.role && message.role === this.streamingMessage?.role) this.streamingMessage = null;
        if (message?.role === "toolResult" && message.toolCallId) this.liveToolEvents.delete(message.toolCallId);
        break;
      }
      case "tool_execution_start":
      case "tool_execution_update":
        if (typeof event.toolCallId === "string") {
          this.liveToolEvents.set(event.toolCallId, {
            ...this.liveToolEvents.get(event.toolCallId),
            ...event,
            type: event.type,
            toolCallId: event.toolCallId,
          });
        }
        break;
      case "tool_execution_end":
        if (typeof event.toolCallId === "string") this.liveToolEvents.delete(event.toolCallId);
        break;
    }
    event.web = { streamId: this.streamId, sequence: ++this.streamSequence };
    for (const l of this.listeners) {
      try {
        l(event as AgentEvent);
      } catch {
        // A throwing subscriber (SSE encode failure, UI handler bug) must not
        // starve the remaining subscribers — same isolation RpcProcess and
        // notifyRunningChange apply to their listener sets.
      }
    }
  }

  private sessionFileSignalTimer: NodeJS.Timeout | null = null;

  /** Invalidate session-list metadata plus ONLY this session's parse caches
   * when the file path is known, else fall back to the full invalidation.
   * Use this on the hot event paths (agent_end, auto_compaction_end,
   * session_info_update, …) so a busy session does not flush every other
   * open session's parsed-entry cache. List metadata (sidebar order/counts)
   * still always refreshes. */
  private invalidateSessionLists(): void {
    if (this._sessionFile) {
      invalidateSessionEntriesCache(this._sessionFile);
    } else {
      invalidateSessionListCache();
    }
  }

  /** Poll briefly for the session file to appear after agent_start, then
   *  invalidate the session-list caches and re-signal the sidebar so the
   *  running session shows up even though the file landed after the first
   *  refresh (see the agent_start case). Bounded (max ~10s) and stops on
   *  destroy. */
  private signalWhenSessionFileAppears(): void {
    if (this.sessionFileSignalTimer) return;
    let attempts = 0;
    const check = () => {
      this.sessionFileSignalTimer = null;
      if (!this._alive || !this._sessionFile) return;
      if (!existsSync(this._sessionFile)) {
        attempts += 1;
        if (attempts < 40) {
          this.sessionFileSignalTimer = setTimeout(check, 250);
        }
        return;
      }
      this.invalidateSessionLists();
      notifyRunningChange({ refreshSessionList: true });
    };
    this.sessionFileSignalTimer = setTimeout(check, 250);
  }
  private lastIdleReset = 0;
  private resetIdleTimer(force = false): void {
    // The single activity choke point: start(), every child frame, and every
    // send() land here, so this is where "someone is using this session" is
    // observed. Tracked before the throttle below, which only limits timer
    // churn — it must never hide activity from the reaper.
    this.noteActivity();
    const now = Date.now();
    if (!force && this.idleTimer && now - this.lastIdleReset < 5000) {
      return;
    }
    this.lastIdleReset = now;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.isRunning() || this.handshaking || this.pendingCommands > 0) {
        this.resetIdleTimer(true);
        return;
      }
      console.info("[omp-web] automatic-session-cleanup", JSON.stringify({ sessionId: this._sessionId, reason: "idle-timeout", at: new Date().toISOString() }));
      this.destroy("idle-timeout");
    }, IDLE_DESTROY_MS);
    // A cleanup deadline must not keep the process alive; the registry's
    // process-exit handler disposes every child anyway.
    this.idleTimer.unref?.();
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    this.noteActivity();
    const now = Date.now();
    let expired = false;
    for (const [id, event] of this.pendingUiRequests) {
      const expiresAt = event.expiresAt as number | undefined;
      if (expiresAt !== undefined && expiresAt <= now) {
        this.forgetPendingUiRequest(id);
        expired = true;
        continue;
      }
      listener({ ...event, web: { streamId: this.streamId, sequence: ++this.streamSequence } });
    }
    if (expired) this.settleInputNotification();
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i !== -1) this.listeners.splice(i, 1);
      // No UI attached anymore: reject outstanding host tool calls so the
      // agent never waits forever on a tool nobody will answer.
      if (this.listeners.length === 0) {
        this.rejectPendingHostTools("The web UI disconnected while the agent was waiting for this host tool", "own");
        this.rejectPendingHostUris("The web UI disconnected while the agent was waiting for this URI request");
        // The last tab left. Start (not extend) the reap clock, so a session
        // that was never watched at all — predict_word, /api/agent/new — is
        // cleaned up on the same schedule as one whose tab just closed.
        this.reapDeadline = Date.now() + this.disconnectDestroyMs;
        this.armReap();
      }
    };
  }

  onDestroy(cb: () => void): void {
    this.onDestroyCallback = cb;
  }

  /**
   * Wait for the next `terminalEndsNeeded` terminal turn ends after this
   * call (terminal agent_end, prompt_result, or prompt_error). The caller
   * registers the waiter BEFORE sending the prompt/steer/follow_up, so a
   * fast turn cannot end before the waiter exists. Rejects on timeout;
   * the target is left running (never aborted by a waiter timeout).
   * A follow_up sent to a running target needs two ends: the running
   * turn ends first, then the queued message's own turn ends.
   */
  waitForTurnEnd(timeoutMs: number, terminalEndsNeeded = 1): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let done = false;
      let endsSeen = 0;
      const timer = setTimeout(() => finish(new Error("Timed out waiting for the target session's response.")), timeoutMs);
      timer.unref?.();
      const detach = this.onEvent((event) => {
        if (event.type === "agent_end" && event.isTerminal === false) return;
        if (event.type === "agent_end" || event.type === "prompt_result") {
          endsSeen += 1;
          if (endsSeen >= terminalEndsNeeded) finish(null);
        } else if (event.type === "prompt_error") {
          finish(new Error(typeof event.errorMessage === "string" ? event.errorMessage : "Target session turn failed."));
        }
      });
      const finish = (error: Error | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.turnWaiters.delete(finish);
        detach();
        if (error) reject(error);
        else resolve();
      };
      // destroyAndWait rejects through this so callers never sit out the timeout.
      this.turnWaiters.add(finish);
    });
  }

  /**
   * Answer a server-side agent tool call (#275) from this wrapper's child.
   * Runs on the server, with no browser involved, and answers directly
   * with host_tool_result — never via pendingHostTools, so a later tab
   * disconnect cannot settle it as a UI call.
   */
  private async answerServerAgentTool(event: UnsequencedAgentEvent): Promise<void> {
    const id = typeof event.id === "string" ? event.id : "";
    const toolName = typeof event.toolName === "string" ? event.toolName : "";
    if (!id) return;
    const answeringProc = this.proc;
    const sendResult = (text: string, isError = false) => {
      if (this.proc !== answeringProc || !this.isAlive()) return;
      this.proc.sendFrame({
        type: "host_tool_result",
        id,
        isError,
        result: { content: [{ type: "text", text }] },
      });
    };
    try {
      const args = event.arguments && typeof event.arguments === "object" ? event.arguments as Record<string, unknown> : {};
      if (toolName === FOX_GOAL_TOOL) {
        const native = this.foxGoalEvents.get(String(event.toolCallId));
        this.foxGoalEvents.delete(String(event.toolCallId));
        if (native && native.sessionId !== this.sessionId) this.applyIdentity(await this.getStateWithTimeout());
        if (!isFoxWorkspacePath(this.cwd) || !native || native.sessionId !== this.sessionId || native.op !== args.op) throw new Error("The native FOX goal confirmation or mutation event is missing; model arguments cannot authorize a goal.");
        if (native.op === "authorize") {
          if (!loadWebServerSettings().agentToolsEnabled) throw new Error("Agent tools are disabled. Enable the existing Agent tools setting before authorizing FOX delivery.");
          const grant = native.snapshot.grant;
          if (!grant || grant.id !== native.consentEntryId || grant.goalId || grant.revoked) throw new Error("The confirmed goal scope is not eligible for initial binding");
          if (native.hostControlVersion !== this.foxGoalControlVersion
            || this.foxGoalAdmissionClosed && this.foxGoalDurableControlVersion !== this.foxGoalControlVersion) throw new Error("A pending or newer FOX control cancelled this consent");
          this.foxGoalAdmissionClosed = false;
          if (this.foxGoalContinuation) {
            // A queued human request can authorize the next delivery before
            // the old [rpc] child settles. Create only after a [] restart.
            this.foxGoalActivationPending = true;
            sendResult(JSON.stringify(native.snapshot));
            return;
          }
          const bound = await this.withFoxGoalEffect(async () => {
            const current = await this.nativeGoal("get");
            if (current.goal && (native.snapshot.inheritedGoalIds?.includes(current.goal.id) || grant.replacesGoalId === current.goal.id)) await this.nativeGoal("drop");
            else if (current.goal && current.goal.status !== "complete") throw new Error("An existing native goal must be stopped before replacing its scope");
            const created = await this.nativeGoal("create", { objective: grant.terms.objective, ...(grant.terms.tokenBudget === undefined ? {} : { token_budget: grant.terms.tokenBudget }) });
            await this.nativeGoal("pause");
            if (this.foxGoalAdmissionClosed || !created.goal || created.goal.objective !== grant.terms.objective) throw new Error("Native objective does not exactly match confirmed scope; goal remains paused");
            const snapshot = await this.foxGoalCommand("bind", { grantEntryId: grant.id, goalId: created.goal.id, objective: created.goal.objective });
            if (snapshot.grant?.goalId !== created.goal.id || snapshot.grant.revoked || this.foxGoalAdmissionClosed) throw new Error("Native grant binding was not persisted or was revoked");
            this.foxGoalActivationPending = true;
            return snapshot;
          });
          sendResult(JSON.stringify(bound));
        } else sendResult(JSON.stringify(await this.getFoxGoalSnapshot()));
        return;
      }
      if (toolName === FOX_REPORT_TOOL) {
        const callId = typeof event.toolCallId === "string" ? event.toolCallId : "";
        const pending = this.foxReportCalls.get(callId);
        this.foxReportCalls.delete(callId);
        if (!pending) throw new Error("The native worker report was not recorded. Reporting requires the FOX worker extension.");
        const report = await pending;
        sendResult(JSON.stringify({ accepted: true, reportId: report.id, parentSessionId: report.parentSessionId, delivery: "pending", persisted: "native-worker-session" }));
        return;
      }
      if ((toolName === "new_session" || toolName === "send_to_session") && foxWorkerParent(this.sessionFile)) {
        throw new Error("Project workers report through report_to_parent; cross-project delegation belongs to FOX.");
      }
      let goalAdmission: FoxHostAdmission | undefined;
      if (isFoxWorkspacePath(this.cwd) && (toolName === "new_session" || toolName === "send_to_session")) {
        if (this.foxReportInbox) throw new Error("Receiving a worker report cannot authorize new execution.");
        const projectRef = await this.foxActionProject(toolName, args);
        const policy = foxDispatchPolicy(initializeFoxNativePolicy(), projectRef);
        if (policy === "observe") throw new Error("This project is observation-only. No work was dispatched.");
        if (args.coordination !== undefined) {
          const coordination = parseFoxGoalCoordination(args.coordination) as FoxGoalCoordination;
          const receipt = this.foxDispatchReceipts.takeGrant({ sessionId: this.sessionId, toolCallId: event.toolCallId, toolName, input: args, projectKey: projectRef });
          if (!receipt || receipt.grantEntryId !== coordination.grantEntryId || receipt.nativeGoalId !== coordination.nativeGoalId) throw new Error("Fresh native goal admission receipt is missing or stale");
          goalAdmission = { coordination, admissionId: receipt.admissionId, projectKey: projectRef, input: { ...args }, toolName, sessionId: this.sessionId, toolCallId: String(event.toolCallId) };
        } else {
          const snapshot = this.foxGoalAvailable ? await this.getFoxGoalSnapshot() : null;
          if (snapshot?.grant && !snapshot.grant.revoked) throw new Error("Automatic goal dispatch requires explicit coordination metadata");
          this.consumeFoxDispatchConsent(event, args, projectRef, policy === "confirm");
        }
        args.cwd = projectRef;
      }
      const execute = async () => {
        try {
          const result = await executeAgentTool(toolName, args, createAgentToolOps(this, goalAdmission), {
            sourceSessionId: this.sessionId, sourceCwd: this.cwd,
            enabled: loadWebServerSettings().agentToolsEnabled, guard: getAgentToolGuard(),
            allowSendTarget: isFoxWorkspacePath(this.cwd)
              ? async (target, cwd) => { await this.foxActionProject("send_to_session", { sessionId: target, cwd }); return true; }
              : undefined,
          });
          if (goalAdmission) await this.foxGoalCommand("settle", { admissionId: goalAdmission.admissionId, state: "running" });
          return result;
        } catch (error) {
          if (goalAdmission) await this.foxGoalCommand("settle", { admissionId: goalAdmission.admissionId, state: goalAdmission.effectStarted ? "uncertain" : "closed" }).catch(() => {});
          throw error;
        }
      };
      const result = goalAdmission ? await this.withFoxGoalEffect(execute) : await execute();
      sendResult(typeof result === "string" ? result : JSON.stringify(result));
    } catch (error) {
      sendResult(error instanceof Error ? error.message : String(error), true);
    }
  }

  closeFoxGoalAdmission(): void {
    this.foxGoalAdmissionClosed = true;
    this.foxGoalControlVersion += 1;
    this.foxGoalActivationPending = false;
    this.foxDispatchReceipts.clear();
  }

  async waitFoxGoalEffects(): Promise<void> { await this.foxGoalEffects.catch(() => {}); }

  async pauseFoxGoalResource(grantEntryId: string, goalId: string, reason: string): Promise<void> {
    if (!["expired", "dispatch-limit", "rework-limit", "agent-tools-disabled"].includes(reason)) throw new Error("Unknown FOX resource pause reason");
    this.closeFoxGoalAdmission();
    await this.withFoxGoalEffect(async () => {
      const snapshot = await this.getFoxGoalSnapshot();
      if (!snapshot.supported || snapshot.grant?.id !== grantEntryId || snapshot.grant.goalId !== goalId || snapshot.goal?.goal.id !== goalId) throw new Error("Resource pause does not match the current native goal and grant");
      await this.nativeGoal("pause");
      await this.foxGoalCommand("control", { action: "pause", grantEntryId });
      await this.foxGoalCommand("recovery", { recovery: "waiting", obligation: `resource:${reason}`, grantEntryId });
    });
  }

  async pauseFoxGoalHandoff(grantEntryId: string, goalId: string, handoffEntryId: string): Promise<void> {
    await this.withFoxGoalEffect(async () => {
      const snapshot = await this.getFoxGoalSnapshot();
      if (!snapshot.supported || snapshot.grant?.id !== grantEntryId || snapshot.grant.goalId !== goalId
        || snapshot.goal?.goal.id !== goalId || !snapshot.handoffs?.some((handoff) => handoff.id === handoffEntryId && handoff.state === "uncertain")) {
        throw new Error("Handoff pause does not match the current native goal and uncertain handoff");
      }
      // The durable uncertainty already fences dispatch. Do not install a
      // user/resource pause that would require fresh consent after resolution.
      await this.nativeGoal("pause");
    });
  }

  private async withFoxGoalEffect<T>(operation: () => Promise<T>): Promise<T> {
    await this.waitIdentityPersistence();
    const result = this.foxGoalEffects.then(operation, operation);
    this.foxGoalEffects = result;
    return result;
  }

  private withFoxMetadata<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.foxMetadataQueue.then(operation, operation);
    this.foxMetadataQueue = result;
    return result;
  }

  async recheckFoxGoalDispatch(admission: FoxHostAdmission): Promise<FoxGoalSnapshot> {
    if (this.foxGoalAdmissionClosed || !this.isAlive()) throw new Error("FOX goal admission was closed before the side effect");
    if (foxDispatchPolicy(initializeFoxNativePolicy(), admission.projectKey) === "observe") throw new Error("The project became observation-only before dispatch");
    const snapshot = await this.getFoxGoalSnapshot();
    let workerSessionIds: string[] | undefined;
    if (admission.toolName === "send_to_session") {
      const file = await resolveSessionPath(String(admission.input.sessionId));
      workerSessionIds = file ? nativeSessionLineage(file)?.map((item) => item.header.id) : undefined;
      if (!workerSessionIds) throw new Error("The native worker continuation cannot be verified");
    }
    if (this.foxGoalAdmissionClosed) throw new Error("FOX goal admission was closed before the side effect");
    if (foxDispatchPolicy(initializeFoxNativePolicy(), admission.projectKey) === "observe") throw new Error("The project became observation-only before dispatch");
    validateFoxGoalDispatch(snapshot, admission.coordination, { ...admission, workerSessionIds });
    return snapshot;
  }

  assertFoxGoalAdmissionOpen(projectKey: string): void {
    if (this.foxGoalAdmissionClosed || !this.isAlive()) throw new Error("FOX goal admission was closed before the side effect");
    if (foxDispatchPolicy(initializeFoxNativePolicy(), projectKey) === "observe") throw new Error("The project became observation-only before dispatch");
  }

  async nativeGoal(op: "get" | "create" | "pause" | "resume" | "drop", args: Record<string, unknown> = {}): Promise<{ goal: NativeGoal | null; state: NativeGoalModeState | null }> {
    return this.withFoxMetadata(() => this.sendNativeGoal(op, args));
  }

  private async sendNativeGoal(op: "get" | "create" | "pause" | "resume" | "drop", args: Record<string, unknown> = {}): Promise<{ goal: NativeGoal | null; state: NativeGoalModeState | null }> {
    if (this.restarting) throw new WebRpcError(RESTARTING_MESSAGE, "session_restarting");
    if (!isFoxWorkspacePath(this.cwd) || !this.isAlive()) throw new Error("Native goal controls require the live FOX conversation");
    if (op === "create" && this.foxGoalContinuation) throw new Error("Goal setup requires continuation disabled");
    if ((op === "create" || op === "resume") && this.foxGoalAdmissionClosed) throw new Error("FOX goal admission is closed");
    const proc = this.proc;
    const identity = this.sessionId;
    this.resetIdleTimer();
    this.pendingCommands += 1;
    try {
      const result = await proc.sendCommand<{ goal: NativeGoal | null; state: NativeGoalModeState | null }>({ ...args, type: "goal", op }, GET_STATE_TIMEOUT_MS);
      if (this.proc !== proc || this.sessionId !== identity) throw new Error("Native goal conversation identity changed");
      if (!result || !("goal" in result) || !("state" in result)) throw new Error("OMP native goal RPC is unsupported");
      this.nativeGoalState = result.state;
      return result;
    } finally { this.pendingCommands -= 1; }
  }

  async foxGoalCommand(op: string, args: Record<string, unknown> = {}): Promise<FoxGoalSnapshot> {
    return this.withFoxMetadata(() => this.sendFoxGoalCommand(op, args));
  }

  private async sendFoxGoalCommand(op: string, args: Record<string, unknown> = {}): Promise<FoxGoalSnapshot> {
    if (!["get", "bind", "assignment", "settle", "control", "handoff", "handoff-resolve", "worker-bind", "recovery", "notification"].includes(op)) throw new Error("Unknown internal FOX goal command");
    if (!this.isAlive() || this.restarting) throw new Error("FOX runtime is unavailable");
    const exclusive = op === "handoff" || op === "handoff-resolve";
    if (exclusive && (this.foxGoalAdmissionClosed || this.foxGoalExclusive || this.isRunning() || this.isEditingHistory() || this.historyMutationPendingCount > 0)) throw new WebRpcError("FOX is busy; report handoff remains pending", "session_busy");
    if (exclusive) this.foxGoalExclusive = true;
    const proc = this.proc;
    const sessionId = this.sessionId;
    const sessionFile = this.sessionFile;
    const requestId = randomUUID();
    const commandControlVersion = this.foxGoalControlVersion;
    let detach = () => {};
    let rejectPending: ((error: Error) => void) | undefined;
    let actualSessionId: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    this.pendingCommands += 1;
    this.foxGoalInternalCommands += 1;
    this.resetIdleTimer();
    try {
      if (!this.foxGoalAvailable) {
        const catalog = await proc.sendCommand<{ commands?: RpcAvailableSlashCommand[] }>({ type: "get_available_commands" }, GET_STATE_TIMEOUT_MS);
        this.foxGoalAvailable = Boolean(catalog?.commands?.some((command) => command.name === FOX_GOAL_COMMAND && command.source === "extension"));
        if (!this.foxGoalAvailable) throw new Error("Native FOX goals are unavailable; update OMP and restart FOX when idle");
      }
      if (exclusive) {
        const state = await this.getStateWithTimeout();
        if (state.sessionId !== sessionId || state.isSettled !== true || state.hasPendingAsyncWork || state.isStreaming || state.isCompacting || state.queuedMessageCount > 0 || this.historyMutationPendingCount > 0) throw new WebRpcError("FOX has pending native or user work", "session_busy");
      }
      const { promise: reply, resolve, reject } = Promise.withResolvers<FoxGoalSnapshot>();
      rejectPending = reject;
      this.foxGoalWaiters.add(reject);
      timer = setTimeout(() => reject(new RpcCommandTimeoutError(FOX_GOAL_COMMAND, 15_000)), 15_000);
      timer.unref?.();
      detach = proc.onFrame((frame) => {
        if (frame.type === "notice" && frame.source === "session-persistence" && frame.level === "error") reject(new Error(String(frame.message)));
        if (frame.type !== "extension_ui_request" || frame.method !== "notify" || typeof frame.message !== "string" || !frame.message.startsWith(FOX_GOAL_REPLY_PREFIX)) return;
        let value;
        try { value = JSON.parse(frame.message.slice(FOX_GOAL_REPLY_PREFIX.length)); } catch { return; }
        if (value.requestId !== requestId) return;
        if (value.sessionId !== sessionId || this.proc !== proc || !this.isAlive()) reject(new Error("Native goal reply conversation identity changed"));
        else if (typeof value.error === "string") reject(value.code === "session_busy" ? new WebRpcError(value.error, "session_busy") : new Error(value.error));
        else if (!isRecord(value.data)) reject(new Error("Native goal reply has no snapshot"));
        else {
          actualSessionId = typeof value.actualSessionId === "string" ? value.actualSessionId : sessionId;
          resolve(value.data as unknown as FoxGoalSnapshot);
        }
      });
      void reply.catch(() => {});
      if (this.proc !== proc || this.sessionId !== sessionId || exclusive && this.foxGoalAdmissionClosed) throw new Error("FOX goal admission or conversation changed before command submission");
      const ack = await proc.sendCommand<{ agentInvoked?: boolean }>({ type: "prompt", message: `/${FOX_GOAL_COMMAND} ${JSON.stringify({ ...args, requestId, sessionId, op })}` }, 15_000);
      if (!exclusive && ack?.agentInvoked) throw new Error("OMP invoked the model for an internal goal metadata command");
      const snapshot = await reply;
      if (actualSessionId && actualSessionId !== this.sessionId) {
        const current = await this.getStateWithTimeout();
        if (current.sessionId !== actualSessionId || !sessionFile || !current.sessionFile || !sameNativeConversation(sessionFile, current.sessionFile)) throw new Error("Native goal reply continuation identity cannot be verified");
        this.sessionMovePending = true;
        this.applyIdentity(current);
      }
      if (this.sessionId !== sessionId && (!this.movedFromIds.includes(sessionId) || !sessionFile || !sameNativeConversation(sessionFile, this.sessionFile))) throw new Error("Native goal reply conversation identity changed");
      if (op === "control" && args.action !== "resume" && commandControlVersion === this.foxGoalControlVersion) this.foxGoalDurableControlVersion = commandControlVersion;
      this.invalidateSessionLists();
      return snapshot;
    } finally {
      if (rejectPending) this.foxGoalWaiters.delete(rejectPending);
      clearTimeout(timer);
      detach();
      this.pendingCommands -= 1;
      this.foxGoalInternalCommands -= 1;
      if (exclusive) this.foxGoalExclusive = false;
    }
  }

  async getFoxGoalSnapshot(): Promise<FoxGoalSnapshot> {
    return this.withFoxMetadata(async () => {
      const native = await this.sendNativeGoal("get");
      return this.sendFoxGoalCommand("get", { nativeGoal: native.state });
    });
  }

  async activateFoxGoal(explicitResume = false): Promise<boolean> {
    let operation = this.foxGoalActivation;
    if (!operation) {
      operation = this.runFoxGoalActivation(explicitResume);
      this.foxGoalActivation = operation;
      const clear = () => { if (this.foxGoalActivation === operation) this.foxGoalActivation = null; };
      void operation.then(clear, clear);
    }
    const activated = await operation;
    if (!activated && explicitResume) throw new WebRpcError("FOX is busy; activation waits for settlement", "session_busy");
    return activated;
  }

  private async runFoxGoalActivation(explicitResume: boolean): Promise<boolean> {
    if (!explicitResume && this.foxGoalAdmissionClosed) return false;
    // A concurrent user turn/receipt is a deferred automatic obligation, not
    // an activation failure. Same-wrapper activation callers join above.
    if (this.foxGoalExclusive || this.isRunning() || this.isEditingHistory() || this.historyMutationPendingCount > 0 || this.pendingHumanRequests()) return false;
    this.foxGoalExclusive = true;
    const controlVersion = this.foxGoalControlVersion;
    try {
      const state = await this.getStateWithTimeout();
      if (state.isSettled !== true || state.hasPendingAsyncWork || state.queuedMessageCount > 0 || this.historyMutationPendingCount > 0) return false;
      let before = await this.getFoxGoalSnapshot();
      let grant = before.grant;
      if (before.supported && grant && !grant.goalId && !grant.revoked && !grant.paused && before.recovery === "next") {
        const consentId = grant.id;
        if (this.foxGoalContinuation) await this.restart(false);
        before = await this.getFoxGoalSnapshot();
        grant = before.grant;
        if (!grant || grant.id !== consentId || grant.goalId || grant.revoked || grant.paused || controlVersion !== this.foxGoalControlVersion) throw new Error("Confirmed goal scope changed before settled setup");
        const terms = grant.terms;
        const inheritedGoalIds = before.inheritedGoalIds ?? [];
        const replacesGoalId = grant.replacesGoalId;
        before = await this.withFoxGoalEffect(async () => {
          const current = await this.nativeGoal("get");
          if (current.goal && (inheritedGoalIds.includes(current.goal.id) || replacesGoalId === current.goal.id)) await this.nativeGoal("drop");
          else if (current.goal && current.goal.status !== "complete") throw new Error("An unrelated native goal cannot be replaced by deferred consent");
          const created = await this.nativeGoal("create", { objective: terms.objective, ...(terms.tokenBudget === undefined ? {} : { token_budget: terms.tokenBudget }) });
          await this.nativeGoal("pause");
          if (this.foxGoalAdmissionClosed || controlVersion !== this.foxGoalControlVersion || !created.goal || created.goal.objective !== terms.objective) throw new Error("Confirmed objective changed during settled setup");
          return this.foxGoalCommand("bind", { grantEntryId: consentId, goalId: created.goal.id, objective: created.goal.objective });
        });
        grant = before.grant;
      }
      if (!before.supported || !grant?.goalId || grant.revoked || grant.paused || before.assignments.some((a) => a.state === "uncertain") || before.goal?.goal?.id !== grant.goalId || before.goal.goal.objective !== grant.terms.objective) throw new Error("FOX grant cannot safely resume");
      if (before.resourcePauseReason) throw new Error(`FOX requires fresh resource authorization: ${before.resourcePauseReason}`);
      if (grant.terms.expiresAt && Date.parse(grant.terms.expiresAt) <= Date.now()
        || before.goal.reason || before.goal.goal.status === "complete"
        || before.goal.goal.tokenBudget !== undefined && before.goal.goal.tokensUsed >= before.goal.goal.tokenBudget) throw new Error("Native goal grant expired, completed, or reached its native resource limit");
      if (controlVersion !== this.foxGoalControlVersion) throw new Error("FOX goal control changed during activation");
      if (!loadWebServerSettings().agentToolsEnabled) throw new Error("Agent tools are disabled; FOX goal remains paused");
      if (this.foxGoalContinuation && before.goal.enabled && before.goal.goal.status === "active") {
        this.foxGoalActivationPending = false;
        return true;
      }
      if (!this.foxGoalContinuation) {
        await this.restart(true);
        const after = await this.getFoxGoalSnapshot();
        if (after.grant?.id !== grant.id || after.grant.revoked || after.grant.paused || after.goal?.goal?.id !== grant.goalId || after.goal.goal.objective !== grant.terms.objective) throw new Error("FOX binding changed during activation; native goal remains paused");
      }
      if (controlVersion !== this.foxGoalControlVersion || this.foxGoalAdmissionClosed && !explicitResume) throw new Error("FOX goal control changed during activation");
      this.foxGoalAdmissionClosed = false;
      await this.nativeGoal("resume");
      this.foxGoalActivationPending = false;
      return true;
    } finally { this.foxGoalExclusive = false; }
  }

  hasFoxReporting(): boolean {
    return this.foxReportingAvailable;
  }

  hasFoxWorkerReporting(): boolean {
    return this.foxReportingAvailable && this.hostToolNames.has(FOX_REPORT_TOOL);
  }

  private async captureFoxReport(report: FoxWorkerReport): Promise<FoxWorkerReport> {
    this.resetIdleTimer();
    if (this.sessionId !== report.sourceSessionId) this.applyIdentity(await this.getStateWithTimeout());
    if (this.sessionId !== report.sourceSessionId) throw new Error("The report source does not match the native worker");
    const accepted = await acceptFoxReport(this.sessionFile, report);
    this.invalidateSessionLists();
    return accepted;
  }

  async receiveFoxReport(report: FoxWorkerReport, parentFile = this.sessionFile): Promise<void> {
    if (this.foxReportInbox || this.foxGoalExclusive || this.isRunning() || this.historyMutationPendingCount > 0
      || this.historyEditInFlight || this.pendingHumanRequests() > 0 || this.restarting || this.mcpListInFlight) {
      throw new WebRpcError("FOX is busy; its native report inbox will retry after settlement", "session_busy");
    }
    const receive = async () => {
      this.resetIdleTimer();
      this.pendingCommands += 1;
      try {
        const matches = (file: string) => readSessionHeader(parentFile)?.id === report.parentSessionId && sameNativeConversation(file, parentFile);
        if (!this.isAlive() || !isFoxWorkspacePath(this.cwd) || !matches(this.sessionFile)) throw new Error("The original FOX recipient is unavailable");
        const state = await this.getStateWithTimeout();
        if (!state.sessionFile || !matches(state.sessionFile)) throw new Error("The native parent changed identity; the report was not redirected");
        if (state.isStreaming || state.isCompacting || state.queuedMessageCount > 0) {
          throw new WebRpcError("FOX has queued or active model work; report delivery waits for native idle", "session_busy");
        }
        await deliverNativeFoxReport(this.proc, report, parentFile);
        const after = await this.getStateWithTimeout();
        if (!after.sessionFile || !matches(after.sessionFile)) throw new Error("The native parent changed during report delivery");
        this.invalidateSessionLists();
        this.emit({ type: "session_history_changed", leafId: null });
      } catch (error) {
        if (error instanceof FoxReportAgentInvocationError) await this.destroyAndWait();
        throw error;
      } finally {
        this.pendingCommands = Math.max(0, this.pendingCommands - 1);
      }
    };
    const operation = this.withFoxMetadata(receive);
    this.foxReportInbox = operation;
    try { await operation; } finally {
      if (this.foxReportInbox === operation) this.foxReportInbox = null;
    }
  }

  private async foxActionProject(toolName: string, args: Record<string, unknown>): Promise<string> {
    if (toolName === "new_session") {
      const cwd = typeof args.cwd === "string" ? args.cwd.trim() : "";
      if (!cwd || isFoxWorkspacePath(cwd)) throw new Error("FOX workers require an explicit project directory outside the FOX workspace.");
      if (!existsSync(cwd)) throw new Error(`Directory does not exist: ${cwd}`);
      const project = foxDispatchProjectKey(cwd);
      if (isFoxWorkspacePath(project)) throw new Error("FOX cannot delegate implementation to its own workspace.");
      return project;
    }

    const sessionId = typeof args.sessionId === "string" ? args.sessionId.trim() : "";
    if (!sessionId) throw new Error("Agent tool argument \"sessionId\" is required and must be a non-empty string.");
    const file = await resolveSessionPath(sessionId);
    const header = file ? readSessionHeader(file) : null;
    if (!header?.cwd) throw new Error(`Session not found: ${sessionId}`);
    const parent = file ? foxWorkerParent(file) : null;
    if (!parent || !sameNativeConversation(parent.parentFile, this.sessionFile)) {
      throw new Error("FOX can only follow up direct workers of this conversation. Use new_session for new work.");
    }
    if (typeof args.cwd !== "string" || foxDispatchProjectKey(args.cwd) !== foxDispatchProjectKey(header.cwd)) {
      throw new Error("The approved project cwd does not match this worker. Read its exact cwd from list_sessions.");
    }
    return foxDispatchProjectKey(header.cwd);
  }

  /** Consume native hook consent for exactly one pending FOX dispatch. */
  private consumeFoxDispatchConsent(event: UnsequencedAgentEvent, args: Record<string, unknown>, projectKey: string, requireConfirmation: boolean): void {
    if (!this.foxDispatchReceipts.take({
      sessionId: this.sessionId,
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: args,
      projectKey,
    }, requireConfirmation)) throw new Error("Native FOX authorization is missing, expired, or no longer matches this action. No work was dispatched.");
  }

  /** Called when a session-changing command re-keyed this wrapper (branch/new_session/switch_session). */
  onIdentityChange(cb: (oldId: string, newId: string, options?: IdentityChangeOptions) => void | Promise<void>): void {
    this.onIdentityChangeCallback = cb;
  }

  private recordIdentityChange(oldId: string, newId: string, options?: IdentityChangeOptions): void {
    const result = this.onIdentityChangeCallback?.(oldId, newId, options);
    if (!result) return;
    const persistence = Promise.resolve(result);
    this.identityPersistence = Promise.all([this.identityPersistence, persistence]).then(() => {});
    void this.identityPersistence.catch((error) => {
      this.identityPersistenceError = error instanceof Error ? error : new Error(String(error));
      this.closeFoxGoalAdmission();
    });
  }

  async waitIdentityPersistence(): Promise<void> {
    await this.identityPersistence;
    if (this.identityPersistenceError) throw this.identityPersistenceError;
  }

  private async withFinalRunningNotification<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } finally {
      notifyRunningChange();
    }
  }

  /** Get OMP's own complete MCP inventory and live connection states. */
  async getMcpList(): Promise<string> {
    return this.runMcpCommand("list");
  }

  /** RPC /mcp reload refreshes command metadata only. Reboot the idle child
   * against its saved session to actually rediscover MCP tools. */
  async changeMcp(action: "enable" | "disable" | "reload", name?: string): Promise<void> {
    if (!["enable", "disable", "reload"].includes(action)) throw new Error("Invalid MCP action");
    if (action !== "reload" && (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name))) throw new Error("Invalid MCP server name");
    await this.runMcpCommand(action, name, true);
  }

  private async runMcpCommand(action: "list" | "enable" | "disable" | "reload", name?: string, apply = false): Promise<string> {
    if (this.restarting) throw new WebRpcError(RESTARTING_MESSAGE, "session_restarting");
    if (!this.isAlive()) throw new Error("Session is no longer running");
    if (this.isRunning() || this.isEditingHistory() || this.pendingUiRequests.size > 0 || this.pendingHostTools.size > 0 || this.pendingHostUris.size > 0) throw new WebRpcError("Wait for the current operation to finish", "session_busy");
    if (this.mcpListWaiter || this.mcpListInFlight) throw new WebRpcError("MCP list is already loading", "mcp_list_loading");

    // Dedicated synchronous mutex: promptRunning alone is not atomic — two
    // concurrent callers could both pass the isRunning() check, and the second
    // would steal the waiter so the first hangs to timeout (or receives the
    // other's output). This flag is checked+set before any await.
    this.mcpListInFlight = true;
    this.historyMutationPendingCount += 1;

    this.promptRunning = true;
    notifyRunningChange();
    let resolveOutput!: (text: string) => void;
    let rejectOutput!: (error: Error) => void;
    const output = new Promise<string>((resolve, reject) => {
      resolveOutput = resolve;
      rejectOutput = reject;
    });
    // The timeout, destroy, and sendCommand-failure paths all reject this
    // promise while the only `await output` (success path) may never run —
    // swallow the orphan so it cannot surface as an unhandledRejection.
    void output.catch(() => {});
    const waiter = {
      resolve: resolveOutput,
      reject: rejectOutput,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
    };
    waiter.timer = setTimeout(() => {
        if (this.mcpListWaiter !== waiter) return;
        this.mcpListWaiter = null;
        rejectOutput(new WebRpcError("Timed out while loading MCP servers", "mcp_list_timeout"));
      }, MCP_LIST_TIMEOUT_MS);
    // Don't pin the event loop if the caller never awaits (route aborted): the
    // pending-UI timers already unref, this one should too.
    waiter.timer.unref?.();
    this.mcpListWaiter = waiter;

    try {
      // Bounded like the prompt ack: a child that accepts the frame but never
      // acks it would otherwise suspend this call forever — the `finally` below
      // would never run and the wrapper would keep reporting itself as busy
      // (later calls fail with session_busy) until unrelated traffic cleared
      // the wedge. The 15s output wait above stays a separate concern.
      await this.proc.sendCommand({ type: "prompt", message: action === "list" ? "/mcp list" : `/mcp ${action}${name ? ` ${name}` : ""}` }, PROMPT_ACK_TIMEOUT_MS);
      const result = await output;
      if (action !== "list" && /^(?:Failed|Usage:|Server .* not found|Unknown)/m.test(result)) {
        throw new WebRpcError("OMP could not update this MCP server. Check its source configuration.", "mcp_change_failed");
      }
      if (apply) {
        try { await this.restart(); }
        catch { throw new WebRpcError("MCP configuration was saved, but session reload failed. Reopen the session to apply it.", "mcp_reload_failed"); }
      }
      return result;
    } catch (error) {
      const expired = error instanceof RpcCommandTimeoutError;
      if (this.mcpListWaiter === waiter) {
        clearTimeout(waiter.timer);
        this.mcpListWaiter = null;
        waiter.reject(
          expired
            ? new WebRpcError("The OMP session stopped responding and was reset.", "session_unresponsive")
            : error instanceof Error
              ? error
              : new Error(String(error)),
        );
      }
      if (expired) {
        // Nothing on this child will ever resolve the waiter; recycle it like
        // the prompt-ack timeout path so the next request gets a fresh child.
        await this.destroyAndWait();
        throw new WebRpcError("The OMP session stopped responding and was reset.", "session_unresponsive");
      }
      throw error;
    } finally {
      if (this.mcpListWaiter === waiter) {
        clearTimeout(waiter.timer);
        this.mcpListWaiter = null;
      }
      this.mcpListInFlight = false;
      this.historyMutationPendingCount -= 1;
      this.promptRunning = false;
      notifyRunningChange();
    }
  }

  /** The chat's explicit advisor choice this child reflects. */
  get advisorChoice(): AdvisorChoice {
    return this._advisorChoice;
  }

  /**
   * Run omp's native `/advisor on|off` on this child. It is a local command
   * that flips the session's in-memory advisor flag: omp answers with one
   * `command_output` line (kept out of the chat, see handleFrame) and starts no
   * model turn. An omp without the command would hand the text to the model,
   * so the command list is checked first; false means it is unavailable.
   */
  private async sendAdvisorCommand(choice: "on" | "off"): Promise<boolean> {
    const data = await this.proc
      .sendCommand<{ commands?: RpcAvailableSlashCommand[] }>({ type: "get_available_commands" }, GET_STATE_TIMEOUT_MS)
      .catch(() => null);
    if (!data?.commands?.some((command) => command.name === "advisor")) return false;
    this.quietAdvisorUntil = Date.now() + PROMPT_ACK_TIMEOUT_MS;
    await this.proc.sendCommand({ type: "prompt", message: `/advisor ${choice}` }, PROMPT_ACK_TIMEOUT_MS);
    return true;
  }

  /**
   * Make the live child follow a chat's explicit advisor choice without a
   * respawn. Only an idle child takes the command (a prompt mid-run would be
   * queued behind the turn); false means it was not applied now, the recorded
   * choice stays unchanged, and the next request carrying the choice retries.
   * `inherit` is no opinion and leaves the child as it is.
   */
  async applyAdvisorChoice(choice: AdvisorChoice): Promise<boolean> {
    if (choice === "inherit" || choice === this._advisorChoice) return true;
    if (this.restarting || !this.isAlive() || this.isRunning() || this.historyEditInFlight || this.mcpListInFlight || this.pendingUiRequests.size > 0) return false;
    try {
      if (!(await this.sendAdvisorCommand(choice))) return false;
    } catch {
      return false;
    }
    this._advisorChoice = choice;
    return true;
  }

  /**
   * Spawn-time half of an `off` choice. omp has no launch flag that disables
   * an advisor enabled by config.yml (or by the workspace's --advisor), so
   * every fresh or restarted child runs `/advisor off` before its first prompt.
   * `on` is the --advisor spawn flag and needs nothing here.
   */
  async applyAdvisorChoiceAfterSpawn(): Promise<void> {
    if (this._advisorChoice !== "off") return;
    try {
      if (!(await this.sendAdvisorCommand("off"))) {
        console.warn("[omp-web] this omp has no /advisor command; the chat's advisor Off could not be applied");
      }
    } catch (error) {
      console.warn(`[omp-web] could not apply the chat's advisor Off: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private buildWebState(state: RpcSessionState): WebSessionState {
    const wasRunning = this.isRunning();

    // Reconcile process-side flags with authoritative child state.
    this.applyIdentity({ ...state, sessionFile: state.sessionFile ?? this._sessionFile });
    this.streamSequence += 1;

    const awaitingExpired = !this.awaitingAgentStart || Date.now() >= this.awaitingAgentStartDeadline;
    const hasPendingWork =
      this.promptDispatchPendingCount > 0 ||
      this.historyEditInFlight ||
      (this.awaitingAgentStart && !awaitingExpired) ||
      this.mcpListWaiter !== null ||
      this.pendingUiRequests.size > 0 ||
      this.pendingHostTools.size > 0 ||
      this.pendingHostUris.size > 0;

    if (
      state.isStreaming === false &&
      state.isCompacting === false &&
      !hasPendingWork &&
      Date.now() >= this.continuationGraceUntil
    ) {
      this.promptRunning = false;
      this.awaitingAgentStart = false;
      this.awaitingAgentStartDeadline = 0;
      this.clearLiveSnapshots();
    }

    if (wasRunning && !this.isRunning()) {
      notifyRunningChange();
    }
    const skillDiagnostics = parseSkillDiagnosticsSnapshot(state.skillDiagnostics);
    return {
      sessionId: state.sessionId,
      sessionFile: state.sessionFile ?? "",
      sessionName: state.sessionName,
      isStreaming: state.isStreaming,
      isPromptRunning: this.promptRunning,
      isBashRunning: this.bashRunning,
      responseObserved: this.responseObserved,
      isCompacting: state.isCompacting,
      autoCompactionEnabled: state.autoCompactionEnabled,
      autoRetryEnabled: state.autoRetryEnabled,
      interruptMode: state.interruptMode,
      steeringMode: state.steeringMode,
      followUpMode: state.followUpMode,
      model: state.model
        ? {
            id: state.model.id,
            provider: state.model.provider,
            name: state.model.name,
            reasoning: state.model.reasoning,
            thinking: state.model.thinking ? { efforts: state.model.thinking.efforts } : undefined,
          }
        : undefined,
      messageCount: state.messageCount,
      queuedMessageCount: state.queuedMessageCount,
      queuedMessages: state.queuedMessages ?? { steering: [], followUp: [] },
      tokensPerSecond: state.tokensPerSecond ?? null,
      contextUsage: state.contextUsage ?? null,
      systemPrompt: state.systemPrompt?.join("\n\n") ?? "",
      thinkingLevel: state.thinkingLevel ?? "off",
      // The child's per-family tier map is authoritative: it changes when the
      // model switches families (isFastModeEnabled is family-scoped) or when
      // the runtime auto-disables priority (e.g. after an Anthropic reject).
      // The wrapper's own flag is only the spawn-time cache.
      fastModeEnabled: state.fastModeEnabled ?? state.fastMode ?? this.fastModeEnabled,
      fastModeActive: state.fastModeActive,
      slowModeSupported: state.slowModeSupported ?? false,
      slowModeEnabled: state.slowModeEnabled ?? false,
      slowModeScope: state.slowModeScope,
      usageLimit: state.usageLimit,
      ...(skillDiagnostics ? { skillDiagnostics } : {}),
      todoPhases: state.todoPhases ?? [],
      goal: state.goal ?? this.nativeGoalState,
      isSettled: state.isSettled,
      hasPendingAsyncWork: state.hasPendingAsyncWork,
      extensionStatuses: Array.from(this.extensionStatuses, ([key, text]) => ({ key, text })),
      extensionWidgets: Array.from(this.extensionWidgets.values()),
    };
  }

  private requireSkillDiagnostics(value: unknown): SkillDiagnosticsSnapshot {
    const snapshot = parseSkillDiagnosticsSnapshot(value);
    if (!snapshot) {
      throw new WebRpcError(
        "Skill diagnostics are unavailable for this OMP session",
        "skill_diagnostics_unsupported",
      );
    }
    return snapshot;
  }

  private async getStateWithTimeout(): Promise<RpcSessionState> {
    return this.proc.sendCommand<RpcSessionState>({ type: "get_state" }, GET_STATE_TIMEOUT_MS);
  }

  /** After branch/new_session/switch_session the child is on a different
   * session file — re-read identity and re-register in the registry. */
  private async refreshIdentityAfterSessionChange(): Promise<string> {
    const oldId = this._sessionId;
    const state = await this.getStateWithTimeout();
    this.applyIdentity(state);
    if (oldId && oldId !== this._sessionId) {
      this.recordIdentityChange(oldId, this._sessionId);
    }
    await this.waitIdentityPersistence();
    this.invalidateSessionLists();
    return this._sessionId;
  }

  private async editMessage(entryId: unknown): Promise<SessionEditResult> {
    if (typeof entryId !== "string" || !entryId.trim()) {
      throw new WebRpcError("The edit target must be a user message", "invalid_edit_target");
    }
    if (this.isRunning() || this.historyMutationPendingCount > 1) {
      throw new WebRpcError("Wait for the current operation to finish before editing", "session_busy");
    }

    // Set synchronously, before the first native query: a second tab must not
    // send a prompt, fork, or switch the process during either preflight await.
    this.historyEditInFlight = true;
    const proc = this.proc;
    const sessionId = this._sessionId;
    const sessionFile = this._sessionFile;
    let persistenceError: Error | null = null;
    // Keep observing through the authoritative post-edit state query as well
    // as the helper's reply/ack exchange. The ordinary notice path still emits
    // the native error to every observer.
    const unsubscribe = proc.onFrame((frame) => {
      if (frame.type === "notice" && frame.source === "session-persistence" && frame.level === "error") {
        persistenceError ??= new Error(typeof frame.message === "string" ? frame.message : "OMP could not persist the history edit");
      }
    });
    notifyRunningChange();
    try {
      const before = await this.getStateWithTimeout();
      if (persistenceError) throw persistenceError;
      if (before.sessionId !== sessionId || before.sessionFile !== sessionFile
        || this._sessionId !== sessionId || this._sessionFile !== sessionFile) {
        throw new WebRpcError("The session changed before the history edit", "session_changed");
      }
      if (typeof before.isSettled !== "boolean") {
        throw new WebRpcError("Editing history requires a newer OMP that reports full session settlement", "session_edit_unsupported");
      }
      if (!before.isSettled || before.hasPendingAsyncWork === true
        || before.isStreaming || before.isCompacting || before.queuedMessageCount > 0
        || this.promptRunning || this.streaming || this.compacting || this.bashRunning) {
        throw new WebRpcError("Wait for the current run to finish before editing", "session_busy");
      }

      const result = await editSessionHistory(proc, entryId, sessionId);
      const after = await this.getStateWithTimeout();
      if (persistenceError) throw persistenceError;
      const unchanged = after.sessionId === sessionId && after.sessionFile === sessionFile;
      // Only applyIdentity's native move path can retain the originating id.
      // A reply naming a different conversation is never sufficient evidence.
      const moved = this.movedFromIds.includes(sessionId) && after.sessionId !== sessionId;
      if (!this.isAlive() || this.proc !== proc || result.sessionId !== after.sessionId
        || (!unchanged && !moved) || this._sessionId !== after.sessionId || this._sessionFile !== after.sessionFile) {
        throw new WebRpcError("The session changed during the history edit", "session_changed");
      }
      if (result.cancelled) return result;

      this.clearLiveSnapshots();
      this.responseObserved = false;
      this.responseRunActive = false;
      this.awaitingAgentStart = false;
      this.awaitingAgentStartDeadline = 0;
      this.continuationGraceUntil = 0;
      // Invalidate the confirmed edited conversation, not its preserved source.
      this.invalidateSessionLists();
      this.emit({ type: "session_history_changed", leafId: result.leafId });
      notifyRunningChange({ refreshSessionList: true });
      return result;
    } catch (error) {
      if (error instanceof RpcCommandTimeoutError) {
        // A timed-out navigation may still be running in a hook. Do not let a
        // later mutation race it once the web-side fence is released.
        await this.destroyAndWait();
        if (persistenceError) throw persistenceError;
        throw new WebRpcError("The OMP session stopped responding and was reset.", "session_unresponsive");
      }
      if (error instanceof SessionEditAgentInvocationError && !error.agentStarted) {
        // Native /retry can acknowledge before its deferred agent_start. There
        // is no observed run to own that gap: stop it before releasing Edit.
        await this.destroyAndWait();
      }
      throw persistenceError ?? error;
    } finally {
      unsubscribe();
      this.historyEditInFlight = false;
      notifyRunningChange();
    }
  }

  /** Full restart of the child process against the same session file. This is
   * omp-web's `reload`: extensions, skills, prompts, and tools are rediscovered
   * on boot, matching a fresh CLI launch. */
  private async restart(goalContinuation = this.foxGoalContinuation): Promise<void> {
    if (this.restarting) throw new WebRpcError(RESTARTING_MESSAGE, "session_restarting");
    if (isFoxWorkspacePath(this.cwd) && (this.isRunning() || this.pendingHumanRequests() || this.historyEditInFlight || this.promptDispatchPendingCount > 0)) throw new WebRpcError("Wait for FOX to settle before restarting", "session_busy");
    const sessionFile = this._sessionFile;
    const resumable = !!sessionFile && existsSync(sessionFile);
    const old = this.proc;
    // Stays true for the whole restart so send() rejects commands that would
    // otherwise hit the disposed or half-built child.
    this.restarting = true;
    this.foxReportingAvailable = false;
    this.resetStream();
    this.streaming = false;
    this.promptRunning = false;
    this.compacting = false;
    this.unsubscribeFrames?.();
    try {
      this.expectedExitProc = old;
      try {
        await old.dispose();
      } finally {
        if (this.expectedExitProc === old) this.expectedExitProc = null;
      }
      if (!this._alive) return;

      this.extensionStatuses.clear();
      this.extensionWidgets.clear();
      this.foxDispatchReceipts.clear();
      this.clearPendingUiRequests();
      // Calls the old child made can never be answered: its pipes are gone. Left
      // in place they would keep isRunning() true for the new child.
      this.pendingHostTools.clear();
      for (const id of this.hostToolClaims.keys()) this.releaseHostToolClaim(id);
      this.pendingHostUris.clear();
      this.promptRunning = false;
      this.promptDispatchPendingCount = 0;
      this.awaitingAgentStart = false;
      this.awaitingAgentStartDeadline = 0;
      this.continuationGraceUntil = 0;
      this.bashRunning = false;
      this.streaming = false;
      this.compacting = false;
      const launchConfig = await launchConfigForCwd(this.cwd);
      const toolNames = this._toolNames ?? undefined;
      // A resumed session's preset is unknown (no --tools was passed at the
      // original resume); respawning with identical arguments keeps it unknown.
      const toolPreset = getToolPresetStatus(toolNames, launchConfig?.extraArgs, this._toolNames === null ? null : "full");
      const overlay = isFoxWorkspacePath(this.cwd) ? foxGoalOverlay(goalContinuation) : null;
      const proc = new RpcProcess({
        cwd: this.cwd,
        // Re-read per spawn so a restart picks up environment values the user
        // added in Settings after this session was created (#104).
        env: getAgentEnvOverrides(),
        extraArgs: [...buildSessionSpawnArgs(resumable ? sessionFile : "", toolNames, this._advisorChoice === "on", launchConfig, undefined, true), "--extension", SESSION_EDIT_EXTENSION_PATH, "--extension", FOX_REPORT_EXTENSION_PATH, "--extension", FOX_GOAL_EXTENSION_PATH, ...(isFoxWorkspacePath(this.cwd) ? ["--extension", FOX_NATIVE_EXTENSION_PATH, ...overlay!.args] : [])],
        onExit: (info) => {
          overlay?.cleanup();
          if (this.proc === proc) this.handleProcessExit(info, proc);
        },
      });
      this.proc = proc;
      this.foxGoalContinuation = Boolean(overlay && goalContinuation);
      this.foxGoalAvailable = false;
      this.unsubscribeFrames = proc.onFrame((frame) => this.handleFrame(frame));
      try {
        const ready = await proc.waitReady(READY_TIMEOUT_MS);
        await proc.negotiateProtocol(ready);
        // The replacement process starts with subscriptions disabled; restore
        // the live roster/transcript event stream before reading its state.
        await proc.sendCommand({ type: "set_subagent_subscription", level: "events" }).catch(() => {});
        await proc.sendCommand({ type: "set_ask_dialog", enabled: true }, GET_STATE_TIMEOUT_MS).catch(() => {});
        const state = await proc.sendCommand<RpcSessionState>({ type: "get_state" }, GET_STATE_TIMEOUT_MS);
        if (state.sessionFile && state.sessionFile !== sessionFile && sameNativeConversation(sessionFile, state.sessionFile)) this.sessionMovePending = true;
        this.applyIdentity(state);
        const catalog = await proc.sendCommand<{ commands?: RpcAvailableSlashCommand[] }>({ type: "get_available_commands" }, GET_STATE_TIMEOUT_MS).catch(() => null);
        this.foxGoalAvailable = Boolean(catalog?.commands?.some((command) => command.name === FOX_GOAL_COMMAND && command.source === "extension"));
        this.foxReportingAvailable ||= Boolean(catalog?.commands?.some((command) => command.name === FOX_REPORT_COMMAND && command.source === "extension"));
        // Same fresh-spawn guard as startRpcSession: a sessionless wrapper
        // restarts bare, and omp's startup resume handling could land it on the
        // cwd's most recent session. An on-disk session file is the resume
        // signal (fresh children report a not-yet-created path).
        if (!resumable && this._sessionFile && existsSync(this._sessionFile)) {
          await proc.sendCommand({ type: "new_session" });
          this.applyIdentity(await proc.sendCommand<RpcSessionState>({ type: "get_state" }, GET_STATE_TIMEOUT_MS));
        }
        await this.applyAdvisorChoiceAfterSpawn();
        if (goalContinuation && isFoxWorkspacePath(this.cwd)) {
          // Reattach captures the startup builtin set before dynamic host tools
          // exist. An explicit native pause clears that saved pre-goal set;
          // the later resume must capture the registered FOX tools instead.
          const paused = await proc.sendCommand<{ goal: NativeGoal | null; state: NativeGoalModeState | null }>({ type: "goal", op: "pause" }, GET_STATE_TIMEOUT_MS);
          if (!paused?.goal || paused.goal.status !== "paused") throw new Error("Native goal did not pause before restoring FOX host tools");
          this.nativeGoalState = paused.state;
        }
        // Restore registrations before goal resume; a granted FOX runtime must
        // never swallow this failure and start a turn with a partial catalog.
        if (this.hostToolDefinitions.length > 0) {
          if (isFoxWorkspacePath(this.cwd)) {
            const registered = await proc.sendCommand<{ toolNames?: string[] }>({ type: "set_host_tools", tools: this.hostToolDefinitions });
            if (!registered?.toolNames?.includes(FOX_GOAL_TOOL)
              || loadWebServerSettings().agentToolsEnabled && [...AGENT_TOOL_NAMES].some((name) => !registered.toolNames?.includes(name))) throw new Error("Native FOX host tool registration is incomplete");
          } else await proc.sendCommand({ type: "set_host_tools", tools: this.hostToolDefinitions }).catch(() => {});
        } else if (goalContinuation && isFoxWorkspacePath(this.cwd)) {
          throw new Error("Native FOX host tools were not registered before goal activation");
        }
        if (this.hostUriDefinitions.length > 0) {
          await proc.sendCommand({ type: "set_host_uri_schemes", schemes: this.hostUriDefinitions }).catch(() => {});
        }
        this._toolPreset = toolPreset;
      } catch (error) {
        // Never leave the replacement running with nobody reading its frames.
        this.unsubscribeFrames?.();
        this.unsubscribeFrames = null;
        void proc.dispose();
        // The wrapper has no usable child left; drop it from the registry so the
        // next request starts a fresh session instead of reusing a corpse.
        this.destroy();
        throw error;
      }
    } finally {
      this.restarting = false;
    }
    notifyRunningChange();
  }

  private async prepareFoxGoalUserTurn(): Promise<void> {
    if (!isFoxWorkspacePath(this.cwd) || !this.foxGoalAdmissionClosed && !this.foxGoalContinuation || this.isRunning() || this.isEditingHistory() || this.historyMutationPendingCount > 0) return;
    this.foxGoalExclusive = true;
    const controlVersion = this.foxGoalControlVersion;
    try {
      const state = await this.getStateWithTimeout();
      if (state.isSettled !== true || state.hasPendingAsyncWork || state.queuedMessageCount > 0) return;
      const snapshot = await this.getFoxGoalSnapshot();
      if (!snapshot.supported || snapshot.goal?.goal && snapshot.goal.goal.status !== "complete"
        || snapshot.grant && !snapshot.grant.revoked && snapshot.goal?.goal.status !== "complete") return;
      if (controlVersion !== this.foxGoalControlVersion) return;
      if (this.foxGoalContinuation) await this.restart(false);
      if (controlVersion === this.foxGoalControlVersion && (!this.foxGoalAdmissionClosed || this.foxGoalDurableControlVersion === controlVersion)) this.foxGoalAdmissionClosed = false;
    } finally { this.foxGoalExclusive = false; }
  }

  async send(command: Record<string, unknown>): Promise<unknown> {
    if (isFoxWorkspacePath(this.cwd)) await this.waitIdentityPersistence();
    if (this.restarting) throw new WebRpcError(RESTARTING_MESSAGE, "session_restarting");
    if (this.mcpListInFlight) throw new WebRpcError("MCP management is in progress. Try again when it finishes.", "session_busy");
    if (!this.isAlive()) throw new Error("Session is no longer running");
    if (["prompt", "steer", "follow_up", "abort_and_prompt", "bash"].includes(String(command.type))) resolveSpawnCwdResult(this.cwd);
    if (typeof command.type === "string" && command.type.startsWith("abort")) {
      console.info("[omp-web] cancellation-command", JSON.stringify({ sessionId: this._sessionId, type: command.type, at: new Date().toISOString() }));
    }
    const mutatesHistory = HISTORY_MUTATING_COMMANDS.has(command.type as string);
    if (mutatesHistory && this.foxGoalExclusive) throw new WebRpcError("FOX goal control is in progress", "session_busy");
    if (typeof command.message === "string" && command.message.trimStart().startsWith(`/${FOX_GOAL_COMMAND}`)) throw new Error("Internal FOX goal commands are not a public prompt API");
    const changesIdentity = command.type === "new_session" || command.type === "switch_session" || command.type === "fork";
    if (mutatesHistory && this.sessionTransitionInFlight || changesIdentity && (this.isRunning() || this.historyMutationPendingCount > 0)) {
      throw new WebRpcError("Wait for the current session operation to finish", "session_busy");
    }
    if (mutatesHistory && this.historyEditInFlight) {
      throw new WebRpcError("Wait for the history edit to finish", "session_busy");
    }
    if (command.type === "prompt" && isFoxWorkspacePath(this.cwd) && (this.foxGoalAdmissionClosed || this.foxGoalContinuation)) await this.prepareFoxGoalUserTurn();
    if (mutatesHistory) this.historyMutationPendingCount += 1;
    if (changesIdentity) this.sessionTransitionInFlight = true;
    this.resetIdleTimer();
    // Covers the whole command, including the awaits inside it: a route that
    // has an unwatched session in mid-command (predict_word on a keystroke, an
    // export, a follow-up) must never have its child reaped underneath it.
    this.pendingCommands += 1;
    try {
      if (mutatesHistory && this.foxReportInbox) await this.foxReportInbox.catch(() => {});
      if (!this.isAlive()) throw new Error("Session is no longer running");
      if (changesIdentity && isFoxWorkspacePath(this.cwd) && this.foxGoalAvailable) {
        const snapshot = await this.getFoxGoalSnapshot();
        if (!snapshot.supported) throw new Error(snapshot.reason ?? "Native goal history cannot be verified");
        if (snapshot.grant && !snapshot.grant.revoked && (snapshot.goal?.goal.status !== "complete"
          || snapshot.assignments.some((assignment) => !["settled", "closed"].includes(assignment.state)))) {
          throw new Error("Stop or reset the authorized FOX goal, or wait for delivery, before changing conversations. Pause does not revoke its scope.");
        }
        if (this.foxGoalContinuation) await this.restart(false);
      }
      const result = await this.dispatchCommand(command);
      if (changesIdentity && isFoxWorkspacePath(this.cwd) && this.foxGoalAvailable) {
        const inherited = await this.getFoxGoalSnapshot();
        const native = await this.nativeGoal("get");
        if (native.goal && inherited.inheritedGoalIds?.includes(native.goal.id)) await this.nativeGoal("pause");
      }
      return result;
    } finally {
      this.pendingCommands = Math.max(0, this.pendingCommands - 1);
      if (mutatesHistory) this.historyMutationPendingCount -= 1;
      if (changesIdentity) this.sessionTransitionInFlight = false;
    }
  }

  private async dispatchCommand(command: Record<string, unknown>): Promise<unknown> {
    const type = command.type as string;

    if (IMAGE_BEARING_COMMANDS.has(type)) {
      const imageError = validateAgentImages(command.images);
      if (imageError) throw new Error(imageError);
    }

    const unsupported = UNSUPPORTED_COMMANDS[type];
    if (unsupported) throw new RpcCommandError(type, unsupported, "unsupported");

    switch (type) {
      case "prompt": {
        // A `!!` shell command owns the session until it exits (omp rejects a
        // prompt then, and treating that as a hard error tore down the client's
        // optimistic turn and lost the message). Degrade into omp's own
        // follow-up queue instead: omp keeps owning the chips and delivers the
        // message once the shell command releases the session.
        if (this.bashRunning) return await this.queueWhileShellRunning(command);
        const streamingBehavior = command.streamingBehavior as "steer" | "followUp" | undefined;
        if (!streamingBehavior) {
          this.responseObserved = false;
          this.responseRunActive = false;
          if (!this.isRunning()) this.clearLiveSnapshots();
          this.streamSequence += 1;
          this.promptRunning = true;
          this.promptDispatchPendingCount += 1;
          this.awaitingAgentStart = false;
          this.awaitingAgentStartDeadline = 0;
          this.continuationGraceUntil = 0;
          notifyRunningChange();
        }
        try {
          // omp acks immediately; agent output streams as events, completion is
          // agent_end (agent runs) or prompt_result (local-only slash commands).
          const ack = await this.proc.sendCommand<{ agentInvoked?: boolean } | undefined>({
            type: "prompt",
            message: command.message as string,
            ...(toImageContents(command.images) ? { images: toImageContents(command.images) } : {}),
            ...(streamingBehavior ? { streamingBehavior } : {}),
          }, PROMPT_ACK_TIMEOUT_MS);
          // Slash commands fully consumed by a builtin report agentInvoked:false
          // in the ack itself — no prompt_result frame follows.
          if (ack?.agentInvoked === false && !streamingBehavior) {
            this.promptRunning = false;
            this.awaitingAgentStart = false;
            this.awaitingAgentStartDeadline = 0;
            this.emit({ type: "prompt_result", agentInvoked: false });
            notifyRunningChange();
          } else if (!streamingBehavior && ack?.agentInvoked !== false) {
            // OMP acked but agent hasn't started yet — keep promptRunning alive
            // until agent_start arrives (or a timeout expires).
            this.awaitingAgentStart = true;
            this.awaitingAgentStartDeadline = Date.now() + AWAITING_AGENT_START_TIMEOUT_MS;
          }
        } catch (error) {
          this.promptRunning = false;
          this.awaitingAgentStart = false;
          this.awaitingAgentStartDeadline = 0;
          this.streaming = false;
          this.clearLiveSnapshots();
          notifyRunningChange();
          if (error instanceof RpcCommandTimeoutError) {
            // The child took the frame but never acked it, so nothing will ever
            // report this run: recycle the unacknowledged prompt. A read-only
            // get_state timeout deliberately does not take this destructive path.
            await this.destroyAndWait();
            throw new WebRpcError("The OMP session stopped responding and was reset.", "session_unresponsive");
          }
          throw error;
        } finally {
          if (!streamingBehavior) {
            this.promptDispatchPendingCount = Math.max(0, this.promptDispatchPendingCount - 1);
          }
        }
        return null;
      }

      case "steer":
      case "follow_up": {
        // `steer` has the same collision while a `!!` shell command runs — and
        // there is no live turn to steer anyway, so it joins the follow-up
        // queue like a prompt would.
        if (type === "steer" && this.bashRunning) return await this.queueWhileShellRunning(command);
        await this.proc.sendCommand({
          type,
          message: command.message as string,
          ...(toImageContents(command.images) ? { images: toImageContents(command.images) } : {}),
        });
        return null;
      }

      case "remove_queued_message":
      case "promote_queued_message": {
        // Queue mutations are synchronous control operations, like get_state.
        // Expiry must not abort unrelated work or replay a possibly applied mutation.
        const result = await this.proc.sendCommand(command as { type: string }, GET_STATE_TIMEOUT_MS);
        return result ?? null;
      }

      // abort_and_restore_queue is omp's Esc: it takes queued user input back
      // atomically, then aborts, and returns the withdrawn messages.
      case "abort":
      case "abort_and_restore_queue": {
        this.responseObserved = false;
        this.responseRunActive = false;
        const result = await this.withFinalRunningNotification(async () => {
          const response: unknown = await this.proc.sendCommand({ type });
          // If the prompt was aborted before the agent loop started, no
          // agent_end will arrive to clear the flag; the streaming flag still
          // tracks a live turn that ends with its own agent_end.
          this.promptRunning = false;
          // Clear the pending-start bookkeeping too: hasPendingWork would
          // otherwise suppress stale-state reconciliation for the full
          // AWAITING_AGENT_START_TIMEOUT_MS, leaving the UI showing "running"
          // after an early abort.
          this.awaitingAgentStart = false;
          this.awaitingAgentStartDeadline = 0;
          this.continuationGraceUntil = 0;
          this.clearLiveSnapshots();
          return response;
        });
        return type === "abort" ? null : result ?? null;
      }

      case "get_state": {
        try {
          const state = await this.proc.sendCommand<RpcSessionState>({ type: "get_state" }, GET_STATE_TIMEOUT_MS);
          return this.buildWebState(state);
        } catch (error) {
          if (error instanceof RpcCommandTimeoutError) {
            // This is only an observer poll. A busy event loop or delayed RPC
            // response is not authority to stop generation or a pending tool.
            console.warn("[omp-web] status-query-timeout", JSON.stringify({ sessionId: this._sessionId, timeoutMs: GET_STATE_TIMEOUT_MS, running: this.isRunning(), action: "preserved", at: new Date().toISOString() }));
            throw new WebRpcError("The OMP status query timed out. The session was left running; retry shortly.", "session_state_timeout");
          }
          throw error;
        }
      }

      case "get_skill_diagnostics": {
        const result = await this.proc.sendCommand<unknown>({ type: "get_skill_diagnostics" }, GET_STATE_TIMEOUT_MS);
        return this.requireSkillDiagnostics(result);
      }

      case "set_skill_startup_diagnostics": {
        if (typeof command.enabled !== "boolean") {
          throw new WebRpcError("enabled must be a boolean", "invalid_skill_startup_diagnostics");
        }
        const result = await this.proc.sendCommand<unknown>({
          type: "set_skill_startup_diagnostics",
          enabled: command.enabled,
        }, GET_STATE_TIMEOUT_MS);
        return this.requireSkillDiagnostics(result);
      }

      case "set_model": {
        const { provider, modelId } = command as { provider: string; modelId: string };
        const model = await this.proc.sendCommand<OmpModel>({ type: "set_model", provider, modelId });
        invalidateModelsCache();
        this.invalidateSessionLists();
        return { id: model.id, provider: model.provider };
      }

      case "set_fast_mode": {
        const enabled = command.enabled === true;
        const result = await this.proc.sendCommand<{ enabled?: boolean; active?: boolean }>({ type: "set_fast_mode", enabled });
        this.fastModeEnabled = result?.enabled ?? enabled;
        return { enabled: this.fastModeEnabled, active: result?.active ?? false };
      }

      case "set_slow_mode": {
        const enabled = command.enabled === true;
        const result = await this.proc.sendCommand<{ enabled?: boolean }>({ type: "set_slow_mode", enabled });
        return { enabled: result?.enabled ?? enabled };
      }

      case "edit_message":
        return this.editMessage(command.entryId);

      case "fork": {
        // omp's `branch` is pi-web's fork: it creates a branched session file
        // and switches this live process onto it (entryId must be a user
        // message entry, matching the web UI's fork buttons).
        if (this.bashRunning) {
          throw new Error("Cannot fork while a shell command is running");
        }
        const result = await this.proc.sendCommand<{ text: string; cancelled: boolean }>({
          type: "branch",
          entryId: command.entryId as string,
        });
        if (result.cancelled) return { cancelled: true };
        const newSessionId = await this.refreshIdentityAfterSessionChange();
        // `text` is the branched prompt omp hands back for edit-and-resend.
        return { cancelled: false, newSessionId, text: result.text };
      }

      case "new_session":
      case "switch_session": {
        const result = await this.proc.sendCommand<{ cancelled: boolean }>(command as { type: string });
        if (!result.cancelled) {
          const newSessionId = await this.refreshIdentityAfterSessionChange();
          const parent = type === "new_session" && typeof command.parentSession === "string" ? readSessionHeader(command.parentSession) : null;
          this.unpersistedFoxWorkerId = parent && isFoxWorkspacePath(parent.cwd) ? newSessionId : null;
          if (this.hostToolDefinitions.length) await this.send({ type: "set_host_tools", tools: this.hostToolDefinitions });
          return { cancelled: false, newSessionId };
        }
        return result;
      }

      case "compact": {
        try {
          return await this.withFinalRunningNotification(async () => {
            this.compacting = true;
            this.streamSequence += 1;
            notifyRunningChange();
            try {
              const result = await this.proc.sendCommand<CompactionResultLike>({
                type: "compact",
                ...(command.customInstructions ? { customInstructions: command.customInstructions } : {}),
              });
              patchEstimatedTokensAfter(result);
              return result;
            } finally {
              this.compacting = false;
              this.streamSequence += 1;
            }
          });
        } finally {
          this.invalidateSessionLists();
        }
      }

      case "abort_compaction":
        // No dedicated RPC command; a plain abort cancels the in-flight turn
        // including compaction work.
        await this.withFinalRunningNotification(() => this.proc.sendCommand({ type: "abort" }));
        return null;

      case "set_session_name": {
        if (typeof command.name !== "string") throw new WebRpcError("Session name must be a string", "invalid_request");
        const name = command.name.trim();
        if (!name) throw new WebRpcError("Session name cannot be empty", "invalid_request");
        await this.proc.sendCommand({ type: "set_session_name", name });
        this._sessionName = name;
        this.invalidateSessionLists();
        return null;
      }

      case "get_session_stats": {
        const stats = await this.proc.sendCommand<Omit<SessionStatsInfo, "sessionName">>({ type: "get_session_stats" });
        return { ...stats, sessionName: this._sessionName };
      }

      case "get_last_assistant_text": {
        const data = await this.proc.sendCommand<{ text: string | null }>({ type: "get_last_assistant_text" });
        return { text: data.text ?? "" };
      }

      case "get_commands": {
        const data = await this.proc.sendCommand<{ commands: RpcAvailableSlashCommand[] }>({
          type: "get_available_commands",
        });
        return { ...data, commands: data.commands.filter((command) => command.name !== SESSION_EDIT_COMMAND && command.name !== FOX_REPORT_COMMAND) };
      }

      case "reload": {
        await this.restart();
        return { success: true };
      }

      case "extension_ui_response": {
        const { id, ...rest } = command as { id: string; [key: string]: unknown };
        const pendingAsk = this.pendingUiRequests.get(id)?.method === "ask";
        // A pending ask accepts only its answers or a cancel; anything else would
        // drop it from reconnect replay while omp rejects the payload.
        if (("answers" in rest || pendingAsk) && !isAskAnswers(rest.answers) && !(pendingAsk && rest.cancelled === true)) {
          throw new WebRpcError("Invalid ask dialog answers", "invalid_ask_answers");
        }
        const wasPending = this.pendingUiRequests.has(id);
        this.forgetPendingUiRequest(id);
        this.proc.sendFrame({ type: "extension_ui_response", id, ...rest });
        // omp sends no cancel for an answered dialog; other tabs on this
        // session would keep showing it, so settle it for them here.
        if (wasPending) {
          this.emit({ type: "extension_ui_request", id: `cancel:${id}`, method: "cancel", targetId: id });
          this.settleInputNotification();
        }
        return null;
      }

      case "bash": {
        // omp's RPC bash command is `{type:"bash", command}` only (rpc-types.ts)
        // — there is no excludeFromContext option anywhere in modes/rpc. Running
        // a `!!` command anyway would put output the user meant to keep private
        // into the model context, so refuse instead of silently ignoring it.
        if (command.excludeFromContext === true) {
          throw new WebRpcError(BASH_EXCLUDE_MESSAGE, "bash_exclude_unsupported");
        }
        if (this.isRunning()) {
          throw new Error("Cannot run a shell command while the session is busy");
        }
        this.bashRunning = true;
        notifyRunningChange();
        try {
          return await this.proc.sendCommand<BashResultInfo>({ type: "bash", command: command.command as string });
        } finally {
          this.bashRunning = false;
          this.invalidateSessionLists();
          notifyRunningChange();
        }
      }

      case "set_host_tools": {
        const tools = hostRegistrationEntries(command.tools, "tools") as Array<{ name?: unknown; [key: string]: unknown }>;
        const worker = this.foxReportingAvailable && (this.unpersistedFoxWorkerId === this.sessionId || Boolean(foxWorkerParent(this.sessionFile)));
        const valid = tools.filter((t) => typeof t.name === "string" && t.name && t.name !== "notify" && t.name !== FOX_REPORT_TOOL && t.name !== FOX_GOAL_TOOL && (!worker || !AGENT_TOOL_NAMES.has(t.name)));
        // Merge the server agent tools (#275) into every registration when
        // the gate is on, so a later UI registration cannot drop them and
        // a no-tab session keeps them after its startup registration.
        // With the gate off the registration is exactly what the caller
        // asked for, so existing behavior and tests are unchanged.
        const merged = !worker && loadWebServerSettings().agentToolsEnabled
          ? [...valid, ...AGENT_TOOL_DEFINITIONS.filter((t) => !valid.some((v) => v.name === t.name))]
          : valid;
        if (worker) merged.push(FOX_REPORT_TOOL_DEFINITION);
        if (isFoxWorkspacePath(this.cwd)) merged.push(FOX_GOAL_TOOL_DEFINITION);
        this.hostToolNames = new Set(merged.map((t) => t.name as string));
        this.hostToolDefinitions = merged;
        await this.proc.sendCommand({ type: "set_host_tools", tools: merged });
        return null;
      }

      case "claim_host_tool": {
        const id = typeof command.id === "string" ? command.id : "";
        if (!this.pendingHostTools.has(id) || this.hostToolClaims.has(id)) return { token: null };
        const token = randomUUID();
        // Never hand the same side effect to another tab after an uncertain
        // delivery. A disappeared claimant fails the call rather than replaying.
        const timer = setTimeout(() => {
          this.releaseHostToolClaim(id);
          if (!this.pendingHostTools.delete(id)) return;
          this.proc.sendFrame({ type: "host_tool_result", id, isError: true, result: { content: [{ type: "text", text: "The browser did not confirm this action; it was not retried." }] } });
          notifyRunningChange();
        }, 30_000);
        timer.unref?.();
        this.hostToolClaims.set(id, { token, timer });
        return { token };
      }

      case "host_tool_result": {
        const id = typeof command.id === "string" ? command.id : "";
        const claim = this.hostToolClaims.get(id);
        if (!claim || command.claimToken !== claim.token || !this.pendingHostTools.delete(id)) return null;
        this.releaseHostToolClaim(id);
        const result = { ...command };
        delete result.claimToken;
        this.proc.sendFrame(result as { type: string; [key: string]: unknown });
        notifyRunningChange();
        return null;
      }

      case "set_host_uri_schemes": {
        const schemes = hostRegistrationEntries(command.schemes, "schemes") as Array<{ scheme?: unknown; writable?: unknown; [key: string]: unknown }>;
        this.hostUriSchemes = new Map();
        for (const entry of schemes) {
          if (typeof entry.scheme === "string" && entry.scheme) {
            this.hostUriSchemes.set(entry.scheme, { writable: entry.writable === true });
          }
        }
        this.hostUriDefinitions = schemes;
        await this.proc.sendCommand({ type: "set_host_uri_schemes", schemes });
        return null;
      }

      case "host_uri_result": {
        if (typeof command.id === "string") this.pendingHostUris.delete(command.id);
        this.proc.sendFrame(command as { type: string; [key: string]: unknown });
        return null;
      }

      default: {
        if (PASSTHROUGH_COMMANDS.has(type)) {
          if (type === "abort_and_prompt") {
            this.responseObserved = false;
            this.responseRunActive = false;
            this.streamSequence += 1;
          }
          const result: unknown = await this.proc.sendCommand(
            command as { type: string },
            type === "predict_word" ? PREDICT_WORD_TIMEOUT_MS : undefined,
          );
          if (type === "set_thinking_level") this.invalidateSessionLists();
          return result ?? null;
        }
        throw new Error(`Unsupported command: ${type}`);
      }
    }
  }

  /**
   * Degrade a prompt/steer frame into omp's follow-up queue while omp-web's own
   * `!!` shell command owns the child (`bashRunning`, set for the whole `bash`
   * RPC). omp would refuse a prompt then — and aborting or erroring loses the
   * user's message mid-task — so the message is forwarded as `follow_up`
   * instead: the queue stays omp-owned (its `queue_update`/`get_state`
   * snapshots feed every client's chips) and omp delivers the message after the
   * shell command finishes, exactly as a queued follow-up sent during a run.
   * The reply carries the degradation so the client can tell the user their
   * message was queued, not steered.
   */
  private async queueWhileShellRunning(command: Record<string, unknown>): Promise<unknown> {
    const images = toImageContents(command.images);
    await this.proc.sendCommand({
      type: "follow_up",
      message: command.message as string,
      ...(images ? { images } : {}),
    });
    return { queued: true, queue: "followUp", reason: "shellRunning" };
  }

  destroy(reason = "unspecified"): void {
    void this.destroyAndWait(reason);
  }

  /** Destroy and resolve only after the omp child has fully exited. Callers
   * that delete the session file afterwards must await this — omp flushes
   * session state on shutdown and would otherwise recreate the file. */
  async destroyAndWait(reason = "unspecified"): Promise<void> {
    // Re-entrant calls join the in-flight dispose; without this a new spawn
    // can overlap the old child's shutdown (see startRpcSession).
    if (this.destroyPromise) return this.destroyPromise;
    if (!this._alive) return;
    console.info("[omp-web] session-dispose", JSON.stringify({ sessionId: this._sessionId, reason, running: this.isRunning(), pendingDialogs: this.pendingUiRequests.size, at: new Date().toISOString(), caller: new Error().stack?.split("\n").slice(2, 5).map((line) => line.trim()) }));
    this._alive = false;
    this.foxDispatchReceipts.clear();
    for (const reject of this.foxGoalWaiters) reject(new Error("FOX runtime closed before native goal acknowledgement"));
    this.foxGoalWaiters.clear();
    this.streaming = false;
    this.promptRunning = false;
    this.compacting = false;
    this.responseObserved = false;
    this.responseRunActive = false;
    this.clearLiveSnapshots();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.reapTimer) {
      clearTimeout(this.reapTimer);
      this.reapTimer = null;
    }
    if (this.sessionFileSignalTimer) {
      clearTimeout(this.sessionFileSignalTimer);
      this.sessionFileSignalTimer = null;
    }
    this.unsubscribeFrames?.();
    this.clearPendingUiRequests();
    this.promptDispatchPendingCount = 0;
    this.awaitingAgentStart = false;
    this.awaitingAgentStartDeadline = 0;
    this.continuationGraceUntil = 0;
    if (this.mcpListWaiter) {
      clearTimeout(this.mcpListWaiter.timer);
      this.mcpListWaiter.reject(new Error("Session was closed while loading MCP servers"));
      this.mcpListWaiter = null;
    }
    for (const rejectWaiter of [...this.turnWaiters]) rejectWaiter(new Error("Session was closed while waiting for the response"));
    const disposed = this.proc.dispose().catch(() => {});
    this.destroyPromise = disposed;
    this.pendingHostTools.clear();
    for (const id of this.hostToolClaims.keys()) this.releaseHostToolClaim(id);
    this.hostToolNames.clear();
    this.hostToolDefinitions = [];
    this.pendingHostUris.clear();
    this.hostUriSchemes.clear();
    this.hostUriDefinitions = [];
    notifyRunningChange();
    await disposed;
    this.onDestroyCallback?.();
  }
}

// ============================================================================
// Session registry
// ============================================================================
export interface RunningRpcSession {
  id: string;
  cwd: string;
}

export interface RunningSessionUpdate {
  ids: string[];
  runningSessions: RunningRpcSession[];
  exitedSessions: ExitedRpcSession[];
  refreshSessionList: boolean;
}


declare global {
  var __ompSessions: Map<string, AgentSessionWrapper> | undefined;
  var __ompStartLocks: Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> | undefined;
  var __ompRunningListeners: Set<(update: RunningSessionUpdate) => void> | undefined;
  var __ompHostToolListeners: Set<(call: CrossSessionHostToolCall) => void> | undefined;
  var __ompExitedSessions: Map<string, ExitedRpcSession> | undefined;
}

function getExitedMap(): Map<string, ExitedRpcSession> {
  if (!globalThis.__ompExitedSessions) globalThis.__ompExitedSessions = new Map();
  return globalThis.__ompExitedSessions;
}

export function getExitedRpcSessions(): ExitedRpcSession[] {
  return [...getExitedMap().values()];
}

export function getExitedRpcSession(sessionId: string): ExitedRpcSession | undefined {
  return getExitedMap().get(sessionId);
}

/** Clear the visible crash state once a replacement child is ready. */
export function clearExitedRpcSession(sessionId: string): boolean {
  const cleared = getExitedMap().delete(sessionId);
  if (cleared) notifyRunningChange();
  return cleared;
}

function getRegistry(): Map<string, AgentSessionWrapper> {
  if (!globalThis.__ompSessions) {
    globalThis.__ompSessions = new Map();
    const cleanup = () => {
      // Children dying from here on are the shutdown, not finished runs.
      markShuttingDown();
      globalThis.__ompSessions?.forEach((s) => s.destroy());
    };
    process.once("exit", cleanup);
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  }
  return globalThis.__ompSessions;
}

function getLocks(): Map<string, Promise<{ session: AgentSessionWrapper; realSessionId: string }>> {
  if (!globalThis.__ompStartLocks) globalThis.__ompStartLocks = new Map();
  return globalThis.__ompStartLocks;
}

/**
 * Legacy approvals are historical records, never authorizations for a new
 * execution. Native tool hooks now own the confirmation lifecycle; callers
 * cannot bypass them by replaying an old browser approval.
 */
export async function executeApprovedFoxAction(action: {
  toolName: string;
  args: Record<string, unknown>;
  sourceSessionId: string;
  sourceCwd: string;
}): Promise<unknown> {
  throw new Error(`Legacy approval for ${action.toolName} cannot execute. Ask FOX in the current conversation instead.`);
}

export function getRpcSession(sessionId: string): AgentSessionWrapper | undefined {
  return getRegistry().get(sessionId);
}

/** Permission fence before awaiting the durable active-conversation pointer. */
export function closeFoxGoalAdmissions(): void {
  for (const wrapper of new Set(getRegistry().values())) {
    if (isFoxWorkspacePath(wrapper.cwd)) wrapper.closeFoxGoalAdmission();
  }
}

export function getRunningRpcSessions(): RunningRpcSession[] {
  const map = new Map<string, string>();
  for (const [sessionId, session] of getRegistry()) {
    if (session.isRunning()) {
      const realId = session.sessionId || sessionId;
      map.set(realId, session.cwd);
    }
  }
  return [...map.entries()].map(([id, cwd]) => ({ id, cwd }));
}

export function getRunningRpcSessionIds(): string[] {
  return getRunningRpcSessions().map((s) => s.id);
}

export interface LiveRpcSessionState {
  id: string;
  running: boolean;
  pendingInput: number;
  pendingInputDetail: string | null;
  lastRunError: string | null;
}

/**
 * Every live wrapper, including idle children kept for a fast resume. The
 * briefing uses this instead of getRunningRpcSessions() so a failed run that
 * has already settled (running=false) is still visible without notification
 * history.
 */
export function getLiveRpcSessionStates(): LiveRpcSessionState[] {
  const states = new Map<string, LiveRpcSessionState>();
  for (const [key, session] of getRegistry()) {
    if (!session.isAlive()) continue;
    const id = session.sessionId || key;
    states.set(id, {
      id,
      running: session.isRunning(),
      pendingInput: session.pendingHumanRequests(),
      pendingInputDetail: session.pendingHumanRequestDetail(),
      lastRunError: session.lastRunErrorMessage(),
    });
  }
  return [...states.values()];
}

/** Stop all live omp children after an explicit runtime update. The browser will
 * reconnect sessions on demand and start them with the updated executable. */
export async function restartAllRpcSessions(): Promise<number> {
  const sessions = [...new Set(getRegistry().values())];
  await Promise.all(sessions.map((session) => session.destroyAndWait()));
  return sessions.length;
}

// ----------------------------------------------------------------------------
// Running-status broadcaster
//
// Pushes the current set of running session ids to subscribers whenever any
// session's running state may have changed. This lets the sidebar receive live
// updates over SSE instead of polling. Listeners live on globalThis so they
// survive Next.js hot-reload.
// ----------------------------------------------------------------------------

function getRunningListeners(): Set<(update: RunningSessionUpdate) => void> {
  if (!globalThis.__ompRunningListeners) globalThis.__ompRunningListeners = new Set();
  return globalThis.__ompRunningListeners;
}

/** Subscribe to running-session-id changes and session-list refreshes. */
export function subscribeRunningSessions(listener: (update: RunningSessionUpdate) => void): () => void {
  const listeners = getRunningListeners();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// ----------------------------------------------------------------------------
// Cross-session host tool calls
//
// A registered host tool called while no tab watches its session goes to every
// open omp-web tab (over the `host-tools` event-stream channel) instead of being rejected.
// ----------------------------------------------------------------------------

function getHostToolListeners(): Set<(call: CrossSessionHostToolCall) => void> {
  if (!globalThis.__ompHostToolListeners) globalThis.__ompHostToolListeners = new Set();
  return globalThis.__ompHostToolListeners;
}

/** Subscribe to host tool calls for sessions no tab is currently watching. */
export function subscribeHostToolCalls(listener: (call: CrossSessionHostToolCall) => void): () => void {
  const listeners = getHostToolListeners();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      for (const session of getRegistry().values()) session.rejectCrossSessionHostTools();
    }
  };
}

// Starts at the empty state so an idle server never broadcasts "nothing changed".
let lastRunningSnapshot = "[[],[],[]]";

/**
 * Recompute the running-session-id set and, when it changes, broadcast it.
 * A session file may first appear after its id starts running, so callers can
 * force one otherwise-identical update to refresh sidebar session metadata.
 */
export function notifyRunningChange({ refreshSessionList = false }: { refreshSessionList?: boolean } = {}): void {
  const runningSessions = getRunningRpcSessions();
  const exitedSessions = getExitedRpcSessions();
  const ids = runningSessions.map((s) => s.id);
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  const snapshot = JSON.stringify([runningSessions.slice().sort(byId), exitedSessions.slice().sort(byId), getLiveRpcSessionStates().sort(byId)]);
  if (snapshot === lastRunningSnapshot && !refreshSessionList) return;
  lastRunningSnapshot = snapshot;
  syncInterruptibleSessions();
  const update: RunningSessionUpdate = { ids, runningSessions, exitedSessions, refreshSessionList };
  for (const listener of getRunningListeners()) {
    try { listener(update); } catch { /* ignore listener errors */ }
  }
}

/** Record which sessions are mid-run, for resume after a restart. */
export function syncInterruptibleSessions(): void {
  const registry = getRegistry();
  const running = new Map<string, { id: string; advisor: AdvisorChoice }>();
  for (const session of registry.values()) {
    if (session.sessionId && session.isRunning()) running.set(session.sessionId, { id: session.sessionId, advisor: session.advisorChoice });
  }
  recordRunningSessions([...running.values()], (id) => registry.get(id)?.isAlive() === true);
}

/**
 * Restart the sessions that were mid-run when omp-web last stopped and ask
 * each to continue. Only runs when the auto-resume setting is on.
 */
export async function resumeInterruptedSessions(): Promise<void> {
  await Promise.all(takeInterruptedSessions().map(async ({ id, advisor }) => {
    try {
      const filePath = await resolveSessionPath(id);
      if (!filePath) return;
      const header = readSessionHeader(filePath);
      const { cwd } = resolveSpawnCwdResult(header?.cwd);
      if (isFoxWorkspacePath(cwd) || foxWorkerParent(filePath)) {
        const journal = await readFoxGoalJournal(filePath);
        if (journal.entries.some((entry) => entry.customType === "fox-goal" || entry.customType === "fox-goal-worker")) return;
      }
      const { session } = await startRpcSession(id, filePath, cwd, undefined, advisor, header?.cwd);
      await session.send({ type: "prompt", message: RESUME_PROMPT });
      console.log(`[omp-web] resumed interrupted session ${id}`);
    } catch (error) {
      console.warn(`[omp-web] could not resume session ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }));
}

/** Look up the workspace-registered launch config; unregistered projects attach none. */
export async function launchConfigForCwd(cwd: string): Promise<ProjectLaunchConfig | undefined> {
  let canonical = cwd;
  try { canonical = realpathSync(cwd); } catch {}
  const key = comparableProjectPath(canonical);
  return (await loadProjectRegistry()).projects.find((project) => {
    if (project.hidden) return false;
    const projectKey = comparableProjectPath(project.path);
    return projectKey === key || key.startsWith(`${projectKey}-worktrees/`);
  })?.launchConfig;
}

/**
 * FOX sessions created before the dispatch policy have the full toolset. They
 * must not be reused: a live wrapper keeps its old system prompt and tools, so
 * the next prompt would still edit projects directly. Project sessions are
 * never affected.
 */
function needsFoxToolPolicyRestart(wrapper: AgentSessionWrapper): boolean {
  return isFoxWorkspacePath(wrapper.cwd) && !isFoxToolPolicy(wrapper.toolNames);
}

/**
 * Get or create the omp RPC process for the given session.
 * For new sessions (sessionFile === ""), omp generates its own id.
 * Pass toolNames to pre-configure the builtin toolset of a NEW session
 * (empty array = all tools disabled); ignored when resuming.
 */
declare global {
  var __ompAgentToolGuard: AgentToolGuard | undefined;
}

/** Process-wide loop/spam guard for server agent tools (#275). Stored on
 * globalThis like the session registry so a hot reload does not silently
 * reset the chain depths mid-loop. */
function getAgentToolGuard(): AgentToolGuard {
  if (!globalThis.__ompAgentToolGuard) globalThis.__ompAgentToolGuard = new AgentToolGuard();
  return globalThis.__ompAgentToolGuard;
}

/** The slice of AgentSessionWrapper a delivery needs; tests pass a fake. */
export interface AgentToolDeliveryTarget {
  isRunning(): boolean;
  waitForTurnEnd(timeoutMs: number, terminalEndsNeeded?: number): Promise<void>;
  send(command: Record<string, unknown>): Promise<unknown>;
}

/** RPC command behind each tool-facing delivery name (dispatchCommand only knows `follow_up`). */
const DELIVERY_COMMAND_TYPES = { prompt: "prompt", steer: "steer", followUp: "follow_up" } as const;

/**
 * Deliver one agent-tool message to a live session wrapper. The waiter is
 * registered BEFORE the send so a fast turn cannot end first. When the send
 * throws, nothing awaits the waiter any more; its later timeout or
 * prompt_error rejection would surface as an unhandledRejection (the server
 * exits on those), so it is marked handled up front. The success path still
 * awaits it and sees its rejection normally.
 */
export async function deliverToSession(
  wrapper: AgentToolDeliveryTarget,
  input: AgentToolDeliverInput,
): Promise<AgentToolDeliverResult> {
  const wasRunning = wrapper.isRunning();
  if (input.delivery === "prompt" && wasRunning) {
    throw new Error("Target session is running; use delivery \"steer\" or \"followUp\" for a running target.");
  }
  if (input.delivery === "steer" && !wasRunning) {
    throw new Error("Target session is not running; use delivery \"prompt\" to start a turn.");
  }
  const terminalEndsNeeded = input.delivery === "followUp" && wasRunning ? 2 : 1;
  const waiter = input.wait ? wrapper.waitForTurnEnd(input.waitTimeoutMs, terminalEndsNeeded) : null;
  void waiter?.catch(() => {});
  await wrapper.send({ type: DELIVERY_COMMAND_TYPES[input.delivery], message: input.message });
  if (!waiter) {
    return { accepted: true, targetSessionId: input.sessionId, delivery: input.delivery, waited: false, responseText: null };
  }
  await waiter;
  const last = (await wrapper.send({ type: "get_last_assistant_text" })) as { text?: unknown } | null;
  return {
    accepted: true,
    targetSessionId: input.sessionId,
    delivery: input.delivery,
    waited: true,
    responseText: typeof last?.text === "string" ? last.text : null,
  };
}

/**
 * Real session operations behind lib/agent-tools executeAgentTool.
 * Reuses the existing spawn/resume and message-send paths (startRpcSession,
 * wrapper.send) instead of a second session engine. Delivery rules, kept
 * explicit because omp's commands do not all make sense in every state:
 * - prompt: only when the target is idle (starts a new turn);
 * - steer: only when the target is running (steers that turn);
 * - followUp: any state (queues behind a running turn, or starts one
 *   when idle — omp owns the queue, as with the UI's follow-ups).
 * A waited delivery registers its turn-end waiter BEFORE sending, then
 * reads the turn's final text with get_last_assistant_text.
 */
function createAgentToolOps(source?: AgentSessionWrapper, admission?: FoxHostAdmission): AgentToolSessionOps {
  return {
    async listSessions() {
      const running = new Set(getRunningRpcSessionIds());
      const sessions = await listAllSessions();
      return sessions.map((s) => {
        const parent = foxWorkerParent(s.path);
        const origin = nativeSessionLineage(s.path)?.at(-1)?.header.id;
        return {
          id: s.id, name: s.name, cwd: s.cwd, sessionFile: s.path, running: running.has(s.id),
          ...(parent ? { parentSessionId: parent.parent.id } : s.parentSessionId ? { parentSessionId: s.parentSessionId } : {}),
          ...(parent && source && isFoxWorkspacePath(source.cwd) ? { isFoxWorker: sameNativeConversation(parent.parentFile, source.sessionFile) } : {}),
          ...(origin && origin !== s.id ? { originSessionId: origin } : {}),
        };
      });
    },

    async createSession(input) {
      if (!existsSync(input.cwd)) throw new Error(`Directory does not exist: ${input.cwd}`);
      if (admission) await source!.recheckFoxGoalDispatch(admission);
      if (admission) source!.assertFoxGoalAdmissionOpen(admission.projectKey);
      const tempKey = `__new__${randomUUID()}`;
      const { session } = await startRpcSession(tempKey, "", input.cwd, undefined, undefined);
      allowFileRoot(input.cwd);
      invalidateSessionListCache();
      try {
        if (input.parentSessionId) {
          const parent = getRpcSession(input.parentSessionId);
          if (!parent?.isAlive() || !isFoxWorkspacePath(parent.cwd)) throw new Error("The parent FOX conversation is no longer available.");
          if (admission) await source!.recheckFoxGoalDispatch(admission);
          if (admission) source!.assertFoxGoalAdmissionOpen(admission.projectKey);
          const result = await session.send({ type: "new_session", parentSession: parent.sessionFile || parent.sessionId }) as { cancelled?: boolean } | undefined;
          if (result?.cancelled) throw new Error("OMP cancelled worker session creation.");
          if (!session.hasFoxReporting() || !parent.hasFoxReporting()) throw new Error("Native worker reporting is unavailable. Restart FOX when idle before delegating.");
          await session.send({ type: "set_host_tools", tools: [] });
          if (!session.hasFoxWorkerReporting()) throw new Error("The native worker parent or reporting tool could not be verified. No project prompt was sent.");
        }
        if (admission) {
          await session.foxGoalCommand("get");
          await session.send({ type: "get_state" });
          const bound = await source!.foxGoalCommand("assignment", { admissionId: admission.admissionId, workerSessionId: session.sessionId, workerFile: session.sessionFile });
          const assignment = bound.assignments.find((item) => item.id === admission.admissionId);
          if (!assignment || !bound.grant || assignment.workerSessionId !== session.sessionId) throw new Error("Native worker assignment was not durably bound");
          await session.foxGoalCommand("worker-bind", { assignment, terms: bound.grant.terms });
        }
        if (input.provider && input.modelId) {
          await session.send({ type: "set_model", provider: input.provider, modelId: input.modelId });
        }
        if (input.name) await session.send({ type: "set_session_name", name: input.name });
        if (input.prompt) {
          if (admission) await source!.recheckFoxGoalDispatch(admission);
          if (admission) { source!.assertFoxGoalAdmissionOpen(admission.projectKey); admission.effectStarted = true; }
          await session.send({ type: "prompt", message: input.prompt });
        }
      } catch (error) {
        await session.destroyAndWait();
        throw error;
      }
      invalidateSessionListCache();
      return { sessionId: session.sessionId };
    },

    async deliver(input): Promise<AgentToolDeliverResult> {
      const live = getRpcSession(input.sessionId);
      let wrapper = live?.isAlive() ? live : undefined;
      if (!wrapper) {
        const filePath = await resolveSessionPath(input.sessionId);
        if (!filePath) throw new Error(`Session not found: ${input.sessionId}`);
        const header = readSessionHeader(filePath);
        if (header?.cwd && isFoxWorkspacePath(header.cwd)) throw new Error("Agent messages cannot impersonate user instructions to FOX. Project workers must use report_to_parent.");
        const { cwd } = resolveSpawnCwdResult(header?.cwd);
        const started = await startRpcSession(input.sessionId, filePath, cwd, undefined, undefined, header?.cwd);
        wrapper = started.session;
      }
      if (isFoxWorkspacePath(wrapper.cwd)) throw new Error("Agent messages cannot impersonate user instructions to FOX. Project workers must use report_to_parent.");
      if (source && isFoxWorkspacePath(source.cwd)) {
        const parent = foxWorkerParent(wrapper.sessionFile);
        if (!parent || !sameNativeConversation(parent.parentFile, source.sessionFile)) throw new Error("The worker's original FOX lineage changed during startup. No message was delivered.");
      }
      if (admission) {
        const bound = await source!.foxGoalCommand("assignment", { admissionId: admission.admissionId, workerSessionId: wrapper.sessionId, workerFile: wrapper.sessionFile });
        const assignment = bound.assignments.find((item) => item.id === admission.admissionId);
        if (!assignment || !bound.grant) throw new Error("Native follow-up assignment was not persisted");
        await wrapper.foxGoalCommand("worker-bind", { assignment, terms: bound.grant.terms });
        await source!.recheckFoxGoalDispatch(admission);
      }
      if (admission && input.wait) throw new Error("Automatic goal workers report asynchronously; use wait:false");
      if (admission) {
        if (input.delivery === "prompt" && wrapper.isRunning()) throw new Error("Goal worker is busy; no new prompt was submitted");
        source!.assertFoxGoalAdmissionOpen(admission.projectKey);
        admission.effectStarted = true;
      }
      return deliverToSession(wrapper, input);
    },
  };
}

configureFoxReportDelivery(async (report, parentFile) => {
  const header = readSessionHeader(parentFile);
  if (!header || header.id !== report.parentSessionId || !isFoxWorkspacePath(header.cwd)) throw new Error("The original FOX parent is unavailable; no replacement was selected");
  const current = getRpcSession(header.id);
  const parent = current?.isAlive() ? current : (await startRpcSession(header.id, parentFile, header.cwd, undefined, undefined, header.cwd)).session;
  await parent.receiveFoxReport(report, parentFile);
});

export async function startRpcSession(
  sessionId: string,
  sessionFile: string,
  cwd: string,
  toolNames?: string[],
  /** The chat's advisor choice. `on` spawns with --advisor and `off` runs
   * `/advisor off` after the spawn; a live idle child whose choice differs
   * takes the command in place. `inherit` or undefined reuses whatever is
   * alive. */
  advisor?: AdvisorChoice,
  /** The cwd recorded in the session file header, used to detect a spawn
   * fallback (recorded dir gone) and warn the user. Omit for new sessions. */
  recordedCwd?: string | null,
  launchConfig?: ProjectLaunchConfig,
  /** Model to bind at spawn time as `provider/modelId` (--model). Only used
   * when resuming: it replaces the saved model and skips its restore check,
   * so a cold set_model can recover a session whose saved model is gone
   * (#277). Ignored when a live child is reused; the caller's set_model RPC
   * then runs against that child as before. The spawn alone does not rewrite
   * the session file, so a later spawn without an override still hits the
   * old saved model until omp records a new one (a successful set_model RPC
   * or a completed turn); the picker path re-binds on each cold switch, so
   * the user is never stuck on the unrestorable model. */
  spawnModel?: string,
): Promise<{ session: AgentSessionWrapper; realSessionId: string }> {
  resolveSpawnCwdResult(cwd);
  if (sessionFile && recordedCwd && !samePath(cwd, recordedCwd)) throw new WebRpcError("The session workspace changed; refusing to execute in another directory", "session_cwd_unavailable");
  const registry = getRegistry();
  const locks = getLocks();
  launchConfig = launchConfig ?? await launchConfigForCwd(cwd);
  const fox = isFoxWorkspacePath(cwd);
  if (fox) initializeFoxNativePolicy();
  const effectiveToolNames = effectiveToolNamesForCwd(cwd, toolNames);
  const existing = registry.get(sessionId);
  if (existing?.isRestarting()) throw new WebRpcError(RESTARTING_MESSAGE, "session_restarting");
  // A legacy FOX wrapper keeps its old prompt and full toolset even after the
  // persona changed. Replace it before reusing it; project wrappers are left
  // alone. This also aborts a busy legacy FOX that is editing a project.
  if (existing?.isAlive() && needsFoxToolPolicyRestart(existing)) {
    if (existing.isRunning() || existing.isEditingHistory()) throw new WebRpcError("Wait for FOX to settle before updating its tool policy", "session_busy");
    await existing.destroyAndWait("fox-tool-policy");
  }
  if (existing?.isAlive()) {
    // Busy children are kept (a mid-run swap would drop in-flight work); the
    // choice reaches them with a later request. An idle child takes `/advisor
    // on|off` in place. Only an omp without that command still needs a respawn
    // to turn the advisor on (the --advisor flag); `off` has no flag at all.
    if (!advisor || advisor === "inherit" || existing.advisorChoice === advisor || existing.isRunning() || existing.isEditingHistory()) {
      return { session: existing, realSessionId: sessionId };
    }
    if (await existing.applyAdvisorChoice(advisor) || advisor === "off") {
      return { session: existing, realSessionId: sessionId };
    }
    await existing.destroyAndWait();
  }
  // A wrapper whose omp child is still flushing/exiting must fully dispose
  // before a replacement spawns — two children touching the same .jsonl would
  // race on resume/delete/archive.
  if (existing?.destroyPromise) await existing.destroyPromise;

  // omp >= 18.5 lets only one process own a session file; a second `--resume`
  // child would fork into a new nested session on its first write. Reuse the
  // live wrapper that already reports this file (e.g. after it moved files).
  if (sessionFile && !existing) {
    for (const candidate of new Set(registry.values())) {
      if (candidate.isRestarting() && candidate.sessionFile && samePath(candidate.sessionFile, sessionFile)) throw new WebRpcError(RESTARTING_MESSAGE, "session_restarting");
      if (candidate.isAlive() && candidate.sessionFile && samePath(candidate.sessionFile, sessionFile)) {
        if (needsFoxToolPolicyRestart(candidate)) {
          if (candidate.isRunning() || candidate.isEditingHistory()) throw new WebRpcError("Wait for FOX to settle before updating its tool policy", "session_busy");
          await candidate.destroyAndWait("fox-tool-policy");
          continue;
        }
        registry.set(sessionId, candidate);
        return { session: candidate, realSessionId: candidate.sessionId };
      }
    }
  }

  const inflight = locks.get(sessionId);
  if (inflight) return inflight;

  const starting = (async () => {
    // The wrapper needs the process and the process's onExit needs the wrapper;
    // the holder breaks that cycle (onExit only fires once the child dies).
    const holder: { wrapper?: AgentSessionWrapper } = {};
    const overlay = fox ? foxGoalOverlay(false) : null;
    const proc = new RpcProcess({
      cwd,
      // User-configured variables for MCP servers and generated configs (#104).
      env: getAgentEnvOverrides(),
      extraArgs: [...buildSessionSpawnArgs(sessionFile, effectiveToolNames, advisor === "on", launchConfig, spawnModel, fox), "--extension", SESSION_EDIT_EXTENSION_PATH, "--extension", FOX_REPORT_EXTENSION_PATH, "--extension", FOX_GOAL_EXTENSION_PATH, ...(fox ? ["--extension", FOX_NATIVE_EXTENSION_PATH, ...overlay!.args] : [])],
      onExit: (info) => { overlay?.cleanup(); holder.wrapper?.handleProcessExit(info, proc); },
    });
    const created = new AgentSessionWrapper(
      proc,
      cwd,
      recordedCwd,
      advisor ?? "inherit",
      sessionFile ? sessionId : "",
      undefined,
      fox
        ? getToolPresetStatus(effectiveToolNames, launchConfig?.extraArgs, "full")
        : getToolPresetStatus(sessionFile ? undefined : effectiveToolNames, launchConfig?.extraArgs, sessionFile ? null : "full"),
      fox ? effectiveToolNames : sessionFile ? null : effectiveToolNames,
    );
    holder.wrapper = created;
    created.start();
    try {
      await created.waitUntilReady();
      // A fresh spawn (no --resume) must never land in an existing conversation:
      // omp's startup resume handling can be config- or version-driven into
      // continuing the cwd's most recent session, which would silently send the
      // first prompt into an old .jsonl. The child's reported session file
      // existing on disk is the resume signal — a genuinely fresh child reports
      // a path it has not created yet (session files are written lazily on the
      // first message), so this never fires for a real new session.
      if (!sessionFile && created.sessionFile && existsSync(created.sessionFile)) {
        await created.send({ type: "new_session" });
      }
      await created.applyAdvisorChoiceAfterSpawn();
      // Register server agent tools (#275) at startup when the gate is on,
      // so a session works for agent-to-agent calls even when no browser
      // tab ever registers host tools for it. send() merges these with any
      // later UI registration, so this never drops the UI tools. Older omp
      // builds without host tools simply reject the registration; ignore
      // that the way the UI registration does.
      if (fox || loadWebServerSettings().agentToolsEnabled || foxWorkerParent(created.sessionFile)) {
        await created.send({ type: "set_host_tools", tools: AGENT_TOOL_DEFINITIONS }).catch(() => {});
      }
      if (foxWorkerParent(created.sessionFile)) void recoverFoxWorkerReports(created.sessionFile).catch(() => {});
    } catch (error) {
      // Await the child's full exit before the `finally` releases the startup
      // lock: a fire-and-forget destroy() would let a retry spawn a second
      // OMP child while the failed one is still flushing/exiting, and
      // concurrent resume/delete/archive paths could race that old child.
      await created.destroyAndWait();
      throw error;
    }

    const realSessionId = created.sessionId;
    created.onDestroy(() => {
      // Drop every key (current id, original id, moved-from aliases).
      for (const [key, wrapper] of registry) if (wrapper === created) registry.delete(key);
    });
    let pointerUpdates: Promise<void> = Promise.resolve();
    created.onIdentityChange((oldId, newId, options) => {
      if (!options?.keepOldId) for (const [key, value] of registry) if (value === created) registry.delete(key);
      registry.set(newId, created);
      if (fox) {
        const update = pointerUpdates.then(async () => {
          const record = await readFoxSessionRecord();
          if (record.sessionId === oldId && !await compareAndSetFoxSessionId(newId, record)) {
            throw new Error("FOX pointer changed during native identity persistence");
          }
        });
        pointerUpdates = update;
        return update;
      }
    });
    if (fox && sessionFile && sessionId !== realSessionId) {
      const record = await readFoxSessionRecord();
      if (record.sessionId === sessionId && sameNativeConversation(sessionFile, created.sessionFile)
        && !await compareAndSetFoxSessionId(realSessionId, record)) throw new Error("FOX pointer changed during native startup");
    }
    registry.set(realSessionId, created);
    // A resume that landed on a continuation copy (see initialize) still serves
    // the id the caller asked for; without the alias every request for it
    // would spawn another child on the same conversation.
    if (sessionFile && realSessionId !== sessionId) registry.set(sessionId, created);
    // A successful respawn supersedes the crash record.
    clearExitedRpcSession(sessionId);
    if (realSessionId !== sessionId) clearExitedRpcSession(realSessionId);
    return { session: created, realSessionId };
  })().finally(() => locks.delete(sessionId));

  locks.set(sessionId, starting);
  return starting;
}
