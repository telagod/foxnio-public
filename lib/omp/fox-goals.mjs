import { foxReportFromEntry, FOX_REPORT_MESSAGE, FOX_REPORT_RECEIPT } from "./fox-reports.mjs";
import { foxActionFingerprint } from "./fox-dispatch-guard.mjs";

export const FOX_GOAL_TOOL = "fox_goal";
export const FOX_GOAL_COMMAND = "omp-web-fox-goal";
export const FOX_GOAL_REPLY_PREFIX = "foxnio:goal-reply:";
export const FOX_GOAL_EVENT_PREFIX = "foxnio:goal-event:";
export const FOX_GOAL_ENTRY = "fox-goal";
export const FOX_GOAL_WORKER_ENTRY = "fox-goal-worker";
export const FOX_GOAL_PURPOSES = ["implementation", "verification", "evidence", "rework"];
const STATES = ["reserved", "running", "settled", "uncertain", "closed"];
const ACTIVE_ASSIGNMENTS = new Set(["reserved", "running", "uncertain"]);
const MUTATING = new Set(["implementation", "rework"]);
const ID = /^[A-Za-z0-9_-]{1,200}$/;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, name, max = 8000) => {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value;
};
export const foxGoalId = (value, name = "native entry identity") => {
  if (typeof value !== "string" || !ID.test(value)) throw new Error(`Invalid ${name}`);
  return value;
};
const pathKey = (value) => {
  const path = text(value, "canonical project cwd", 8192).replace(/\\/g, "/");
  if (!/^(\/|[A-Za-z]:\/)/.test(path) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(path) || path.includes("\0") || (path.length > 1 && path.endsWith("/")) || path.includes("//")) throw new Error("Invalid canonical project cwd");
  return /^[A-Za-z]:/.test(path) ? path.toLowerCase() : path;
};
const strings = (value, name, max = 64) => {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) throw new Error(`Invalid ${name}`);
  const result = value.map((item) => text(item, name, 1000));
  if (new Set(result).size !== result.length) throw new Error(`Duplicate ${name}`);
  return result;
};
const bounded = (value, fallback, max, name) => {
  const n = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(n) || n < (name === "maxRework" ? 0 : 1) || n > max) throw new Error(`Invalid ${name}`);
  return n;
};

export function parseFoxGoalTerms(value) {
  if (!record(value)) throw new Error("Invalid goal terms");
  const projects = strings(value.projects, "projects", 32).map(pathKey);
  if (new Set(projects).size !== projects.length) throw new Error("Duplicate canonical projects");
  if (!Array.isArray(value.criteria) || value.criteria.length === 0 || value.criteria.length > 64) throw new Error("Invalid acceptance criteria");
  const criteria = value.criteria.map((criterion) => ({ id: foxGoalId(criterion?.id, "criterion ID"), text: text(criterion?.text, "criterion text") }));
  if (new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length) throw new Error("Duplicate criterion ID");
  const operations = strings(value.operations ?? ["implementation", "verification"], "operations", 16);
  if (operations.some((op) => !["implementation", "verification", "evidence", "commit", "push", "deploy", "destructive"].includes(op))) throw new Error("Unknown goal operation");
  if (value.tokenBudget !== undefined && (!Number.isSafeInteger(value.tokenBudget) || value.tokenBudget <= 0)) throw new Error("Invalid native token budget");
  if (value.expiresAt !== undefined && (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)))) throw new Error("Invalid grant expiry");
  return {
    objective: text(value.objective, "objective"), projects, criteria, operations,
    maxWorkers: bounded(value.maxWorkers, 4, 32, "maxWorkers"), maxDispatches: bounded(value.maxDispatches, 64, 4096, "maxDispatches"), maxRework: bounded(value.maxRework, 3, 32, "maxRework"),
    ...(value.tokenBudget !== undefined ? { tokenBudget: value.tokenBudget } : {}), ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt } : {}),
  };
}

export function parseFoxGoalCoordination(value) {
  if (!record(value) || !FOX_GOAL_PURPOSES.includes(value.purpose)) throw new Error("Goal dispatch requires exact coordination metadata");
  return { grantEntryId: foxGoalId(value.grantEntryId, "grant entry ID"), nativeGoalId: foxGoalId(value.nativeGoalId, "native goal ID"), planItemRef: text(value.planItemRef, "native plan item", 18000), purpose: value.purpose, criterionIds: strings(value.criterionIds, "criterion IDs") };
}

export function parseFoxGoalEvidence(value) {
  if (!record(value) || !["check", "artifact", "human"].includes(value.kind)) throw new Error("Invalid structured evidence kind");
  return { kind: value.kind, reference: text(value.reference, "evidence reference", 2000), observed: text(value.observed, "observed evidence", 4000), ...(value.revision !== undefined ? { revision: text(value.revision, "evidence revision", 200) } : {}) };
}

const evidenceSchema = { type: "object", properties: { kind: { type: "string", enum: ["check", "artifact", "human"] }, reference: { type: "string" }, observed: { type: "string" }, revision: { type: "string" } }, required: ["kind", "reference", "observed"], additionalProperties: false };
export const FOX_GOAL_TOOL_DEFINITION = {
  name: FOX_GOAL_TOOL, loadMode: "essential",
  description: "Authorize one bounded outcome once, inspect its native state, review RECEIVED evidence per criterion, settle an exact assignment or explicitly rebind a changed native todo item. authorize shows a 120-second native confirmation; all other operations use the existing live grant without another approval. Native goal owns execution and completion. Never ask for routine technical choices or invent received evidence.",
  parameters: { type: "object", properties: {
    op: { type: "string", enum: ["authorize", "get", "review", "settle", "rebind"] },
    terms: { type: "object", properties: {
      objective: { type: "string" }, projects: { type: "array", items: { type: "string" } }, criteria: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } }, required: ["id", "text"], additionalProperties: false } },
      operations: { type: "array", items: { type: "string", enum: ["implementation", "verification", "evidence", "commit", "push", "deploy", "destructive"] } }, tokenBudget: { type: "integer", minimum: 1 }, expiresAt: { type: "string" }, maxWorkers: { type: "integer", default: 4 }, maxDispatches: { type: "integer", default: 64 }, maxRework: { type: "integer", default: 3 },
    }, required: ["objective", "projects", "criteria", "operations"], additionalProperties: false },
    grantEntryId: { type: "string" }, nativeGoalId: { type: "string" }, admissionId: { type: "string" }, planItemRef: { type: "string" }, state: { type: "string", enum: ["settled", "uncertain", "closed"] },
    review: { type: "object", properties: { criterionId: { type: "string" }, decision: { type: "string", enum: ["accept", "reject"] }, reportIds: { type: "array", items: { type: "string" } }, evidence: { type: "array", items: evidenceSchema } }, required: ["criterionId", "decision", "reportIds", "evidence"], additionalProperties: false },
  }, required: ["op"], additionalProperties: false },
};

export function nativeFoxGoalFromEntries(entries) {
  let current = null;
  let completed = null;
  for (const entry of entries) {
    if (entry.type === "mode_change") {
      if (entry.mode === "goal" || entry.mode === "goal_paused") {
        const goal = entry.data?.goal;
        if (!record(goal) || typeof goal.id !== "string" || typeof goal.objective !== "string") { current = null; completed = null; continue; }
        current = { enabled: goal.status === "active", mode: goal.status === "complete" ? "exiting" : "active", goal };
        completed = goal.status === "complete" ? current : null;
      } else if (["none", "normal", "default"].includes(entry.mode)) current = null;
    } else if (entry.type === "custom" && entry.customType === "goal-completed" && completed?.goal.objective === entry.data?.objective) {
      current = completed;
    }
  }
  return current;
}

export function foxGoalTodo(entries) {
  let planReferences = [];
  let todoPhases = [];
  let planEntryId;
  for (const entry of entries) {
    const phases = entry.type === "custom" && entry.customType === "user_todo_edit" ? entry.data?.phases
      : entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "todo" && !entry.message.isError ? entry.message.details?.phases : null;
    if (!Array.isArray(phases) || phases.some((phase) => typeof phase?.name !== "string" || !Array.isArray(phase.tasks)
      || phase.tasks.some((task) => typeof task?.content !== "string" || !["pending", "in_progress", "completed", "blocked", "abandoned"].includes(task.status)))) continue;
    todoPhases = phases;
    planEntryId = entry.id;
    const uniqueItems = new Map();
    for (const phase of phases) for (const task of phase.tasks) if (!task.id) {
      const key = JSON.stringify([phase.name, task.content]);
      uniqueItems.set(key, (uniqueItems.get(key) ?? 0) + 1);
    }
    planReferences = planReferences.filter((reference) => {
      const [, name, content] = JSON.parse(reference);
      return uniqueItems.get(JSON.stringify([name, content])) === 1;
    });
    for (const phase of phases) for (const task of phase.tasks) if (!task.id && uniqueItems.get(JSON.stringify([phase.name, task.content])) === 1) planReferences.push(JSON.stringify([entry.id, phase.name, task.content]));
  }
  return { todoPhases, ...(planEntryId ? { planEntryId } : {}), planReferences };
}

function matchingHandoffMessage(entries, handoff) {
  return entries.find((entry) => entry.type === "custom_message" && entry.customType === "fox-goal-handoff"
    && entry.details?.handoffEntryId === handoff.id && entry.details?.batchId === handoff.data.batchId
    && JSON.stringify(entry.details?.reportIds) === JSON.stringify(handoff.data.reportIds));
}

export function resolveFoxGoalHandoff(entries, handoffEntryId, { idle, pending, paused }) {
  foxGoalId(handoffEntryId, "handoff entry ID");
  const index = entries.findIndex((entry) => entry.type === "custom" && entry.customType === FOX_GOAL_ENTRY && entry.data?.op === "handoff" && entry.id === handoffEntryId);
  if (index < 0) throw new Error("The native handoff marker is missing");
  const handoff = entries[index];
  const delivered = matchingHandoffMessage(entries, handoff);
  if (delivered) return { resolution: "delivered", messageEntryId: delivered.id };
  if (!idle || pending) throw Object.assign(new Error("Handoff resolution requires a settled native runtime with no pending input"), { code: "session_busy" });
  if (!paused) throw new Error("Pause native goal continuation before proving handoff absence");
  const before = new Set(entries.slice(0, index + 1).map((entry) => entry.id));
  const after = entries.slice(index + 1).filter((entry) => !before.has(entry.id));
  const humanTurnEntries = new Set();
  for (const entry of after) {
    const related = [entry.data, entry.details, entry.message?.details].some((data) => data
      && (data.handoffEntryId === handoff.id || data.batchId === handoff.data.batchId));
    const humanInput = entry.type === "message" && entry.message?.role === "user" && entry.message.attribution === "user"
      && entry.synthetic !== true && entry.isSynthetic !== true && entry.message.synthetic !== true && entry.message.isSynthetic !== true;
    if (related) throw new Error("Handoff delivery remains uncertain because this batch has related native admission evidence without its delivery receipt");
    if (humanInput) { humanTurnEntries.add(entry.id); continue; }
    const humanDescendant = humanTurnEntries.has(entry.parentId);
    const newAutomaticInput = entry.type === "custom_message" && ![FOX_REPORT_MESSAGE, "goal-mode-context"].includes(entry.customType)
      || entry.type === "custom" && entry.customType === FOX_GOAL_ENTRY && (entry.data?.op === "handoff" || entry.data?.op === "recovery" && entry.data.recovery === "running");
    const execution = entry.type === "message" || entry.type === "custom" && (entry.customType === "tool_execution_start"
      || entry.customType === FOX_GOAL_ENTRY && entry.data?.op === "admit");
    if (newAutomaticInput || execution && !humanDescendant) throw new Error("Handoff delivery remains uncertain because subsequent native turn/admission evidence cannot be attributed safely");
    if (humanDescendant) humanTurnEntries.add(entry.id);
  }
  return { resolution: "not-delivered", checkedThroughEntryId: entries.at(-1)?.id ?? handoff.id, nativePaused: true, noPendingInput: true };
}

export function projectFoxGoal(entries, nativeGoal = nativeFoxGoalFromEntries(entries), todoPhases = foxGoalTodo(entries).todoPhases) {
  const persisted = nativeFoxGoalFromEntries(entries);
  const snapshot = { supported: true, goal: nativeGoal ?? (persisted?.goal.status === "complete" ? persisted : null), grant: null, assignments: [], reviews: [], reports: [], notifications: [], handledReportIds: [], handoffs: [], dispatchesUsed: 0, recovery: "waiting", updatedAt: null, ...foxGoalTodo(entries), todoPhases };
  try {
    const unique = new Map();
    const receipts = new Map();
    const reportPositions = new Map();
    const entryPositions = new Map(entries.map((entry, index) => [entry.id, index]));
    const records = [];
    for (const entry of entries) {
      if (entry.customType === FOX_REPORT_MESSAGE || entry.customType === FOX_REPORT_RECEIPT) {
        const report = foxReportFromEntry(entry);
        if (!report) throw new Error("Invalid received worker report");
        const previous = receipts.get(report.id);
        if (previous && JSON.stringify(previous) !== JSON.stringify(report)) throw new Error("Conflicting received report identity");
        receipts.set(report.id, report);
        if (!reportPositions.has(report.id)) reportPositions.set(report.id, entryPositions.get(entry.id));
      }
      if (entry.customType !== FOX_GOAL_ENTRY) continue;
      if (entry.type !== "custom" || !record(entry.data) || entry.data.version !== 1) throw new Error("Invalid native fox-goal entry namespace/version");
      foxGoalId(entry.id);
      const encoded = JSON.stringify(entry.data);
      if (unique.has(entry.id)) {
        if (unique.get(entry.id) !== encoded) throw new Error("Conflicting native goal entry identity");
        continue;
      }
      unique.set(entry.id, encoded);
      foxGoalId(entry.data.sessionId, "owner session ID");
      foxGoalId(entry.data.epoch, "authorization epoch");
      if (!["consent", "bind", "control", "admit", "assignment", "settle", "review", "rebind", "recovery", "handoff", "handoff-resolve", "notification"].includes(entry.data.op)) throw new Error("Unknown native goal journal operation");
      records.push(entry);
    }
    const consents = records.filter((entry) => entry.data.op === "consent");
    const consentById = new Map(consents.map((entry) => [entry.id, entry]));
    for (const entry of records) {
      const data = entry.data;
      if (data.op === "consent" || data.op === "control" && ["pause", "revoke", "reset"].includes(data.action) && data.grantEntryId === undefined) continue;
      const source = consentById.get(data.grantEntryId);
      if (!source || source.data.epoch !== data.epoch) throw new Error("Native goal entry refers to a missing grant or conflicting authorization epoch");
      if (data.op === "notification") {
        if (typeof data.key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(data.day) || !Number.isFinite(Date.parse(data.at))) throw new Error("Invalid native notification receipt");
        if (!snapshot.notifications.some((item) => item.key === data.key)) snapshot.notifications.push({ key: data.key, day: data.day, at: data.at });
      }
    }
    const consent = consents.at(-1);
    if (!consent) return snapshot;
    const terms = parseFoxGoalTerms(consent.data.terms);
    const grant = { id: consent.id, goalId: null, terms, epoch: consent.data.epoch, createdAt: consent.timestamp, revoked: false, paused: false };
    if (consent.data.replacesGoalId !== undefined) {
      const replaces = foxGoalId(consent.data.replacesGoalId, "replaced native goal ID");
      const previousRecords = records.slice(0, records.findIndex((entry) => entry.id === consent.id));
      const previous = previousRecords.findLast((entry) => entry.data.op === "consent");
      const binding = previousRecords.findLast((entry) => entry.data.op === "bind" && entry.data.grantEntryId === previous?.id);
      const revoked = previousRecords.some((entry) => entry.data.op === "control" && ["revoke", "reset"].includes(entry.data.action) && entry.data.grantEntryId === previous?.id);
      const ended = new Map();
      for (const entry of previousRecords) if (entry.data.grantEntryId === previous?.id) {
        if (entry.data.op === "admit") ended.set(entry.id, false);
        if (entry.data.op === "settle") ended.set(entry.data.admissionId, ["settled", "closed"].includes(entry.data.state));
      }
      if (!previous || !binding || binding.data.goalId !== replaces || !revoked || [...ended.values()].some((settled) => !settled)) throw new Error("Replacement consent lacks a revoked settled native goal binding");
      grant.replacesGoalId = replaces;
    }
    snapshot.grant = grant;
    snapshot.recovery = "next";
    if (snapshot.goal?.goal.status === "complete" && (snapshot.goal.goal.objective !== terms.objective || !records.some((entry) => entry.data.op === "bind" && entry.data.grantEntryId === grant.id && entry.data.goalId === snapshot.goal.goal.id))) snapshot.goal = null;
    const assignments = new Map();
    const reviews = new Map();
    const reviewPositions = new Map();
    const lastMutations = new Map();
    const handoffs = new Map();
    const invalidEpochs = new Set(records.filter((entry) => entry.data.op === "control" && entry.data.action === "reset").map((entry) => entry.data.epoch));
    for (const [position, entry] of records.entries()) {
      const data = entry.data;
      if (data.grantEntryId !== grant.id || data.epoch !== grant.epoch) continue;
      snapshot.updatedAt = entry.timestamp ?? snapshot.updatedAt;
      switch (data.op) {
        case "consent": break;
        case "bind":
          foxGoalId(data.goalId, "native goal ID");
          if (data.objective !== terms.objective || grant.goalId && grant.goalId !== data.goalId) throw new Error("Native goal binding conflicts with confirmed objective or identity");
          grant.goalId = data.goalId;
          snapshot.recovery = "next";
          break;
        case "control":
          if (["revoke", "reset"].includes(data.action)) grant.revoked = true;
          else if (data.action === "pause") grant.paused = true;
          else if (data.action === "resume") grant.paused = false;
          else throw new Error("Invalid goal control");
          break;
        case "admit": {
          const coordination = parseFoxGoalCoordination(data.coordination);
          if (coordination.grantEntryId !== grant.id || coordination.nativeGoalId !== grant.goalId || data.goalId !== grant.goalId || !/^[a-f0-9]{64}$/.test(data.fingerprint ?? "")) throw new Error("Invalid persisted dispatch admission");
          const rework = [...assignments.values()].filter((item) => item.planItemRef === coordination.planItemRef && item.purpose === "rework").length + (coordination.purpose === "rework" ? 1 : 0);
          assignments.set(entry.id, { id: entry.id, grantEntryId: grant.id, goalId: grant.goalId, planItemRef: coordination.planItemRef, purpose: coordination.purpose, criterionIds: coordination.criterionIds, cwd: pathKey(data.cwd), workerSessionId: data.workerSessionId ?? null, state: "reserved", rework, fingerprint: data.fingerprint, toolCallId: data.toolCallId, toolName: data.toolName });
          if (MUTATING.has(coordination.purpose)) for (const criterionId of coordination.criterionIds) lastMutations.set(criterionId, position);
          break;
        }
        case "assignment": {
          const assignment = assignments.get(data.admissionId);
          if (!assignment) throw new Error("Assignment refers to missing admission");
          foxGoalId(data.workerSessionId, "worker session ID");
          if (assignment.workerSessionId && assignment.workerSessionId !== data.workerSessionId) throw new Error("Assignment changed its worker identity");
          assignment.workerSessionId = data.workerSessionId;
          assignment.workerFile = text(data.workerFile, "native worker file", 8192);
          break;
        }
        case "settle": {
          const assignment = assignments.get(data.admissionId);
          if (!assignment || !STATES.includes(data.state)) throw new Error("Invalid assignment settlement");
          if (["settled", "closed"].includes(assignment.state) && ACTIVE_ASSIGNMENTS.has(data.state)) throw new Error("A settled admission cannot be reopened");
          assignment.state = data.state;
          break;
        }
        case "review": reviews.set(data.review?.criterionId, data.review); reviewPositions.set(data.review?.criterionId, position); break;
        case "rebind": {
          const assignment = assignments.get(data.admissionId);
          if (!assignment) throw new Error("Cannot rebind a missing assignment");
          const previousRef = assignment.planItemRef;
          const nextRef = text(data.planItemRef, "native plan reference", 18000);
          for (const item of assignments.values()) if (item.planItemRef === previousRef) item.planItemRef = nextRef;
          break;
        }
        case "recovery":
          if (!["running", "next", "waiting", "uncertain"].includes(data.recovery)) throw new Error("Invalid native recovery marker");
          snapshot.recovery = data.recovery;
          if (typeof data.obligation === "string" && data.obligation.startsWith("resource:")) {
            const reason = data.obligation.slice("resource:".length);
            if (!["expired", "dispatch-limit", "rework-limit", "agent-tools-disabled"].includes(reason)) throw new Error("Invalid resource pause reason");
            snapshot.resourcePauseReason = reason;
          } else if (data.obligation === "resource-cleared:agent-tools-disabled" && snapshot.resourcePauseReason === "agent-tools-disabled") {
            delete snapshot.resourcePauseReason;
          }
          break;
        case "handoff": {
          if (!Array.isArray(data.reportIds) || !data.reportIds.length || typeof data.batchId !== "string") throw new Error("Invalid native report handoff");
          const delivered = matchingHandoffMessage(entries, entry);
          handoffs.set(entry.id, { id: entry.id, batchId: data.batchId, reportIds: data.reportIds, state: delivered ? "delivered" : "uncertain" });
          break;
        }
        case "handoff-resolve": {
          const handoff = handoffs.get(data.handoffEntryId);
          if (!handoff || !["delivered", "not-delivered"].includes(data.resolution)) throw new Error("Invalid native handoff resolution");
          const marker = records.find((item) => item.id === handoff.id);
          const delivered = matchingHandoffMessage(entries, marker);
          if (data.resolution === "delivered") {
            if (!delivered || delivered.id !== data.messageEntryId) throw new Error("Handoff resolution lacks native delivery proof");
            handoff.state = "delivered";
          } else {
            if (delivered || data.nativePaused !== true || data.noPendingInput !== true) throw new Error("Handoff absence proof conflicts with native delivery");
            const proofEnd = entries.findIndex((item) => item.id === data.checkedThroughEntryId);
            if (proofEnd < 0 || proofEnd >= entryPositions.get(entry.id)) throw new Error("Handoff absence proof has no prior journal boundary");
            resolveFoxGoalHandoff(entries.slice(0, proofEnd + 1), handoff.id, { idle: true, pending: false, paused: true });
            handoff.state = "not-delivered";
          }
          break;
        }
        case "notification": break;
        default: throw new Error("Unknown native fox-goal operation");
      }
    }
    snapshot.handoffs = [...handoffs.values()];
    snapshot.handledReportIds = [...new Set(snapshot.handoffs.filter((handoff) => handoff.state === "delivered").flatMap((handoff) => handoff.reportIds))];
    grant.revoked ||= invalidEpochs.has(grant.epoch);
    snapshot.assignments = [...assignments.values()];
    snapshot.dispatchesUsed = assignments.size;
    snapshot.reports = [...receipts.values()].filter((report) => report.goalId === grant.goalId && assignments.has(report.assignmentId)
      && assignments.get(report.assignmentId).workerSessionId === (report.assignmentWorkerSessionId ?? report.sourceSessionId) && assignments.get(report.assignmentId).cwd === pathKey(report.cwd));
    snapshot.staleReportIds = snapshot.reports.filter((report) => report.criterionIds.some((criterionId) => {
      const mutation = records[lastMutations.get(criterionId)];
      return mutation && (reportPositions.get(report.id) < entryPositions.get(mutation.id)
        || Number.isFinite(Date.parse(mutation.timestamp)) && Date.parse(report.at) < Date.parse(mutation.timestamp));
    })).map((report) => report.id);
    for (const review of reviews.values()) {
      try {
        const validated = validateFoxGoalReview(snapshot, review, false);
        if (validated.decision === "accept" && reviewPositions.get(review.criterionId) < (lastMutations.get(review.criterionId) ?? -1)) throw new Error("Evidence predates subsequent mutating dispatch for this criterion");
        snapshot.reviews.push(validated);
      } catch (error) {
        if (!record(review) || !terms.criteria.some((criterion) => criterion.id === review.criterionId)) throw error;
        snapshot.reviews.push({ ...review, decision: "reject" });
        snapshot.reason = `Stale or invalid review: ${error.message}`;
      }
    }
    if (snapshot.resourcePauseReason) snapshot.reason = `Goal resource authorization required: ${snapshot.resourcePauseReason}`;
    if (snapshot.handoffs.some((handoff) => handoff.state === "uncertain") || snapshot.assignments.some((item) => item.state === "uncertain")) snapshot.recovery = "uncertain";
    else if (grant.revoked || grant.paused) snapshot.recovery = "paused";
    return snapshot;
  } catch (error) {
    return { ...snapshot, supported: false, reason: error instanceof Error ? error.message : String(error), recovery: "uncertain" };
  }
}

function resourceError(reason, message) {
  return Object.assign(new Error(message), { foxGoalPauseReason: reason });
}

export function assertFoxGoalGrant(snapshot, requireActive = true) {
  if (!snapshot?.supported) throw new Error(snapshot?.reason || "Native goal capability is unavailable");
  const grant = snapshot.grant;
  if (!grant || !grant.goalId) throw new Error("No bound native goal grant");
  if (grant.revoked) throw new Error("The goal grant is revoked");
  if (grant.paused) throw new Error("The goal grant is user-paused");
  if (snapshot.resourcePauseReason) throw resourceError(snapshot.resourcePauseReason, snapshot.reason || "Goal resource authorization is required");
  if (grant.terms.expiresAt && Date.parse(grant.terms.expiresAt) <= Date.now()) throw resourceError("expired", "The goal grant expired");
  if (snapshot.goal?.goal?.id !== grant.goalId || snapshot.goal.goal.objective !== grant.terms.objective) throw new Error("Native goal identity or objective does not match consent");
  if (requireActive && (!snapshot.goal.enabled || snapshot.goal.goal.status !== "active")) throw new Error("The native goal is not active");
  return grant;
}

export function validateFoxGoalPlanRef(snapshot, reference) {
  let fallback;
  if (snapshot.planReferences?.includes(reference)) {
    try { fallback = JSON.parse(reference); } catch { /* A native task ID is not a fallback reference. */ }
  }
  const matches = snapshot.todoPhases.flatMap((phase) => phase.tasks.map((task) => ({ phase, task }))).filter(({ phase, task }) => task.id
    ? task.id === reference
    : Array.isArray(fallback) && fallback.length === 3 && phase.name === fallback[1] && task.content === fallback[2]);
  if (matches.length !== 1) throw new Error("Native plan item is missing or ambiguous; explicitly rebind the exact item");
  return matches[0].task;
}

function samePlanItem(snapshot, left, right) {
  if (left === right) return true;
  if (!snapshot.planReferences?.includes(left) || !snapshot.planReferences.includes(right)) return false;
  try {
    const a = JSON.parse(left), b = JSON.parse(right);
    return a.length === 3 && b.length === 3 && a[1] === b[1] && a[2] === b[2];
  } catch { return false; }
}

export function validateFoxGoalDispatch(snapshot, value, { toolName, input, projectKey, admissionId, sessionId, toolCallId, workerSessionIds }) {
  const grant = assertFoxGoalGrant(snapshot);
  const coordination = parseFoxGoalCoordination(value);
  if (coordination.grantEntryId !== grant.id || coordination.nativeGoalId !== grant.goalId) throw new Error("Dispatch references a different goal or grant");
  if (coordination.criterionIds.some((id) => !grant.terms.criteria.some((criterion) => criterion.id === id))) throw new Error("Dispatch references an unknown criterion");
  const plan = validateFoxGoalPlanRef(snapshot, coordination.planItemRef);
  if (["completed", "abandoned"].includes(plan.status)) throw new Error("Cannot dispatch a finished native plan item");
  const cwd = pathKey(projectKey);
  if (!input || pathKey(input.cwd) !== cwd || !grant.terms.projects.includes(cwd)) throw new Error("Dispatch cwd is outside the exact authorized projects");
  if (!["new_session", "send_to_session"].includes(toolName)) throw new Error("Unknown goal dispatch operation");
  if (input.wait === true) throw new Error("Goal dispatch must not wait for a worker turn; use wait:false and native report_to_parent handoff");
  if (typeof (toolName === "new_session" ? input.prompt : input.message) !== "string" || !(toolName === "new_session" ? input.prompt : input.message).trim()) throw new Error("A logical goal dispatch requires its initial prompt");
  const required = MUTATING.has(coordination.purpose) ? "implementation" : "verification";
  if (!grant.terms.operations.includes(required) && !(coordination.purpose === "evidence" && grant.terms.operations.includes("evidence"))) throw new Error("This dispatch purpose is not authorized");
  const admitted = admissionId === undefined ? null : snapshot.assignments.find((item) => item.id === admissionId);
  if (admissionId !== undefined && (!admitted || !["reserved", "running"].includes(admitted.state)
    || admitted.grantEntryId !== coordination.grantEntryId || admitted.goalId !== coordination.nativeGoalId || admitted.planItemRef !== coordination.planItemRef
    || admitted.purpose !== coordination.purpose || JSON.stringify(admitted.criterionIds) !== JSON.stringify(coordination.criterionIds) || admitted.cwd !== cwd
    || admitted.toolCallId !== toolCallId || admitted.toolName !== toolName || !sessionId
    || admitted.fingerprint !== foxActionFingerprint({ sessionId, toolCallId, toolName, input, projectKey }))) throw new Error("Admission does not match the exact pending action");
  if (snapshot.dispatchesUsed - (admitted ? 1 : 0) >= grant.terms.maxDispatches) throw resourceError("dispatch-limit", "Automatic dispatch limit reached; additional resource authorization is required");
  if (coordination.purpose === "rework" && snapshot.assignments.filter((item) => item.id !== admissionId && samePlanItem(snapshot, item.planItemRef, coordination.planItemRef) && item.purpose === "rework").length >= grant.terms.maxRework) throw resourceError("rework-limit", "Rework limit reached for this exact plan item");
  const active = snapshot.assignments.filter((item) => item.id !== admissionId && ACTIVE_ASSIGNMENTS.has(item.state));
  if (active.length >= grant.terms.maxWorkers) throw new Error("Concurrent worker limit reached");
  if (snapshot.recovery === "uncertain") throw new Error("Uncertain delivery must be reconciled before new side effects");
  const sameCwd = active.filter((item) => item.cwd === cwd);
  if (sameCwd.some((item) => MUTATING.has(item.purpose)) && coordination.purpose !== "evidence") throw new Error("A mutating writer still owns this cwd; revision verification must wait");
  if (MUTATING.has(coordination.purpose) && sameCwd.some((item) => item.purpose === "verification")) throw new Error("Revision verification still owns this cwd");
  if (toolName === "send_to_session") {
    foxGoalId(input.sessionId, "worker session ID");
    const verifiedIds = workerSessionIds ?? [input.sessionId];
    if (!verifiedIds.includes(input.sessionId) || !snapshot.assignments.some((item) => item.id !== admissionId && verifiedIds.includes(item.workerSessionId) && item.cwd === cwd && item.goalId === grant.goalId)) throw new Error("Follow-up worker is not bound to this goal and cwd");
    if (active.some((item) => verifiedIds.includes(item.workerSessionId))) throw new Error("Settle the worker's existing assignment before a follow-up");
  }
  return { ...coordination, cwd };
}

export function validateFoxGoalReview(snapshot, value, requireActive = true) {
  if (requireActive) assertFoxGoalGrant(snapshot);
  if (!record(value) || !snapshot.grant?.terms.criteria.some((criterion) => criterion.id === value.criterionId) || !["accept", "reject"].includes(value.decision)) throw new Error("Invalid criterion review");
  const reportIds = strings(value.reportIds, "received report IDs");
  const reports = reportIds.map((id) => {
    const report = snapshot.reports.find((item) => item.id === id);
    if (!report || !report.criterionIds?.includes(value.criterionId)) throw new Error("Review needs a received report belonging to this goal and criterion");
    if (value.decision === "accept" && snapshot.staleReportIds?.includes(id)) throw new Error("Received evidence is stale after a subsequent mutating dispatch");
    return report;
  });
  if (!Array.isArray(value.evidence) || value.evidence.length > 24) throw new Error("Invalid review evidence");
  const evidence = value.evidence.map(parseFoxGoalEvidence);
  if (value.decision === "accept") {
    if (!evidence.length) throw new Error("Acceptance requires observed evidence");
    for (const item of evidence) {
      const structured = reports.some((report) => report.structuredEvidence?.some((received) => JSON.stringify(parseFoxGoalEvidence(received)) === JSON.stringify(item)));
      const inspectedLegacy = item.kind === "artifact" && !item.revision && reports.some((report) => !report.structuredEvidence?.length
        && item.reference === `report:${report.id}` && [report.summary, ...report.evidence].some((text) => text.includes(item.observed)));
      if (!structured && !inspectedLegacy) throw new Error("Accepted evidence must exactly match received observed evidence or an explicit inspected legacy report excerpt");
      if (item.revision && snapshot.reports.some((report) => report.criterionIds?.includes(value.criterionId) && reports.some((source) => source.cwd === report.cwd && Date.parse(report.at) > Date.parse(source.at) || source.sourceSessionId === report.sourceSessionId && report.sequence > source.sequence)
        && report.structuredEvidence?.some((other) => other.revision && other.revision !== item.revision))) throw new Error("Evidence revision is stale");
    }
    if (reports.some((report) => ["needs_input", "blocked", "failed", "cancelled"].includes(report.status))) throw new Error("A blocked or unresolved report cannot establish acceptance");
  }
  return { criterionId: value.criterionId, decision: value.decision, reportIds, evidence };
}

export function assertFoxGoalComplete(snapshot) {
  const grant = assertFoxGoalGrant(snapshot);
  if (snapshot.assignments.some((assignment) => ACTIVE_ASSIGNMENTS.has(assignment.state))) throw new Error("Every assignment must be settled; uncertain dispatch cannot complete");
  if (snapshot.recovery === "uncertain") throw new Error("Uncertain native handoff or recovery cannot complete");
  for (const assignment of snapshot.assignments) validateFoxGoalPlanRef(snapshot, assignment.planItemRef);
  for (const criterion of grant.terms.criteria) {
    const review = snapshot.reviews.find((item) => item.criterionId === criterion.id && item.decision === "accept");
    if (!review) throw new Error(`Criterion ${criterion.id} needs a current accepted evidence review`);
    validateFoxGoalReview(snapshot, review);
  }
  const latest = new Map();
  for (const report of snapshot.reports) if (!latest.has(report.sourceSessionId) || latest.get(report.sourceSessionId).sequence < report.sequence) latest.set(report.sourceSessionId, report);
  if ([...latest.values()].some((report) => report.status === "needs_input" || report.status === "blocked")) throw new Error("A worker decision is unresolved");
  if (snapshot.todoPhases.some((phase) => phase.tasks.some((task) => !["completed", "abandoned"].includes(task.status)))) throw new Error("Reconcile the native todo plan before completing the goal");
}
