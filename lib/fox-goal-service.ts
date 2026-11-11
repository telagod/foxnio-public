import type { FoxGoalSnapshot } from "./fox-goal-types";
import { projectFoxGoal, nativeFoxGoalFromEntries, foxGoalTodo } from "./omp/fox-goals.mjs";
import { readFoxGoalJournal } from "./fox-goal-journal";
import { readFoxSessionRecord } from "./fox-session";
import { isFoxWorkspacePath } from "./fox";
import { closeFoxGoalAdmissions, getRpcSession, getLiveRpcSessionStates, isWebRpcError, startRpcSession, type AgentSessionWrapper } from "./rpc-manager";
import { readSessionHeader, resolveSessionPath, listAllSessions } from "./session-reader";
import { sameNativeConversation, nativeSessionLineage } from "./omp/session-lineage";
import { reconcileFoxReports, flushFoxReports, readFoxReportJournal } from "./fox-report-store";
import { reconcileFoxGoalNotifications } from "./fox-goal-notifications";
import { loadWebServerSettings } from "./web-settings";
import { foxDispatchProjectKey } from "./fox-service-config";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { getArchivedSessionsDir, getSessionsDir } from "./omp/paths";

function hasNativeGoalAuthority(entries: Record<string, unknown>[]): boolean {
  return entries.some((entry) => entry.customType === "fox-goal" || entry.customType === "fox-goal-worker"
    || entry.type === "mode_change" && ["goal", "goal_paused"].includes(String(entry.mode)));
}

async function verifiedLegacyConversation(file: string, sessionId: string): Promise<boolean> {
  const header = readSessionHeader(file);
  if (!header || header.id !== sessionId || !isFoxWorkspacePath(header.cwd)) return false;
  const journal = await readFoxGoalJournal(file);
  return journal.sessionId === sessionId && !hasNativeGoalAuthority(journal.entries);
}

/** A missing path alone is not absence: a continuation or surviving worker may
 * still refer to it. The display listing is lenient, so it cannot prove this. */
async function proveMissingFoxConversation(sessionId: string): Promise<void> {
  const inventory = async (directory: string): Promise<string[]> => {
    let projects;
    try { projects = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    if (projects.length > 4096) throw new Error("Native session inventory exceeds the safe absence-proof limit");
    const files: string[] = [];
    for (const project of projects) {
      if (project.isSymbolicLink()) throw new Error("Native session inventory contains an unverified link");
      if (project.isFile() && project.name.endsWith(".jsonl")) files.push(join(directory, project.name));
      if (!project.isDirectory()) continue;
      const children = await readdir(join(directory, project.name), { withFileTypes: true });
      for (const child of children) {
        if (child.name.endsWith(".jsonl")) {
          if (!child.isFile()) throw new Error("Native session inventory contains an unverified file");
          files.push(join(directory, project.name, child.name));
        }
      }
      if (files.length > 4096) throw new Error("Native session inventory exceeds the safe absence-proof limit");
    }
    return files.sort();
  };
  // Archived transcripts are not in the live path resolver. Their presence
  // requires explicit recovery instead of claiming they contain no authority.
  try {
    if ((await readdir(getArchivedSessionsDir())).length) throw new Error("Archived native sessions prevent proving the missing FOX conversation has no goal authority");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const directory = getSessionsDir();
  const files = await inventory(directory);
  const visited = new Set<string>();
  for (const file of files) {
    const header = readSessionHeader(file);
    if (!header) throw new Error("A native session header is unreadable; FOX reset cannot prove absence");
    const parent = String(header.parentSession ?? "");
    if (header.id === sessionId || header.continuationOf === sessionId || parent === sessionId || basename(parent).includes(sessionId)) {
      throw new Error("The missing FOX conversation still has native identity or lineage references");
    }
    if (visited.has(file)) continue;
    const journal = await readFoxGoalJournal(file);
    for (const member of journal.files) visited.add(member);
    if (journal.entries.some((entry) => {
      const data = entry.data && typeof entry.data === "object" ? entry.data as Record<string, unknown> : null;
      return data?.sessionId === sessionId || data?.parentSessionId === sessionId;
    })) throw new Error("The missing FOX conversation still owns native journal records");
  }
  if (JSON.stringify(files) !== JSON.stringify(await inventory(directory))) throw new Error("Native session inventory changed during the absence proof");
}

interface GoalServiceState {
  reconcile: Promise<void> | null;
  control: Promise<unknown>;
  controlVersion: number;
}
declare global { var __foxGoalService: GoalServiceState | undefined; }
function state(): GoalServiceState {
  return globalThis.__foxGoalService ??= { reconcile: null, control: Promise.resolve(), controlVersion: 0 };
}
function empty(reason?: string): FoxGoalSnapshot {
  return { ...projectFoxGoal([]), ...(reason ? { supported: false, reason } : {}) } as FoxGoalSnapshot;
}

function closeLiveFoxAdmissions(): void {
  closeFoxGoalAdmissions();
}

async function currentWrapper(): Promise<AgentSessionWrapper | null> {
  const pointer = await readFoxSessionRecord();
  if (!pointer.sessionId) return null;
  let wrapper = getRpcSession(pointer.sessionId);
  if (!wrapper?.isAlive()) {
    const file = await resolveSessionPath(pointer.sessionId);
    const header = file ? readSessionHeader(file) : null;
    if (!file || !header || header.id !== pointer.sessionId || !isFoxWorkspacePath(header.cwd)) throw new Error("The current FOX native conversation is unavailable");
    wrapper = (await startRpcSession(header.id, file, header.cwd, undefined, undefined, header.cwd)).session;
  }
  const after = await readFoxSessionRecord();
  if (!isFoxWorkspacePath(wrapper.cwd) || after.resetAt !== pointer.resetAt || getRpcSession(after.sessionId ?? "") !== wrapper) throw new Error("FOX changed conversations during goal control");
  return wrapper;
}

function currentBranch(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  let entry = entries.at(-1);
  while (entry) {
    if (seen.has(entry.id)) throw new Error("Native goal branch is cyclic");
    seen.add(entry.id);
    branch.push(entry);
    if (!entry.parentId) break;
    entry = byId.get(entry.parentId);
    if (!entry) throw new Error("Native goal branch is incomplete");
  }
  return branch.reverse();
}

export async function getFoxGoalSnapshot(): Promise<FoxGoalSnapshot> {
  const pointer = await readFoxSessionRecord();
  if (!pointer.sessionId) return empty();
  try {
    const live = getRpcSession(pointer.sessionId);
    if (live?.isAlive()) return await live.getFoxGoalSnapshot();
    const file = await resolveSessionPath(pointer.sessionId);
    if (!file || !isFoxWorkspacePath(readSessionHeader(file)?.cwd ?? "")) throw new Error("Current FOX conversation cannot be read");
    const journal = await readFoxGoalJournal(file);
    const ignored = new Set(journal.ignoredEntryIds ?? []);
    const branch = currentBranch(journal.currentEntries).filter((entry) => !ignored.has(String(entry.id)));
    const todo = foxGoalTodo(branch);
    const snapshot = projectFoxGoal(journal.entries, nativeFoxGoalFromEntries(branch), todo.todoPhases) as FoxGoalSnapshot;
    if (journal.entries.some((entry) => entry.customType === "fox-goal" && entry.data && typeof entry.data === "object"
      && !journal.sessionIds.includes(String((entry.data as Record<string, unknown>).sessionId)))) throw new Error("A fork cannot inherit another native goal authorization");
    if (todo.planEntryId) snapshot.planEntryId = todo.planEntryId;
    snapshot.planReferences = todo.planReferences;
    snapshot.inheritedGoalIds = journal.inheritedGoalIds ?? [];
    const after = await readFoxSessionRecord();
    if (after.sessionId !== pointer.sessionId || after.resetAt !== pointer.resetAt) throw new Error("FOX changed conversations while reading its goal");
    return snapshot;
  } catch (error) {
    return empty(error instanceof Error ? error.message : String(error));
  }
}

/** Unavailable goal RPC is a capability issue, not permission to ignore
 * damaged authority. Only a strict complete legacy journal permits fallback. */
export async function foxGoalAllowsObservation(snapshot: FoxGoalSnapshot): Promise<boolean> {
  if (snapshot.supported) return !snapshot.grant || snapshot.grant.revoked || snapshot.goal?.goal.status === "complete";
  const pointer = await readFoxSessionRecord();
  if (!pointer.sessionId) return true;
  try {
    const live = getRpcSession(pointer.sessionId);
    const file = live?.sessionFile || await resolveSessionPath(pointer.sessionId);
    if (!file || live?.isAlive() && (!isFoxWorkspacePath(live.cwd) || live.sessionId !== pointer.sessionId)) return false;
    const legacy = await verifiedLegacyConversation(file, pointer.sessionId);
    const after = await readFoxSessionRecord();
    return legacy && after.sessionId === pointer.sessionId && after.resetAt === pointer.resetAt;
  } catch { return false; }
}

/** Recovery intent is native persisted evidence, not a host continuation loop.
 * No-progress and waiting never become permission to start a timer prompt. */
export function shouldRecoverFoxGoal(snapshot: FoxGoalSnapshot): boolean {
  const { grant, goal } = snapshot;
  if (snapshot.resourcePauseReason) return false;
  if (snapshot.supported && grant && !grant.goalId && !grant.revoked && !grant.paused && (!goal || goal.goal.status === "complete" || snapshot.inheritedGoalIds?.includes(goal.goal.id) || grant.replacesGoalId === goal.goal.id)
    && snapshot.recovery === "next" && (!grant.terms.expiresAt || Date.parse(grant.terms.expiresAt) > Date.now())
    && !snapshot.assignments.some((assignment) => ["reserved", "running", "uncertain"].includes(assignment.state))) return true;
  return Boolean(snapshot.supported && grant?.goalId && !grant.revoked && !grant.paused
    && goal?.goal.id === grant.goalId && goal.goal.objective === grant.terms.objective
    && goal.goal.status === "paused" && !goal.reason
    && (goal.goal.tokenBudget === undefined || goal.goal.tokensUsed < goal.goal.tokenBudget)
    && (!grant.terms.expiresAt || Date.parse(grant.terms.expiresAt) > Date.now())
    && ["running", "next"].includes(snapshot.recovery)
    && !snapshot.assignments.some((assignment) => ["reserved", "uncertain"].includes(assignment.state)));
}

export async function controlFoxGoal(action: "pause" | "resume" | "stop" | "reset"): Promise<FoxGoalSnapshot> {
  if (!["pause", "resume", "stop", "reset"].includes(action)) throw new Error("Invalid FOX goal control");
  const controlVersion = ++state().controlVersion;
  // Close local admission before awaiting durable pointer I/O. A cached
  // pointer must never choose which conversation retains execution authority.
  if (action !== "resume") closeLiveFoxAdmissions();
  const pointer = await readFoxSessionRecord();
  if (!pointer.sessionId) return empty();
  const sessionId = pointer.sessionId;
  const run = async () => {
    const beforePointer = await readFoxSessionRecord();
    if (beforePointer.sessionId !== pointer.sessionId || beforePointer.resetAt !== pointer.resetAt) throw new Error("FOX changed conversations before goal control");
    if (action === "reset" && !getRpcSession(sessionId)?.isAlive()) {
      const file = await resolveSessionPath(sessionId);
      if (file && await verifiedLegacyConversation(file, sessionId)) {
        if (getRpcSession(sessionId)?.isAlive()) throw new Error("FOX became live during legacy reset proof");
        return empty();
      }
      if (!file) {
        await proveMissingFoxConversation(sessionId);
        if (getRpcSession(sessionId)?.isAlive()) throw new Error("FOX became live during reset absence proof");
        return empty();
      }
    }
    const wrapper = await currentWrapper();
    if (!wrapper) throw new Error("FOX conversation is unavailable");
    if (action !== "resume") wrapper.closeFoxGoalAdmission();
    await wrapper.waitFoxGoalEffects();
    const before = await wrapper.getFoxGoalSnapshot();
    if (!before.supported) throw new Error(before.reason ?? "Native goal control is unavailable");
    if (action === "resume") {
      if (!before.grant || before.grant.revoked) throw new Error("The FOX grant has been revoked or is missing");
      if (controlVersion !== state().controlVersion) throw new Error("A newer FOX control superseded Resume");
      await wrapper.foxGoalCommand("control", { action: "resume", grantEntryId: before.grant.id });
      if (controlVersion !== state().controlVersion) throw new Error("A newer FOX control superseded Resume");
      await wrapper.activateFoxGoal(true);
    } else {
      // Durable native permission closes before pause/drop and before reset's
      // pointer clear. Any failure remains visible; no best-effort success ACK.
      await wrapper.foxGoalCommand("control", { action: action === "stop" ? "revoke" : action, ...(before.grant ? { grantEntryId: before.grant.id } : {}) });
      if (before.goal?.goal) await wrapper.nativeGoal(action === "pause" ? "pause" : "drop");
      if (action === "stop" || action === "reset") {
        const failures: string[] = [];
        const workers = getLiveRpcSessionStates();
        for (const assignment of before.assignments) {
          if (["settled", "closed"].includes(assignment.state)) continue;
          const worker = workers.find((item) => item.id === assignment.workerSessionId || assignment.workerFile
            && getRpcSession(item.id)?.sessionFile && sameNativeConversation(assignment.workerFile, getRpcSession(item.id)!.sessionFile));
          const target = worker ? getRpcSession(worker.id) : undefined;
          if (!target || target === wrapper) {
            const terminal = before.reports.some((report) => report.assignmentId === assignment.id && ["result", "failed", "cancelled"].includes(report.status));
            if (!terminal) failures.push(`${assignment.id}: worker cancellation cannot be verified; inspect its exact native worker`);
            else await wrapper.foxGoalCommand("settle", { admissionId: assignment.id, state: "closed" });
            continue;
          }
          try {
            await target.send({ type: "abort" });
            const settled = await target.send({ type: "get_state" }) as { isSettled?: boolean; hasPendingAsyncWork?: boolean; isStreaming?: boolean; queuedMessageCount?: number };
            if (settled.isSettled !== true || settled.hasPendingAsyncWork || settled.isStreaming || settled.queuedMessageCount) throw new Error("Worker cancellation has not settled natively");
            await wrapper.foxGoalCommand("settle", { admissionId: assignment.id, state: "closed" });
          } catch (error) { failures.push(`${worker!.id}: ${error instanceof Error ? error.message : String(error)}`); }
        }
        if (failures.length) throw new Error(`Native goal revoked, but worker abort failed: ${failures.join("; ")}`);
      }
    }
    return await wrapper.getFoxGoalSnapshot();
  };
  const operation = state().control.then(run, run);
  state().control = operation;
  return operation;
}

/** The settings route passes actual changed keys intersecting the grant it
 * just read. Close admission before any await; policy change is not Stop and
 * must neither drop the native goal nor abort already admitted workers. */
export async function invalidateFoxGoalPolicy(changedProjectKeys: readonly string[]): Promise<FoxGoalSnapshot> {
  const changed = new Set(changedProjectKeys.map(foxDispatchProjectKey));
  if (!changed.size) return getFoxGoalSnapshot();
  ++state().controlVersion;
  closeLiveFoxAdmissions();
  const pointer = await readFoxSessionRecord();
  if (!pointer.sessionId) return empty();
  const run = async () => {
    const current = await readFoxSessionRecord();
    if (current.sessionId !== pointer.sessionId || current.resetAt !== pointer.resetAt) throw new Error("FOX changed conversations before policy revocation");
    const wrapper = await currentWrapper();
    if (!wrapper) throw new Error("FOX conversation is unavailable for policy revocation");
    wrapper.closeFoxGoalAdmission();
    await wrapper.waitFoxGoalEffects();
    const snapshot = await wrapper.getFoxGoalSnapshot();
    if (!snapshot.supported) throw new Error(snapshot.reason ?? "Native goal policy revocation is unavailable");
    const grant = snapshot.grant;
    if (!grant || !grant.terms.projects.some((project) => changed.has(foxDispatchProjectKey(project)))) {
      throw new Error("The changed policy no longer matches the current FOX grant; native admission remains closed");
    }
    await wrapper.foxGoalCommand("control", { action: "revoke", grantEntryId: grant.id });
    const native = await wrapper.nativeGoal("get");
    if (native.goal) await wrapper.nativeGoal("pause");
    return await wrapper.getFoxGoalSnapshot();
  };
  const operation = state().control.then(run, run);
  state().control = operation;
  return operation;
}

export async function reconcileFoxGoal(): Promise<void> {
  const service = state();
  if (service.reconcile) return service.reconcile;
  const run = async () => {
    // This entry is invoked by the existing service tick regardless of
    // observation enabled/quiet hours/daily observation allowance.
    const initial = await getFoxGoalSnapshot();
    if (!initial.supported || !initial.grant || initial.grant.revoked) return;
    if (!loadWebServerSettings().agentToolsEnabled) {
      if (!initial.grant.paused && initial.goal?.goal.status !== "complete") await controlFoxGoal("pause");
      return;
    }
    if (initial.grant.goalId && initial.grant.terms.expiresAt && Date.parse(initial.grant.terms.expiresAt) <= Date.now()
      && !initial.grant.paused && initial.goal?.goal.status !== "complete") {
      const expired = await currentWrapper();
      if (expired) await expired.pauseFoxGoalResource(initial.grant.id, initial.grant.goalId, "expired");
      return;
    }
    const wrapper = await currentWrapper();
    if (!wrapper || wrapper.isRunning() || wrapper.isEditingHistory() || wrapper.pendingHumanRequests()) return;
    let snapshot = await wrapper.getFoxGoalSnapshot();
    const uncertainHandoffs = snapshot.handoffs?.filter((handoff) => handoff.state === "uncertain") ?? [];
    if (uncertainHandoffs.length && snapshot.goal?.goal.status === "active") {
      await wrapper.nativeGoal("pause");
      snapshot = await wrapper.getFoxGoalSnapshot();
    }
    if (uncertainHandoffs.length && snapshot.goal?.goal.status === "paused" && !snapshot.grant?.paused) {
      for (const handoff of uncertainHandoffs) {
        snapshot = await wrapper.foxGoalCommand("handoff-resolve", { handoffEntryId: handoff.id });
      }
    }
    for (const assignment of snapshot.assignments) {
      if (assignment.state !== "reserved") continue;
      let provedAccepted = snapshot.reports.some((report) => report.assignmentId === assignment.id);
      if (!provedAccepted && assignment.workerFile) {
        const lineage = nativeSessionLineage(assignment.workerFile);
        const journal = await readFoxReportJournal(assignment.workerFile);
        provedAccepted = !journal.invalid && journal.outbox.some((report) => report.assignmentId === assignment.id
          && report.goalId === assignment.goalId && report.cwd === assignment.cwd
          && lineage?.some((item) => item.header.id === report.sourceSessionId));
      }
      // Native outbox proves a worker actually began. Without that proof a
      // bound file alone cannot justify recreating/re-sending after a crash.
      snapshot = await wrapper.foxGoalCommand("settle", { admissionId: assignment.id, state: provedAccepted ? "running" : "uncertain" });
    }
    if (shouldRecoverFoxGoal(snapshot)) {
      if (!await wrapper.activateFoxGoal()) return;
      snapshot = await wrapper.getFoxGoalSnapshot();
    }
    try {
      await reconcileFoxGoalNotifications(snapshot, async (record) => { await wrapper.foxGoalCommand("notification", record); });
    } catch (error) { console.warn("[fox-goal] notification receipt failed", error); }
    if (snapshot.grant?.paused || snapshot.grant?.revoked || snapshot.assignments.some((a) => a.state === "uncertain") || wrapper.isRunning()) return;
    await reconcileFoxReports(await listAllSessions());
    await flushFoxReports();
    snapshot = await wrapper.getFoxGoalSnapshot();
    const reviewed = new Set([...snapshot.reviews.flatMap((review) => review.reportIds), ...(snapshot.handledReportIds ?? [])]);
    const reportIds = snapshot.reports.filter((report) => !reviewed.has(report.id)
      && !["accepted", "progress"].includes(report.status)).map((report) => report.id).slice(0, 256);
    if (reportIds.length && snapshot.goal?.goal.status === "paused" && !snapshot.goal.reason && snapshot.recovery !== "uncertain") {
      // A new external report is an actual wake obligation, unlike a timer.
      if (!await wrapper.activateFoxGoal()) return;
      snapshot = await wrapper.getFoxGoalSnapshot();
    }
    if (reportIds.length && snapshot.goal?.goal.status === "active" && snapshot.goal.enabled) {
      // Extension persists/consumes batch identity. Busy is retained; ambiguous
      // submissions reconcile there and never gain a fresh logical action.
      snapshot = await wrapper.foxGoalCommand("handoff", { reportIds });
    }
  };
  const operation = run().catch((error) => {
    if (isWebRpcError(error) && ["session_restarting", "session_busy"].includes(error.code)) return;
    throw error;
  }).finally(() => { if (service.reconcile === operation) service.reconcile = null; });
  service.reconcile = operation;
  return operation;
}
