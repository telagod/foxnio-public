"use client";

import { useState } from "react";
import { Activity, ArrowRight, Check, ChevronDown, CircleHelp, Clock3, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import type { Briefing, ProjectBriefing } from "@/lib/briefing";
import type { ChiefState } from "@/lib/chief-store";
import { buildFoxWorkbench, shortFoxTitle, type FoxSelection, type FoxWorkStatus } from "@/lib/fox-workbench";
import { useI18n } from "@/lib/i18n";

interface Props {
  briefing: Briefing | null;
  chief: ChiefState | null;
  projectKey: string;
  projects?: ProjectBriefing[];
  loading: boolean;
  refreshing: boolean;
  briefingError: string | null;
  chiefFailed: boolean;
  onProjectChange: (key: string) => void;
  onRefresh: () => void;
  onSelect: (selection: FoxSelection) => void;
  onOpenSession: (id: string) => void;
  onDiscuss: (text: string) => void;
}

export function FoxWorkBadge({ status }: { status: FoxWorkStatus }) {
  const { t } = useI18n();
  return <span className="fox-work-badge" data-state={status}>{t(`fox.workState.${status}`)}</span>;
}

export function FoxTime({ at }: { at: string }) {
  const { locale } = useI18n();
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return null;
  return <time dateTime={at} title={date.toLocaleString(locale)}>{date.toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>;
}

export function FoxOverview({
  briefing, chief, projectKey, projects, loading, refreshing, briefingError, chiefFailed,
  onProjectChange, onRefresh, onSelect, onOpenSession, onDiscuss,
}: Props) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<"all" | "active" | "results">("all");
  const [limit, setLimit] = useState(8);
  const model = buildFoxWorkbench(briefing, chief, projectKey);
  const results: FoxWorkStatus[] = ["ended", "updated", "review", "done", "dropped"];
  const work = model.work.filter((item) => filter === "all" || (filter === "results" ? results.includes(item.status) : !results.includes(item.status)));
  const complete = Boolean(briefing && chief && !chief.truncated && !briefingError && !chiefFailed && !briefing?.warnings?.length);

  return (
    <div className="fox-overview" aria-busy={loading}>
      <div className="fox-overview-inner">
        <header className="fox-overview-heading">
          <div>
            <h2>{t("fox.overview.title")}</h2>
            <p>{t("fox.overview.description")}</p>
          </div>
          <button type="button" className="fox-button fox-button-quiet" onClick={onRefresh} disabled={refreshing} aria-label={t("fox.refresh")}>
            <RefreshCw size={15} className={refreshing ? "icon-spin" : undefined} aria-hidden="true" />
            <span>{t("fox.refresh")}</span>
          </button>
        </header>

        <div className="fox-overview-filters">
          <label>
            <span className="sr-only">{t("fox.scope.label")}</span>
            <select value={projectKey} onChange={(event) => { onProjectChange(event.target.value); setLimit(8); }}>
              <option value="">{t("fox.scope.all")}</option>
              {(projects ?? briefing?.projects ?? []).map((project) => (
                <option key={project.key} value={project.key}>{project.name} · {project.path}</option>
              ))}
            </select>
          </label>
          {briefing && <span className="fox-freshness">{t("fox.snapshot")} <FoxTime at={briefing.generatedAt} /></span>}
        </div>

        {(briefingError || chiefFailed || Boolean(briefing?.warnings?.length)) && (
          <div className="fox-inline-warning" role="status">
            <TriangleAlert size={16} aria-hidden="true" />
            <span>{briefingError || (chiefFailed ? t("chief.loadFailed") : t("fox.warnings", { sources: briefing?.warnings?.join(", ") ?? "" }))} {t("fox.overview.partial")}</span>
          </div>
        )}
        {chief?.truncated && <p className="fox-inline-warning" role="status">{t("fox.overview.limited")}</p>}

        <section className="fox-overview-section" aria-labelledby="fox-attention-heading">
          <header className="fox-section-heading">
            <h3 id="fox-attention-heading"><CircleHelp size={17} aria-hidden="true" />{t("fox.attention")} <span>{model.attention.length}</span></h3>
          </header>
          {model.attention.length ? (
            <div className="fox-decisions">
              {model.attention.map((item) => (
                <button key={item.id} type="button" className="fox-decision" data-kind={item.kind} onClick={() => onSelect({ kind: "attention", id: item.id })}>
                  <span className="fox-decision-icon" aria-hidden="true">{item.kind === "approval" ? <ShieldCheck size={18} /> : item.kind === "error" ? <TriangleAlert size={18} /> : <CircleHelp size={18} />}</span>
                  <span className="fox-decision-copy">
                    <span className="fox-row-meta">{item.projectName} <span>·</span> {t(`fox.attentionKind.${item.kind}`)}</span>
                    <strong>{shortFoxTitle(item.title)}</strong>
                    <span className="fox-row-description">{item.signal?.detail || t(`fox.attentionHint.${item.kind}`)}</span>
                  </span>
                  <span className="fox-decision-action">{t("fox.reviewDecision")} <ArrowRight size={15} aria-hidden="true" /></span>
                </button>
              ))}
            </div>
          ) : (
            <div className="fox-quiet-line" role="status">
              {complete ? <Check size={17} aria-hidden="true" /> : <Clock3 size={17} aria-hidden="true" />}
              <span>{loading ? t("fox.overview.loading") : complete ? t("fox.overview.clear") : t("fox.overview.unknown")}</span>
            </div>
          )}
        </section>

        <section className="fox-overview-section" aria-labelledby="fox-work-heading">
          <header className="fox-section-heading">
            <h3 id="fox-work-heading">{t("fox.work.title")} <span>{model.work.length}</span></h3>
            <div className="fox-work-filters" role="group" aria-label={t("fox.work.filter")}>
              {(["all", "active", "results"] as const).map((value) => (
                <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); setLimit(8); }}>{t(`fox.work.filter.${value}`)}</button>
              ))}
            </div>
          </header>
          {work.length ? (
            <div className="fox-work-list">
              {work.slice(0, limit).map((item) => (
                <button key={item.id} type="button" className="fox-work-row" onClick={() => onSelect({ kind: "work", id: item.id })}>
                  <span className="fox-work-copy">
                    <strong>{shortFoxTitle(item.title)}</strong>
                    <span className="fox-row-meta">{item.projectName} <span>·</span> <FoxTime at={item.at} /></span>
                  </span>
                  <FoxWorkBadge status={item.status} />
                  <ArrowRight size={15} className="fox-row-arrow" aria-hidden="true" />
                </button>
              ))}
              {work.length > limit && (
                <button type="button" className="fox-show-more" onClick={() => setLimit((value) => value + 16)}>
                  <ChevronDown size={15} aria-hidden="true" />{t("fox.showMore", { count: work.length - limit })}
                </button>
              )}
            </div>
          ) : (
            <div className="fox-work-empty">
              <p>{loading ? t("fox.overview.loading") : filter === "all" ? t("fox.work.empty") : t("fox.work.noMatches")}</p>
              {filter === "all" && <button type="button" className="fox-button" onClick={() => onDiscuss(t("fox.prompt.plan"))}>{t("fox.work.plan")} <ArrowRight size={14} aria-hidden="true" /></button>}
            </div>
          )}
        </section>

        {model.otherActive.length > 0 && (
          <section className="fox-overview-section" aria-labelledby="fox-other-heading">
            <header className="fox-section-heading"><h3 id="fox-other-heading"><Activity size={16} aria-hidden="true" />{t("fox.otherActive")} <span>{model.otherActive.length}</span></h3></header>
            <div className="fox-work-list">
              {model.otherActive.map((item) => (
                <button type="button" className="fox-work-row" key={item.id} onClick={() => onOpenSession(item.sessionId)}>
                  <span className="fox-work-copy"><strong>{shortFoxTitle(item.sessionName || item.detail || item.sessionId)}</strong><span className="fox-row-meta">{item.projectName}</span></span>
                  <FoxWorkBadge status="running" />
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
              ))}
            </div>
          </section>
        )}

        {model.recent.length > 0 && (
          <details className="fox-recent-disclosure">
            <summary>{t("fox.recentActivity")} <span>{model.recent.length}</span><ChevronDown size={15} aria-hidden="true" /></summary>
            <div className="fox-work-list">
              {model.recent.map((item) => (
                <button key={item.id} type="button" className="fox-work-row" onClick={() => onOpenSession(item.sessionId)}>
                  <span className="fox-work-copy"><strong>{shortFoxTitle(item.sessionName || item.sessionId)}</strong><span className="fox-row-meta">{item.projectName} · <FoxTime at={item.at} /></span></span>
                  <ArrowRight size={15} aria-hidden="true" />
                </button>
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
