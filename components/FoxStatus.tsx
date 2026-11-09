"use client";

import { useCallback, useMemo } from "react";
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  Ban,
  Check,
  FolderKanban,
  LoaderCircle,
  MessageCircleQuestion,
  Radio,
  RefreshCw,
  Send,
} from "lucide-react";
import { useBriefing, type BriefingState } from "@/hooks/useBriefing";
import type { BriefingItem, FoxDispatchBrief, ProjectBriefing } from "@/lib/briefing";
import { buildFoxMetrics, type FoxProjectSignal } from "@/lib/fox";
import { askFox } from "@/lib/fox-events";
import { useI18n } from "@/lib/i18n";

export interface FoxStatusProps {
  onOpenSession: (sessionId: string) => void;
}

export interface FoxBriefViewProps extends FoxStatusProps {
  state: BriefingState;
  variant?: "panel" | "deck";
}

function relativeTime(iso: string | null | undefined, now: number, locale: string): string {
  if (!iso) return "";
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "";
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  const minutes = Math.round((timestamp - now) / 60_000);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function AttentionIcon({ kind }: { kind: BriefingItem["kind"] }) {
  if (kind === "error") return <AlertCircle size={14} aria-hidden="true" />;
  if (kind === "input") return <MessageCircleQuestion size={14} aria-hidden="true" />;
  if (kind === "blocked") return <Ban size={14} aria-hidden="true" />;
  return <Activity size={14} aria-hidden="true" />;
}

function projectStateLabel(signal: FoxProjectSignal, t: (key: string) => string): string {
  if (signal.state === "critical") return t("fox.project.critical");
  if (signal.state === "waiting") return t("fox.project.waiting");
  if (signal.state === "active") return t("fox.project.active");
  return t("fox.project.quiet");
}

function dispatchStateLabel(state: FoxDispatchBrief["state"], t: (key: string) => string): string {
  return t(`fox.dispatchState.${state}`);
}

function ProjectSignalCard({
  signal,
  now,
  locale,
  onAsk,
  t,
  tn,
}: {
  signal: FoxProjectSignal;
  now: number;
  locale: string;
  onAsk: (project: ProjectBriefing) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  tn: (key: string, count: number, vars?: Record<string, string | number>) => string;
}) {
  const project = signal.project;
  const total = Math.max(1, project.sessions);
  const quiet = Math.max(0, project.sessions - project.running - project.waiting - project.errors);
  const segments = [
    { kind: "error", count: project.errors },
    { kind: "waiting", count: project.waiting },
    { kind: "running", count: project.running },
    { kind: "quiet", count: quiet },
  ].filter((segment) => segment.count > 0);

  return (
    <button
      type="button"
      className="fox-project"
      data-state={signal.state}
      onClick={() => onAsk(project)}
      title={t("fox.project.ask", { project: project.name })}
    >
      <span className="fox-project-head">
        <span className="fox-project-name">{project.name}</span>
        <span className="fox-project-state" data-state={signal.state}>
          <span className="fox-project-state-dot" aria-hidden="true" />
          {projectStateLabel(signal, t)}
        </span>
      </span>
      <span className="fox-project-bar" aria-hidden="true">
        {segments.map((segment) => (
          <i
            key={segment.kind}
            data-kind={segment.kind}
            style={{ width: `${Math.max(5, (segment.count / total) * 100)}%` }}
          />
        ))}
      </span>
      <span className="fox-project-meta">
        <span>{tn("fox.project.sessions", project.sessions)}</span>
        {project.running > 0 && <span>{t("fox.project.running", { count: project.running })}</span>}
        {project.waiting > 0 && <span>{t("fox.project.waitingCount", { count: project.waiting })}</span>}
        {project.errors > 0 && <span data-tone="error">{t("fox.project.errorCount", { count: project.errors })}</span>}
      </span>
      <span className="fox-project-foot">
        <span>{relativeTime(project.lastActivity, now, locale)}</span>
        <span className="fox-project-ask">
          {t("fox.project.askShort")}
          <ArrowUpRight size={11} strokeWidth={2.1} aria-hidden="true" />
        </span>
      </span>
    </button>
  );
}

function AttentionRow({
  item,
  now,
  locale,
  onOpenSession,
}: {
  item: BriefingItem;
  now: number;
  locale: string;
  onOpenSession: (sessionId: string) => void;
}) {
  return (
    <button
      type="button"
      className="fox-attention-row"
      data-kind={item.kind}
      onClick={() => onOpenSession(item.sessionId)}
      title={item.detail}
    >
      <span className="fox-attention-icon">
        <AttentionIcon kind={item.kind} />
      </span>
      <span className="fox-attention-copy">
        <strong>{item.sessionName ?? item.sessionId}</strong>
        <small>
          {item.projectName}
          {item.detail ? ` · ${item.detail}` : ""}
        </small>
      </span>
      <time>{relativeTime(item.at, now, locale)}</time>
    </button>
  );
}

/**
 * The useful side-panel brief: live agent work, exact decisions/errors,
 * FOX dispatches, portfolio state, and recent activity.
 */
export function FoxBriefView({ state, onOpenSession, variant = "panel" }: FoxBriefViewProps) {
  const { t, tn, locale } = useI18n();
  const { briefing, loading, refreshing, error, refresh } = state;
  const metrics = useMemo(() => (briefing ? buildFoxMetrics(briefing) : null), [briefing]);
  const now = Date.now();

  const askAboutProject = useCallback((project: ProjectBriefing) => {
    askFox(t("fox.prompt.project", { project: project.name }));
  }, [t]);

  const status = !briefing ? "loading" : briefing.needsYou.length > 0 ? "attention" : briefing.totals.running > 0 ? "running" : "quiet";
  const headline = !briefing
    ? t("fox.loading")
    : status === "attention"
      ? tn("fox.headline.attention", briefing.needsYou.length)
      : status === "running"
        ? tn("fox.headline.running", briefing.totals.running)
        : t("fox.headline.quiet");

  return (
    <div className="fox-status" data-status={status} data-variant={variant}>
      <header className="fox-status-head">
        <div className="fox-status-title">
          <span className="fox-eyebrow">
            <Activity size={12} aria-hidden="true" />
            {t("fox.brief")}
          </span>
          <strong>{headline}</strong>
        </div>
        <div className="fox-status-meta">
          {briefing && <span>{t("fox.updated", { time: relativeTime(briefing.generatedAt, now, locale) })}</span>}
          <button
            type="button"
            className="fox-status-refresh"
            onClick={() => void refresh()}
            disabled={refreshing}
            title={t("fox.refresh")}
            aria-label={t("fox.refresh")}
          >
            {refreshing
              ? <LoaderCircle size={13} className="icon-spin" aria-hidden="true" />
              : <RefreshCw size={13} aria-hidden="true" />}
          </button>
        </div>
      </header>

      <div className="fox-status-body">
        {briefing?.warnings && briefing.warnings.length > 0 && (
          <div className="fox-warning" role="status">
            <AlertCircle size={13} aria-hidden="true" />
            {t("fox.warnings", { sources: briefing.warnings.join(", ") })}
          </div>
        )}
        {error && (
          <div className="fox-warning" role="status">
            <AlertCircle size={13} aria-hidden="true" />
            {error}
          </div>
        )}

        {!briefing && loading ? (
          <div className="fox-status-loading" role="status">
            <LoaderCircle size={16} className="icon-spin" aria-hidden="true" />
            {t("fox.loading")}
          </div>
        ) : briefing && metrics ? (
          <>
            <div className="fox-brief-grid">
              <section className="fox-panel fox-active" aria-label={t("fox.active")}>
                <header>
                  <span><Activity size={13} />{t("fox.active")}</span>
                  <em>{(briefing.active ?? []).length}</em>
                </header>
                {(briefing.active ?? []).length === 0 ? (
                  <div className="fox-empty-state">
                    <Activity size={18} aria-hidden="true" />
                    <strong>{t("fox.active.empty")}</strong>
                    <span>{t("fox.active.emptyHint")}</span>
                  </div>
                ) : (
                  <div className="fox-active-list">
                    {(briefing.active ?? []).slice(0, 8).map((item) => (
                      <button key={item.id} type="button" onClick={() => onOpenSession(item.sessionId)}>
                        <span className="fox-active-dot" aria-hidden="true" />
                        <span>
                          <strong>{item.sessionName ?? item.sessionId}</strong>
                          <small>
                            {item.projectName}
                            {item.detail ? ` · ${item.detail}` : ""}
                          </small>
                        </span>
                        <time>{relativeTime(item.at, now, locale)}</time>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section className="fox-panel fox-attention" aria-label={t("fox.attention")}>
                <header>
                  <span><AlertCircle size={13} />{t("fox.attention")}</span>
                  <em>{briefing.needsYou.length}</em>
                </header>
                {briefing.needsYou.length === 0 ? (
                  <div className="fox-empty-state">
                    <Check size={18} aria-hidden="true" />
                    <strong>{t("fox.attention.empty")}</strong>
                    <span>{t("fox.attention.emptyHint")}</span>
                  </div>
                ) : (
                  <div className="fox-attention-list">
                    {briefing.needsYou.slice(0, 6).map((item) => (
                      <AttentionRow key={item.id} item={item} now={now} locale={locale} onOpenSession={onOpenSession} />
                    ))}
                  </div>
                )}
              </section>

              <section className="fox-panel fox-dispatches" aria-label={t("fox.dispatched")}>
                <header>
                  <span><Send size={13} />{t("fox.dispatched")}</span>
                  <em>{(briefing.dispatches ?? []).length}</em>
                </header>
                {(briefing.dispatches ?? []).length === 0 ? (
                  <div className="fox-empty-state">
                    <Send size={18} aria-hidden="true" />
                    <strong>{t("fox.dispatched.empty")}</strong>
                  </div>
                ) : (
                  <div className="fox-dispatch-list">
                    {(briefing.dispatches ?? []).map((item) => (
                      <button key={item.id} type="button" onClick={() => onOpenSession(item.targetSessionId)} title={`${item.task}\nTask: ${item.taskId}`}>
                        <span className="fox-dispatch-dot" data-state={item.state} aria-hidden="true" />
                        <span>
                          <strong>{item.task}</strong>
                          <small>
                            {item.projectName}
                            {item.sessionName ? ` · ${item.sessionName}` : ""}
                            {` · task ${item.taskId.slice(0, 8)}`}
                          </small>
                        </span>
                        <span className="fox-dispatch-side">
                          <em data-state={item.state}>{dispatchStateLabel(item.state, t)}</em>
                          <time>{relativeTime(item.at, now, locale)}</time>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section className="fox-panel fox-portfolio" aria-label={t("fox.portfolio")}>
                <header>
                  <span><FolderKanban size={13} />{t("fox.portfolio")}</span>
                  <em>{briefing.projects.length}</em>
                </header>
                {metrics.projects.length === 0 ? (
                  <div className="fox-empty-state">
                    <FolderKanban size={18} aria-hidden="true" />
                    <strong>{t("fox.portfolio.empty")}</strong>
                  </div>
                ) : (
                  <div className="fox-projects">
                    {metrics.projects.slice(0, 4).map((signal) => (
                      <ProjectSignalCard
                        key={signal.project.key}
                        signal={signal}
                        now={now}
                        locale={locale}
                        onAsk={askAboutProject}
                        t={t}
                        tn={tn}
                      />
                    ))}
                  </div>
                )}
              </section>

              <section className="fox-panel fox-recent" aria-label={t("fox.recent")}>
                <header>
                  <span><Radio size={13} />{t("fox.recent")}</span>
                  <em>{briefing.recent.length}</em>
                </header>
                {briefing.recent.length === 0 ? (
                  <div className="fox-empty-state">
                    <Radio size={18} aria-hidden="true" />
                    <strong>{t("fox.recent.empty")}</strong>
                  </div>
                ) : (
                  <div className="fox-recent-list">
                    {briefing.recent.slice(0, 6).map((item) => (
                      <button key={item.id} type="button" onClick={() => onOpenSession(item.sessionId)}>
                        <span className="fox-recent-dot" aria-hidden="true" />
                        <span>
                          <strong>{item.sessionName ?? item.sessionId}</strong>
                          <small>
                            {item.projectName}
                            {item.detail ? ` · ${item.detail}` : ""}
                          </small>
                        </span>
                        <time>{relativeTime(item.at, now, locale)}</time>
                      </button>
                    ))}
                  </div>
                )}
              </section>
            </div>

          </>
        ) : (
          <div className="fox-status-error">
            <AlertCircle size={18} aria-hidden="true" />
            <strong>{t("fox.loadFailed")}</strong>
            <button type="button" onClick={() => void refresh()}>
              {t("fox.retry")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Right-panel wrapper; FOX's page itself stays chat-first. */
export function FoxStatus({ onOpenSession }: FoxStatusProps) {
  const state = useBriefing();
  return <FoxBriefView state={state} onOpenSession={onOpenSession} variant="panel" />;
}
