"use client";

import { AlertCircle, ArrowUpRight, Pause, Play, RefreshCw, Square, Target } from "lucide-react";
import type { FoxGoalState } from "@/hooks/useFoxGoal";
import { useI18n } from "@/lib/i18n";

export function FoxGoalPanel({ state, onOpenSession, onDiscuss }: {
  state: FoxGoalState;
  onOpenSession: (sessionId: string) => void;
  onDiscuss: (prompt: string) => void;
}) {
  const { t, locale } = useI18n();
  const snapshot = state.snapshot;
  const native = snapshot?.goal?.goal;
  const grant = snapshot?.grant;
  const terms = grant?.terms;
  const tasks = snapshot?.todoPhases.flatMap((phase) => phase.tasks) ?? [];
  const next = tasks.find((item) => item.status === "in_progress") ?? tasks.find((item) => item.status === "pending");
  const assignments = snapshot?.assignments ?? [];
  const occupied = assignments.filter((item) => item.state !== "settled" && item.state !== "closed");
  const paused = native?.status === "paused" || Boolean(grant?.paused);
  const expired = Boolean(terms?.expiresAt && Date.parse(terms.expiresAt) <= Date.now());
  const validGrant = Boolean(grant && native && grant.goalId === native.id && !grant.revoked && !expired);
  const controlsDisabled = !snapshot?.supported || Boolean(state.pending) || Boolean(state.error);
  const reviews = new Map(snapshot?.reviews.map((review) => [review.criterionId, review]));
  const reports = snapshot?.reports ?? [];
  const latestReports = new Map<string, (typeof reports)[number]>();
  for (const report of reports) {
    const previous = latestReports.get(report.sourceSessionId);
    if (!previous || report.sequence > previous.sequence) latestReports.set(report.sourceSessionId, report);
  }
  const questions = [...latestReports.values()].filter((report) => report.status === "needs_input"
    && (!report.assignmentId || assignments.some((item) => item.id === report.assignmentId && item.state !== "settled" && item.state !== "closed")));
  const nativeState = native?.status ?? "none";
  const knownState = ["active", "paused", "complete", "budget-limited", "dropped"].includes(nativeState) ? nativeState : "unknown";

  return (
    <section className="fox-goal-panel" aria-label={t("fox.goal.title")} aria-busy={state.loading || Boolean(state.pending)}>
      <div className="fox-goal-heading"><h3><Target size={16} aria-hidden="true" />{t("fox.goal.title")}</h3><button type="button" className="fox-native-icon" aria-label={t("fox.goal.refresh")} disabled={state.refreshing || Boolean(state.pending)} onClick={() => void state.refresh()}><RefreshCw size={15} className={state.refreshing ? "icon-spin" : ""} /></button></div>
      {state.error && <p className="fox-native-source-warning" role="alert"><AlertCircle size={15} aria-hidden="true" />{state.error}</p>}
      {!snapshot ? <p className="fox-goal-note" role="status">{t(state.loading ? "fox.goal.loading" : "fox.goal.unknown")}</p> : <>
        {!snapshot.supported && <div className="fox-native-source-warning" role="status"><AlertCircle size={15} aria-hidden="true" /><div><strong>{t("fox.goal.unsupported")}</strong><p>{snapshot.reason || t("fox.goal.unsupportedHint")}</p></div></div>}
        {native ? <>
          <p className="fox-goal-objective">{native.objective}</p>
          <div className="fox-goal-badges"><span data-state={knownState}>{t(`fox.goal.state.${knownState}`)}</span>{!["complete", "dropped"].includes(native.status) && <span>{t(`fox.goal.recovery.${snapshot.recovery}`)}</span>}</div>
          <p className="fox-goal-next"><strong>{t("fox.goal.next")}</strong><span>{next?.content || t(native.status === "complete" ? "fox.goal.nativeCompleted" : "fox.goal.noActionableStep")}</span></p>
        </> : <>
          <p className="fox-goal-objective">{terms?.objective || t("fox.goal.noGoal")}</p>
          <p className="fox-goal-note">{t("fox.goal.noGoalHint")}</p>
        </>}
        {snapshot.supported && (snapshot.reason || snapshot.goal?.reason) && <p className="fox-native-source-warning" role="status"><AlertCircle size={15} aria-hidden="true" />{snapshot.reason || snapshot.goal?.reason}</p>}
        {grant && <p className="fox-goal-note" data-warning={grant.revoked || expired}>{t(grant.revoked ? "fox.goal.grantRevoked" : expired ? "fox.goal.grantExpired" : grant.paused ? "fox.goal.grantPaused" : validGrant ? "fox.goal.grantActive" : "fox.goal.grantUnbound")}</p>}
        {native && !grant && <p className="fox-native-source-warning">{t("fox.goal.noGrant")}</p>}
        {((native || grant) && native?.status !== "complete" || occupied.length > 0) && <>
          <div className="fox-goal-controls">
            {native?.status === "active" && !paused && <button type="button" className="fox-button" disabled={controlsDisabled} onClick={() => void state.control("pause")}><Pause size={14} aria-hidden="true" />{t("fox.goal.pause")}</button>}
            {paused && <button type="button" className="fox-button" disabled={controlsDisabled || !validGrant} onClick={() => void state.control("resume")}><Play size={14} aria-hidden="true" />{t("fox.goal.resume")}</button>}
            {Boolean(native && native.status !== "complete" || grant && !grant.revoked && native?.status !== "complete" || occupied.length > 0) && <button type="button" className="fox-button fox-goal-stop" disabled={controlsDisabled} onClick={() => void state.control("stop")}><Square size={13} aria-hidden="true" />{t("fox.goal.stop")}</button>}
          </div>
          <p className="fox-goal-note">{t("fox.goal.controlHint")}</p>
        </>}
        {state.pending && <p className="fox-goal-note" role="status">{t(`fox.goal.pending.${state.pending}`)}</p>}
        {state.controlError && <p className="fox-native-source-warning" role="alert">{state.controlError}</p>}
        {terms && <>
          <dl className="fox-goal-budgets">
            <div><dt>{t("fox.goal.workers")}</dt><dd>{occupied.length} / {terms.maxWorkers}</dd></div>
            <div><dt>{t("fox.goal.dispatchesRemaining")}</dt><dd>{Math.max(0, terms.maxDispatches - snapshot.dispatchesUsed)} / {terms.maxDispatches}</dd></div>
            <div><dt>{t("fox.goal.reworkLimit")}</dt><dd>{terms.maxRework}</dd></div>
            <div><dt>{t("fox.goal.tokens")}</dt><dd>{native?.tokensUsed?.toLocaleString(locale) ?? "—"} / {native ? native.tokenBudget?.toLocaleString(locale) ?? t("fox.goal.noTokenLimit") : terms.tokenBudget?.toLocaleString(locale) ?? "—"}</dd></div>
          </dl>
          <p className="fox-goal-note">{t("fox.goal.tokenHint")}</p>
          <details className="fox-goal-details"><summary>{t("fox.goal.scope")}</summary>
            <h4>{t("fox.goal.projects")}</h4><ul>{terms.projects.map((project) => <li key={project}><code>{project}</code></li>)}</ul>
            <h4>{t("fox.goal.operations")}</h4><ul>{terms.operations.map((operation) => <li key={operation}>{operation}</li>)}</ul>
            <p>{t("fox.goal.expiry")}: {terms.expiresAt ? <time dateTime={terms.expiresAt}>{new Date(terms.expiresAt).toLocaleString(locale)}</time> : t("fox.goal.untilDelivery")}</p>
            <p className="fox-goal-note">{t("fox.goal.scopeHint")}</p>
          </details>
        </>}
        {snapshot.todoPhases.length > 0 && <details className="fox-goal-details" open><summary>{t("fox.goal.plan")}</summary>
          {snapshot.todoPhases.map((phase, phaseIndex) => <div className="fox-goal-phase" key={phase.id ?? `${phaseIndex}:${phase.name}`}><h4>{phase.name}</h4><ul>{phase.tasks.map((item, index) => {
            const reference = item.id ?? (snapshot.planEntryId ? JSON.stringify([snapshot.planEntryId, phase.name, item.content]) : null);
            const unambiguous = item.id ? tasks.filter((task) => task.id === item.id).length === 1 : snapshot.todoPhases.filter((candidate) => candidate.name === phase.name).flatMap((candidate) => candidate.tasks).filter((task) => task.content === item.content).length === 1;
            const linked = reference && unambiguous ? assignments.filter((assignment) => {
              if (assignment.planItemRef === reference) return true;
              if (item.id || !snapshot.planReferences?.includes(assignment.planItemRef)) return false;
              try {
                const binding: unknown = JSON.parse(assignment.planItemRef);
                return Array.isArray(binding) && binding.length === 3 && binding[1] === phase.name && binding[2] === item.content;
              } catch { return false; }
            }) : [];
            return <li key={item.id ?? `${index}:${item.content}`} data-state={item.status}><div><span className="fox-goal-task-state">{t(`fox.goal.todo.${item.status}`)}</span>{item.content}</div>{item.blocker && <p className="fox-goal-note">{item.blocker}</p>}{linked.map((assignment) => <small key={assignment.id}>{t(`fox.goal.assignment.${assignment.state}`)} · {assignment.workerSessionId?.slice(0, 8) || t("fox.goal.workerUnbound")}</small>)}</li>;
          })}</ul></div>)}
        </details>}
        {assignments.length > 0 && <details className="fox-goal-details" open>
          <summary>{t("fox.goal.assignments", { count: assignments.length })}</summary>
          <ul className="fox-goal-assignment-list">{assignments.map((assignment) => {
            const workerId = assignment.workerSessionId;
            return <li key={assignment.id} className="fox-goal-assignment" data-state={assignment.state}>
              <div className="fox-goal-row-heading"><strong>{t(`fox.goal.purpose.${assignment.purpose}`)}</strong><span>{t(`fox.goal.assignment.${assignment.state}`)}</span></div>
              <code>{assignment.cwd}</code>
              <small>{t("fox.goal.planRef")}: {assignment.planItemRef}</small>
              <small>{t("fox.goal.criteria")}: {assignment.criterionIds.join(", ") || t("fox.goal.unknown")}</small>
              <small>{t("fox.goal.reworkUsed", { count: assignment.rework, limit: terms?.maxRework ?? "—" })}</small>
              {workerId
                ? <button type="button" className="fox-native-text-button" onClick={() => onOpenSession(workerId)}>{t("fox.report.openWorker")}<code>{workerId.slice(0, 8)}</code><ArrowUpRight size={13} aria-hidden="true" /></button>
                : <p className="fox-native-report-note">{t("fox.goal.workerUnbound")}</p>}
            </li>;
          })}</ul>
        </details>}
        {questions.length > 0 && <section className="fox-goal-questions"><h4>{t("fox.goal.questions")}</h4><p className="fox-goal-note">{t("fox.goal.questionHint")}</p>{questions.map((report) => {
          const human = report.source === "native" || report.audience !== "coordinator";
          return <div key={report.id}><span className="fox-goal-task-state">{t(human ? "fox.goal.audience.human" : "fox.goal.audience.coordinator")}</span><p>{report.summary}</p><button type="button" className="fox-native-text-button" onClick={() => human ? onOpenSession(report.question?.sessionId || report.sourceSessionId) : onDiscuss(t("fox.goal.discussQuestion", { report: report.id }))}>{t(human ? "fox.goal.openQuestion" : "fox.discuss")}<ArrowUpRight size={13} aria-hidden="true" /></button>{report.question?.requestId && <small>{t("fox.goal.request")}: {report.question.requestId}</small>}</div>;
        })}</section>}
        {terms && <details className="fox-goal-details" open><summary>{t("fox.goal.criteriaReviews")}</summary><ul className="fox-goal-review-list">{terms.criteria.map((criterion) => {
          const review = reviews.get(criterion.id);
          return <li key={criterion.id}><div className="fox-goal-row-heading"><strong>{criterion.text}</strong><span data-state={review?.decision}>{t(review ? `fox.goal.review.${review.decision}` : "fox.goal.review.pending")}</span></div><code>{criterion.id}</code>{review?.evidence.map((evidence, index) => <div key={index} className="fox-goal-evidence"><small>{t(evidence.kind === "artifact" && evidence.reference.startsWith("report:") ? "fox.goal.evidence.report" : `fox.goal.evidence.${evidence.kind}`)}</small><code>{evidence.reference}</code><p>{evidence.observed}</p><small>{evidence.revision ? `${t("fox.goal.revision")}: ${evidence.revision}` : t("fox.goal.unversioned")}</small></div>)}{review?.reportIds.map((id) => {
            const report = reports.find((item) => item.id === id);
            return report ? <button key={id} type="button" className="fox-native-text-button" title={id} onClick={() => onOpenSession(report.sourceSessionId)}>{t("fox.goal.openEvidenceReport")}<code>{id}</code><ArrowUpRight size={13} aria-hidden="true" /></button> : <p key={id} className="fox-goal-note">{t("fox.goal.reportUnavailable")}: {id}</p>;
          })}</li>;
        })}</ul></details>}
        {reports.length > 0 && <details className="fox-goal-details"><summary>{t("fox.goal.receivedReports", { count: reports.length })}</summary><ul className="fox-goal-report-list">{reports.map((report) => <li key={report.id}><span className="fox-goal-task-state">{t(`fox.report.status.${report.status}`)}</span><p>{report.summary}</p><small>{t(snapshot.reviews.some((review) => review.reportIds.includes(report.id)) ? "fox.goal.reportReviewed" : "fox.goal.reportAwaitingReview")}</small><button type="button" className="fox-native-text-button" onClick={() => onOpenSession(report.sourceSessionId)}>{t("fox.report.openWorker")}<ArrowUpRight size={13} aria-hidden="true" /></button></li>)}</ul></details>}
        {snapshot.updatedAt && <p className="fox-goal-updated">{t("fox.snapshot")} <time dateTime={snapshot.updatedAt}>{new Date(snapshot.updatedAt).toLocaleTimeString(locale)}</time></p>}
        {!native && snapshot.supported && <button type="button" className="fox-native-text-button" onClick={() => onDiscuss(t("fox.goal.prompt"))}>{t("fox.goal.create")}<ArrowUpRight size={14} aria-hidden="true" /></button>}
        <p className="fox-goal-note">{t("fox.goal.backgroundHint")}</p>
      </>}
    </section>
  );
}
