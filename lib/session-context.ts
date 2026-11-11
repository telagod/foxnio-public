import type { AgentMessage, CompactionEntry, CustomMessage, SessionContext, SessionEntry } from "./types";
import type { TodoPhase } from "./pi-types";
import { normalizeToolCalls } from "./normalize";
import { isRecord } from "./type-guards";
import { toolResultContentAsUrls } from "./media-cache";
import { taskResultRetryFailure, taskResultStructuredOutput, taskResultUsageCost } from "./task-result-details";
import { PASSIVE_TOOL_CONTEXT } from "./chat-transcript-plan";

function parseTodoPhases(value: unknown): TodoPhase[] | null {
  if (!Array.isArray(value)) return null;
  const statuses = new Set(["pending", "in_progress", "completed", "blocked", "abandoned"]);
  const phases: TodoPhase[] = [];
  for (const phase of value) {
    if (!isRecord(phase) || typeof phase.name !== "string" || !Array.isArray(phase.tasks)) return null;
    const tasks = [];
    for (const task of phase.tasks) {
      if (!isRecord(task) || typeof task.content !== "string" || typeof task.status !== "string" || !statuses.has(task.status)) return null;
      if (task.blocker !== undefined && typeof task.blocker !== "string") return null;
      tasks.push({
        content: task.content,
        status: task.status as TodoPhase["tasks"][number]["status"],
        ...(typeof task.blocker === "string" ? { blocker: task.blocker } : {}),
      });
    }
    phases.push({ name: phase.name, tasks });
  }
  return phases;
}

/** Latest valid todo snapshot on the selected branch, without exposing tool metadata to the client. */
export function getTodoPhasesFromEntries(entries: SessionEntry[], leafId?: string | null): TodoPhase[] {
  if (leafId === null || entries.length === 0) return [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let entry = leafId ? byId.get(leafId) : entries[entries.length - 1];
  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  while (entry && !seen.has(entry.id)) {
    seen.add(entry.id);
    path.push(entry);
    entry = entry.parentId ? byId.get(entry.parentId) : undefined;
  }

  for (let index = 0; index < path.length; index++) {
    const current = path[index];
    if (current.type === "custom" && current.customType === "user_todo_edit") {
      const phases = isRecord(current.data) ? parseTodoPhases(current.data.phases) : null;
      if (phases) return phases;
    }
    if (current.type === "message" && isRecord(current.message) && current.message.role === "toolResult") {
      const message = current.message as { role?: string; toolName?: string; isError?: boolean; details?: unknown };
      if (message.toolName !== "todo" || message.isError) continue;
      const phases = isRecord(message.details) ? parseTodoPhases(message.details.phases) : null;
      if (phases) return phases;
    }
  }
  return [];
}

const SUPERSEDED_COMPACTION_SUMMARY = "[Superseded compaction summary elided after a newer compaction]";

/**
 * Build the display context for a leaf. Port of oh-my-pi's buildSessionContext
 * (session/session-context.ts) path-walk semantics — leaf→root walk with a
 * cycle guard, firstKeptEntryId compaction collapsing, role-based model
 * tracking with legacy assistant-message inference — combined with pi-web's
 * UI message conversion: messages/entryIds stay parallel so fork/navigation
 * targets remain aligned, and the active compaction summary is emitted first
 * (the collapsed view the pi-web UI is built around).
 */
export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean; includePreCompaction?: boolean } = {},
): SessionContext {
  const { selected, compactionId, ...metadata } = selectSessionContext(entries, leafId, options);
  return {
    ...metadata,
    entryIds: selected.map((entry) => entry.id),
    messages: selected.map((entry) => entry.type === "compaction"
      ? compactionUiMessage(entry, entry.id === compactionId)
      : entryToUiMessage(entry, options)!),
  };
}

/** Select ordering and branch metadata without converting message bodies. */
export function selectSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  options: { includePreCompaction?: boolean } = {},
) {
  const empty = { selected: [] as SessionEntry[], compactionId: null as string | null, thinkingLevel: "off", model: null as SessionContext["model"], todoPhases: [] as TodoPhase[] };
  const byId = new Map<string, SessionEntry>();
  for (const e of entries) byId.set(e.id, e);
  if (leafId === null) return empty;
  const leaf = (leafId ? byId.get(leafId) : undefined) ?? entries.at(-1);
  if (!leaf) return empty;

  // Walk leaf → root, stopping at the first corrupt parent cycle.
  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let current: SessionEntry | undefined = leaf;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  path.reverse();

  let thinkingLevel = "off";
  const models: Record<string, string> = {};
  // Explicit defaults take precedence over temporary assistant fallbacks.
  let hasExplicitDefaultModel = false;
  let compaction: CompactionEntry | null = null;
  for (const entry of path) {
    if (entry.type === "thinking_level_change") {
      thinkingLevel = entry.thinkingLevel ?? "off";
    } else if (entry.type === "model_change") {
      if (entry.model) {
        const role = entry.role ?? "default";
        models[role] = entry.model;
        if (role === "default") hasExplicitDefaultModel = true;
      } else if (entry.provider && entry.modelId) {
        models.default = `${entry.provider}/${entry.modelId}`;
        hasExplicitDefaultModel = true;
      }
    } else if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "assistant") {
      if (!hasExplicitDefaultModel && entry.message.provider && entry.message.model) {
        models.default = `${entry.message.provider}/${entry.message.model}`;
      }
    } else if (entry.type === "compaction") {
      compaction = entry;
    }
  }

  const selected: SessionEntry[] = [];
  const appendEntry = (entry: SessionEntry) => {
    if (entry.type === "compaction" || entry.type === "custom_message"
      || (entry.type === "message" && isRecord(entry.message))
      || (entry.type === "branch_summary" && entry.summary)) {
      selected.push(entry);
    }
  };
  if (compaction && !options.includePreCompaction) {
    const activeCompaction = compaction;
    appendEntry(activeCompaction);
    const compactionIdx = path.findIndex((e) => e.type === "compaction" && e.id === activeCompaction.id);
    let foundFirstKept = false;
    for (let i = 0; i < compactionIdx; i++) {
      const entry = path[i];
      if (entry.id === activeCompaction.firstKeptEntryId) foundFirstKept = true;
      if (foundFirstKept) appendEntry(entry);
    }
    for (let i = compactionIdx + 1; i < path.length; i++) appendEntry(path[i]);
  } else {
    for (const entry of path) appendEntry(entry);
  }

  let model: SessionContext["model"] = null;
  const defaultModel = models.default;
  if (defaultModel) {
    const separator = defaultModel.indexOf("/");
    model = separator > 0
      ? { provider: defaultModel.slice(0, separator), modelId: defaultModel.slice(separator + 1) }
      : { provider: "", modelId: defaultModel };
  }
  return { selected, compactionId: compaction?.id ?? null, thinkingLevel, model, todoPhases: getTodoPhasesFromEntries(entries, leafId) };
}

function parseEntryTimestamp(timestamp: string): number | undefined {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Message-level timestamps arrive as epoch numbers on the wire but ISO
 *  strings in hand-edited/imported files — normalize both to number|undefined
 *  so downstream arithmetic never sees a string (NaN / Invalid Date). */
function normalizeMessageTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") return parseEntryTimestamp(value);
  return undefined;
}

/** Pass-through branches (user/assistant/toolResult) return the raw message
 *  object — repair only its timestamp, copying when it needs it. */
function withNormalizedTimestamp(message: AgentMessage): AgentMessage {
  const raw = message.timestamp;
  const timestamp = normalizeMessageTimestamp(raw);
  return timestamp === raw ? message : { ...message, timestamp };
}

/**
 * toolResult `details` is provider/tool-internal metadata that dominates real
 * history payloads (measured 643KB of a 1.34MB context on a 533-entry session),
 * and the history UI reads exactly two keys from it: details.patch and
 * details.diff (components/MessageView.tsx getResultDiff). Serialization
 * allowlists those keys — extend the allowlist if MessageView ever reads more.
 * Task toolResults additionally keep a SIZE-BOUNDED subset of their
 * results/progress (telemetry, no full output) so the message flow can render
 * a per-subagent summary. On-disk parsing (loadSessionFile/getSessionEntries)
 * keeps full details.
 */
const TASK_DETAIL_MAX_TEXT = 240;
const TASK_DETAIL_MAX_ROWS = 50;

function truncateTaskDetailText(value: string): string {
  if (value.length <= TASK_DETAIL_MAX_TEXT) return value;
  // Cut by code point so a boundary can never split a surrogate pair.
  return `${[...value].slice(0, TASK_DETAIL_MAX_TEXT).join("")}…`;
}

function taskDetailAsync(value: unknown): Record<string, string> | undefined {
  // Project async to its documented fields only (state/jobId/type) — extra
  // payload fields must not ride the bounded history response.
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const key of ["state", "jobId", "type"] as const) {
    if (typeof value[key] === "string") out[key] = truncateTaskDetailText(value[key]);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const TASK_DETAIL_PROGRESS_KEYS = [
  "index", "id", "agent", "agentSource", "status", "task", "assignment", "lastIntent",
  "toolCount", "requests", "tokens", "contextTokens", "contextWindow", "cost", "durationMs",
  "modelRole", "resolvedModel", "resolvedModelIsFallback", "retryFailure",
] as const;

const TASK_DETAIL_RESULT_KEYS = [
  "index", "id", "agent", "agentSource", "status", "task", "assignment", "exitCode",
  "truncated", "structuredOutput", "durationMs", "tokens", "requests", "contextTokens",
  "contextWindow", "modelRole", "resolvedModel", "resolvedModelIsFallback", "error",
  "aborted", "abortReason", "outputPath", "patchPath", "branchName", "retryFailure",
] as const;

function keepTaskToolResultDetails(details: Record<string, unknown>): Record<string, unknown> | null {
  const kept: Record<string, unknown> = {};
  const results = Array.isArray(details.results) ? details.results : [];
  const progress = Array.isArray(details.progress) ? details.progress : [];
  if (results.length === 0 && progress.length === 0 && !isRecord(details.async)) return null;

  if (typeof details.totalDurationMs === "number") kept.totalDurationMs = details.totalDurationMs;
  if (isRecord(details.async)) {
    const asyncInfo = taskDetailAsync(details.async);
    if (asyncInfo) kept.async = asyncInfo;
  }

  const pickRecord = (raw: unknown, keys: readonly string[]): Record<string, unknown> | null => {
    if (!isRecord(raw)) return null;
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (raw[key] !== undefined) out[key] = raw[key];
    }
    // Bound every string field that rides the history payload.
    for (const key of ["task", "assignment", "error", "abortReason", "lastIntent", "agent", "modelRole", "resolvedModel", "outputPath", "patchPath", "branchName"] as const) {
      if (typeof out[key] === "string") out[key] = truncateTaskDetailText(out[key]);
    }
    // Settled results carry cost in `usage.cost`, not top-level `cost`.
    if (typeof out.cost !== "number") {
      const usageCost = taskResultUsageCost(raw.usage);
      if (usageCost !== undefined) out.cost = usageCost;
    }
    // Project nested objects to bounded, UI-only shapes.
    if (raw.retryFailure !== undefined) {
      const retryFailure = taskResultRetryFailure(raw.retryFailure, truncateTaskDetailText);
      if (retryFailure) out.retryFailure = retryFailure;
      else delete out.retryFailure;
    }
    if (raw.structuredOutput !== undefined) {
      const structuredOutput = taskResultStructuredOutput(raw.structuredOutput, truncateTaskDetailText);
      if (structuredOutput) out.structuredOutput = structuredOutput;
      else delete out.structuredOutput;
    }
    return out;
  };

  if (progress.length > 0) {
    kept.progress = progress
      .slice(0, TASK_DETAIL_MAX_ROWS)
      .map((raw) => pickRecord(raw, TASK_DETAIL_PROGRESS_KEYS))
      .filter((entry): entry is Record<string, unknown> => entry !== null);
  }
  if (results.length > 0) {
    kept.results = results
      .slice(0, TASK_DETAIL_MAX_ROWS)
      .map((raw) => pickRecord(raw, TASK_DETAIL_RESULT_KEYS))
      .filter((entry): entry is Record<string, unknown> => entry !== null);
  }
  return Object.keys(kept).length > 0 ? kept : null;
}

function keepHubToolResultDetails(details: Record<string, unknown>): Record<string, unknown> | null {
  const op = details.op;
  if (typeof op !== "string" || (op !== "send" && op !== "jobs")) return null;
  const kept: Record<string, unknown> = { op };
  if (op === "send") {
    const to = hubDetailTargets(details.to);
    if (to) kept.to = to;
    if (Array.isArray(details.receipts)) {
      const receipts = details.receipts
        .slice(0, TASK_DETAIL_MAX_ROWS)
        .map((raw) => {
          if (!isRecord(raw)) return null;
          const out: Record<string, string> = {};
          if (typeof raw.to === "string") out.to = truncateTaskDetailText(raw.to);
          if (typeof raw.outcome === "string") out.outcome = truncateTaskDetailText(raw.outcome);
          return Object.keys(out).length > 0 ? out : null;
        })
        .filter((entry): entry is Record<string, string> => entry !== null);
      if (receipts.length > 0) kept.receipts = receipts;
    }
  } else {
    if (Array.isArray(details.jobs)) {
      const jobs = details.jobs
        .slice(0, TASK_DETAIL_MAX_ROWS)
        .map((raw) => {
          if (!isRecord(raw)) return null;
          const out: Record<string, unknown> = {};
          for (const key of ["id", "type", "status", "label", "resolvedModel"] as const) {
            if (typeof raw[key] === "string") out[key] = truncateTaskDetailText(raw[key]);
          }
          if (typeof raw.durationMs === "number" && Number.isFinite(raw.durationMs)) out.durationMs = raw.durationMs;
          return Object.keys(out).length > 0 ? out : null;
        })
        .filter((entry): entry is Record<string, unknown> => entry !== null);
      if (jobs.length > 0) kept.jobs = jobs;
    }
  }
  return Object.keys(kept).length > 1 ? kept : null;
}

function hubDetailTargets(value: unknown): string[] | undefined {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : undefined;
  if (!list) return undefined;
  const out = list
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .slice(0, TASK_DETAIL_MAX_ROWS)
    .map((entry) => truncateTaskDetailText(entry));
  return out.length > 0 ? out : undefined;
}

function stripToolResultDetails(message: AgentMessage): AgentMessage {
  if (message.role !== "toolResult" || message.details === undefined) return message;
  const { details, ...rest } = message;
  if (isRecord(details)) {
    const kept: Record<string, unknown> = {};
    if (typeof details.patch === "string") kept.patch = details.patch;
    if (typeof details.diff === "string") kept.diff = details.diff;
    if (message.toolName === "task") {
      const taskDetails = keepTaskToolResultDetails(details);
      if (taskDetails) Object.assign(kept, taskDetails);
    }
    if (message.toolName === "hub") {
      const hubDetails = keepHubToolResultDetails(details);
      if (hubDetails) Object.assign(kept, hubDetails);
    }
    if (Object.keys(kept).length > 0) return { ...rest, details: kept };
  }
  return rest;
}

/**
 * Per-message fields omp persists for its own request replay. The browser never
 * reads them, and `inputTransformations` alone can be over half of a long
 * session's payload (one entry per dropped thinking block, per message).
 * `thinkingSignature` is opaque base64 on thinking blocks; the lazy thinking
 * endpoint serves `thinking` text from the raw entry, not from this output.
 */
const UNUSED_MESSAGE_FIELDS = ["inputTransformations", "requestControls", "contextSnapshot"] as const;

/** Returns `message` itself when nothing needs stripping; never mutates it (it may alias the shared parse cache). */
function stripUnusedMessageFields(message: AgentMessage): AgentMessage {
  let out: Record<string, unknown> = message as unknown as Record<string, unknown>;
  if (UNUSED_MESSAGE_FIELDS.some((key) => key in out)) {
    out = { ...out };
    for (const key of UNUSED_MESSAGE_FIELDS) delete out[key];
  }
  const content = out.content;
  if (out.role === "assistant" && Array.isArray(content)
    && content.some((block) => isRecord(block) && block.type === "thinking" && "thinkingSignature" in block)) {
    out = {
      ...out,
      content: content.map((block) => {
        if (!isRecord(block) || block.type !== "thinking" || !("thinkingSignature" in block)) return block;
        const rest = { ...block };
        delete rest.thinkingSignature;
        return rest;
      }),
    };
  }
  return out as unknown as AgentMessage;
}

function toolResultImagesAsUrls(message: AgentMessage): AgentMessage {
  if (message.role !== "toolResult") return message;
  const content = toolResultContentAsUrls(message.content);
  return content === message.content ? message : { ...message, content };
}

export function compactionUiMessage(entry: CompactionEntry, active: boolean): CustomMessage {
  return {
    role: "custom",
    customType: "compaction",
    content: active ? entry.summary : SUPERSEDED_COMPACTION_SUMMARY,
    display: true,
    details: {
      tokensBefore: entry.tokensBefore,
      ...(entry.tokensAfter !== undefined ? { tokensAfter: entry.tokensAfter } : {}),
      ...(entry.method !== undefined ? { method: entry.method } : {}),
      firstKeptEntryId: entry.firstKeptEntryId,
    },
    timestamp: parseEntryTimestamp(entry.timestamp),
  };
}

// Convert a session entry on the active branch into a UI message.
// Returns null for entries that do not map to chat history (metadata, non-message types).
export function entryToUiMessage(
  entry: SessionEntry,
  options: { deferThinking?: boolean; deferToolResultImages?: boolean },
): AgentMessage | null {
  switch (entry.type) {
    case "message": {
      // Imports and hand-edits can produce message entries whose `message`
      // object is missing; skip them like any other unmappable entry instead
      // of crashing every reader of the file.
      if (!isRecord(entry.message)) return null;
      const raw = entry.message;
      // omp-only roles are folded into displayable custom messages so the
      // existing role-keyed UI renders them without new components.
      if (raw.role === "developer") {
        // Passive tool context is display-only: it rides on its tool card
        // (collectToolResults), never as a row or in copied transcripts.
        const passive = raw.passiveToolContext === true;
        return {
          role: "custom",
          customType: passive ? PASSIVE_TOOL_CONTEXT : "developer",
          content: raw.content,
          display: !passive,
          timestamp: normalizeMessageTimestamp(raw.timestamp),
        };
      }
      if (raw.role === "pythonExecution") {
        const output = raw.output ? `\n\`\`\`\n${raw.output}\n\`\`\`` : "\n(no output)";
        const status = raw.cancelled
          ? "\n(execution cancelled)"
          : raw.exitCode ? `\nExecution failed with code ${raw.exitCode}` : "";
        return {
          role: "custom",
          customType: "python-execution",
          content: `Ran Python:\n\`\`\`python\n${raw.code}\n\`\`\`${output}${status}`,
          display: true,
          timestamp: normalizeMessageTimestamp(raw.timestamp),
        };
      }
      if (raw.role === "fileMention") {
        // Guard against shape-malformed entries (missing/non-array `files`)
        // the same way the loader tolerates bad lines: one bad entry must not
        // 500 the entire session view.
        const files = Array.isArray(raw.files)
          ? (raw.files as unknown[]).filter((f): f is { path: string } =>
              !!f && typeof f === "object" && typeof (f as { path?: unknown }).path === "string")
          : [];
        return {
          role: "custom",
          customType: "file-mention",
          content: `Attached file${files.length === 1 ? "" : "s"}:\n${files.map((f) => `- ${f.path}`).join("\n")}`,
          display: true,
          timestamp: normalizeMessageTimestamp(raw.timestamp),
        };
      }
      const normalized = options.deferToolResultImages
        ? toolResultImagesAsUrls(normalizeToolCalls(raw))
        : normalizeToolCalls(raw);
      const message = stripUnusedMessageFields(stripToolResultDetails(normalized));
      if (!options.deferThinking || message.role !== "assistant") return withNormalizedTimestamp(message);
      // Guard like the loader does for bad lines: normalizeToolCalls passes
      // non-array content through unchanged, so a string-content assistant
      // entry must not 500 the whole context route.
      if (!Array.isArray(message.content)) return withNormalizedTimestamp(message);
      const deferred = {
        ...message,
        content: message.content.map((block) => (
          block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim() !== ""
            ? { ...block, thinking: "", deferred: true }
            : block
        )),
      };
      return withNormalizedTimestamp(deferred);
    }
    case "branch_summary":
      if (!entry.summary) return null;
      return {
        role: "user",
        content: `*The conversation briefly explored another branch and returned with this summary:*\n\n${entry.summary}`,
        timestamp: parseEntryTimestamp(entry.timestamp),
        branchSummary: true,
      };
    case "custom_message":
      return {
        role: "custom",
        customType: entry.customType,
        content: entry.content,
        display: entry.display,
        details: entry.details,
        timestamp: parseEntryTimestamp(entry.timestamp),
      };
    default:
      // model_change, thinking_level_change, service_tier_change, label,
      // title_change, session_init, ttsr_injection, mode_change, custom,
      // session_info: metadata entries with no chat rendering.
      return null;
  }
}
