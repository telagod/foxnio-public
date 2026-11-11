import { buildBriefing, type Briefing, type LiveSessionState } from "./briefing";
import { comparableProjectPath } from "./comparable-path";
import { foxWorkspaceDir } from "./fox-workspace";
import { nativeFoxWorkers } from "./fox-native-work";
import { foxDispatchProjectKey } from "./fox-service-config";
import { getLiveRpcSessionStates } from "./rpc-manager";
import { resolveSessionPath } from "./session-reader";
import type { SessionInfo } from "./types";
import { foxWorkerParent } from "./fox-report-store";
import { nativeSessionFamily, nativeSessionLineage } from "./omp/session-lineage";
import type { FoxReportView } from "./fox-report-types";
import { readDurableSnapshot } from "./session-index";
import { getFoxReportDisplay } from "./fox-display";

/**
 * Server-side read model used by both GET /api/briefing and the FOX service.
 *
 * It composes only the existing session/live/notification/registry views: no
 * agent is started, no OMP state is written and no transcript is read.
 */
export interface BriefingSnapshot {
  briefing: Briefing;
  warnings: string[];
  /**
   * Source rows behind `briefing`. Internal to server-side consumers (the
   * resident service uses them for observation); HTTP routes return
   * only `briefing`.
   */
  sessions: SessionInfo[];
  live: LiveSessionState[];
}

export interface BriefingSnapshotOptions {
  days?: number;
  excludeSessionId?: string | null;
  now?: number;
}

export async function loadBriefingSnapshot(options: BriefingSnapshotOptions = {}): Promise<BriefingSnapshot> {
  const snapshot = await readDurableSnapshot();
  const warnings = [...snapshot.warnings, ...snapshot.staleSources.map((source) => `stale:${source}`)];
  const now = options.now ?? Date.now();
  const foxCwd = comparableProjectPath(foxWorkspaceDir());
  const coordinatorIds = new Set(snapshot.data.sessions.filter((session) => comparableProjectPath(session.cwd) === foxCwd).map((session) => session.id));
  const sessions = snapshot.data.sessions.filter((session) => comparableProjectPath(session.cwd) !== foxCwd);
  const notifications = snapshot.data.notifications;

  const live = getLiveRpcSessionStates();
  const briefing = buildBriefing({
    sessions,
    projects: snapshot.data.projects,
    live,
    notifications,
    now,
    days: options.days,
    excludeSessionId: options.excludeSessionId ?? null,
    warnings,
  });

  // Native session lineage answers "what did FOX hand off?" without a dispatch
  // ledger. Live execution state is kept separate from task completion, which
  // belongs to OMP's own todo list and the conversation's evidence.
  try {
    const current = snapshot.data.foxPointer.sessionId;
    const reports = new Map<string, FoxReportView>();
    const groups = new Map<string, { session: SessionInfo; copies: SessionInfo[]; ids: Set<string> }>();
    for (const session of sessions) {
      const parent = foxWorkerParent(session.path);
      const id = parent?.lineage.at(-1)?.header.id ?? session.id;
      const parentId = parent?.parent.id ?? session.parentSessionId;
      if (!parentId || !coordinatorIds.has(parentId)) continue;
      const projected = { ...session, id, parentSessionId: parentId };
      const group = groups.get(id) ?? { session: projected, copies: [], ids: new Set<string>() };
      if (Date.parse(session.modified) > Date.parse(group.session.modified)) group.session = projected;
      group.copies.push(session);
      for (const link of parent?.lineage ?? []) group.ids.add(link.header.id);
      group.ids.add(session.id);
      groups.set(id, group);
    }
    const workers = [...groups.values()].map((group) => group.session);
    const workerLive: LiveSessionState[] = [];
    for (let index = 0; index < workers.length; index += 8) {
      await Promise.all(workers.slice(index, index + 8).map(async (worker) => {
        const group = groups.get(worker.id)!;
        const views = await Promise.all(group.copies.map((copy) => getFoxReportDisplay(copy.path)));
        const view = views.reduce((latest, item) => !latest?.report || item.report && Date.parse(item.report.at) >= Date.parse(latest.report.at) ? item : latest, views[0]);
        reports.set(worker.id, { ...view, sourceSessionIds: [...group.ids] });
        const selected = nativeSessionLineage(worker.path)?.[0].header.id;
        const runtime = live.find((state) => group.ids.has(state.id) && state.pendingInput)
          ?? live.find((state) => group.ids.has(state.id) && state.running)
          ?? live.find((state) => state.id === selected);
        if (runtime) workerLive.push({ ...runtime, id: worker.id });
      }));
    }
    const currentFile = current ? await resolveSessionPath(current) : undefined;
    const currentIds = new Set(currentFile ? nativeSessionFamily(currentFile).flatMap((file) => nativeSessionLineage(file)?.[0]?.header.id ?? []) : current ? [current] : []);
    briefing.workers = nativeFoxWorkers(workers, workerLive, currentIds, reports);
    for (const id of currentIds) coordinatorIds.delete(id);
    briefing.historicalWorkers = nativeFoxWorkers(workers, workerLive, coordinatorIds, reports)
      .filter((worker) => worker.state !== "idle" || worker.report && Date.parse(worker.report.at) >= now - 7 * 86_400_000);
    const attentionIds = new Set(briefing.needsYou.map((item) => item.sessionId));
    for (const worker of [...briefing.workers, ...briefing.historicalWorkers]) {
      const report = worker.report;
      if (!report || attentionIds.has(worker.sessionId)) continue;
      const kind = report.status === "needs_input" ? "input" : report.status === "blocked" ? "blocked"
        : report.status === "failed" && worker.state !== "running" ? "error" : null;
      if (kind) {
        briefing.needsYou.push({
          id: `${worker.sessionId}:${kind}`, kind, sessionId: worker.sessionId, sessionName: worker.title,
          projectKey: worker.projectKey, projectName: worker.projectName, detail: report.summary.slice(0, 600), at: report.at,
        });
        attentionIds.add(worker.sessionId);
      }
    }
    for (const project of briefing.projects) project.policyKey = foxDispatchProjectKey(project.path);
  } catch {
    warnings.push("fox-workers");
    // buildBriefing copied the array; keep the response and the warning list
    // in step when a later source fails.
    briefing.warnings = [...warnings];
  }

  return { briefing, warnings, sessions, live };
}
