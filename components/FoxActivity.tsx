"use client";

import { useState } from "react";
import { AlertCircle, ArrowUpRight, CircleDot, MessageCircleQuestion, RefreshCw, X } from "lucide-react";
import type { BriefingState } from "@/hooks/useBriefing";
import type { FoxWorkerBrief } from "@/lib/briefing";
import { useI18n } from "@/lib/i18n";

export function FoxActivity({ state, onOpenSession, onDiscuss, onClose }: {
  state: BriefingState;
  onOpenSession: (sessionId: string) => void;
  onDiscuss: (prompt: string) => void;
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const [showHistorical, setShowHistorical] = useState(false);
  const workers = state.briefing?.workers ?? [];
  const historical = state.briefing?.historicalWorkers ?? [];
  const attention = state.briefing?.needsYou ?? [];
  const incomplete = Boolean(state.error || state.briefing?.warnings?.length);
  const renderWorker = (worker: FoxWorkerBrief, previous = false) => (
    <div key={worker.sessionId}>
      <button type="button" className="fox-native-work-row" onClick={() => onOpenSession(worker.sessionId)} title={worker.cwd}>
        <span className="fox-native-work-symbol" data-state={worker.state}><CircleDot size={15} /></span>
        <span className="fox-native-work-copy">
          <strong>{worker.title}</strong>
          <small>{worker.projectName}<span>·</span>{worker.state !== "idle" || !worker.report ? t(`fox.native.worker.${worker.state}`) : t(`fox.report.status.${worker.report.status}`)}</small>
          {worker.report ? <span className="fox-native-work-detail">{worker.report.summary}</span> : <span className="fox-native-work-detail">{t("fox.report.missing")}</span>}
          {worker.report && worker.reportDelivery === "pending" && <small>{t("fox.report.pending")}</small>}
          {worker.reportError && <small className="fox-native-report-warning" title={worker.reportError}>{t("fox.report.unavailable")}</small>}
          {worker.report && worker.state === "idle" && ["accepted", "progress"].includes(worker.report.status) && <small className="fox-native-report-warning">{t("fox.report.noResult")}</small>}
        </span>
        <ArrowUpRight size={14} aria-hidden="true" />
      </button>
      {previous && <button type="button" className="fox-native-text-button" onClick={() => onOpenSession(worker.parentSessionId)}>{t("fox.report.openParent")}<ArrowUpRight size={13} /></button>}
    </div>
  );
  return (
    <section className="fox-native-activity" aria-label={t("fox.native.activity")}>
      <div className="fox-native-activity-header">
        <h2>{t("fox.native.activity")}</h2>
        <div>
          <button type="button" className="fox-native-icon" onClick={() => void state.refresh()} disabled={state.refreshing} aria-label={t("fox.refresh")}><RefreshCw size={16} className={state.refreshing ? "icon-spin" : ""} /></button>
          {onClose && <button type="button" className="fox-native-icon" onClick={onClose} aria-label={t("fox.detail.close")}><X size={16} /></button>}
        </div>
      </div>
      <div className="fox-native-activity-body">
        {state.loading && !state.briefing && <p role="status">{t("fox.overview.loading")}</p>}
        {incomplete && <p className="fox-native-source-warning" role="status"><AlertCircle size={15} />{t("fox.overview.partial")}</p>}
        {attention.length > 0 && <section className="fox-native-attention">
          <h3>{t("fox.native.attention")}<span>{attention.length}</span></h3>
          {attention.map((item) => (
            <button type="button" className="fox-native-work-row" key={item.id} onClick={() => onOpenSession(item.sessionId)}>
              <span className="fox-native-work-symbol" data-state={item.kind === "input" ? "waiting" : "error"}>
                {item.kind === "input" ? <MessageCircleQuestion size={16} /> : <AlertCircle size={16} />}
              </span>
              <span className="fox-native-work-copy">
                <strong>{item.sessionName || item.projectName}</strong>
                {item.detail && <span className="fox-native-work-detail">{item.detail}</span>}
                <small>{item.projectName}</small>
              </span>
              <ArrowUpRight size={14} aria-hidden="true" />
            </button>
          ))}
        </section>}
        {workers.length > 0 && <section>
          <h3>{t("fox.native.workers")}<span>{workers.length}</span></h3>
          {(showAll ? workers : workers.slice(0, 6)).map((worker) => renderWorker(worker))}
          {workers.length > 6 && <button type="button" className="fox-native-text-button" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>{t(showAll ? "fox.native.showLess" : "fox.native.showAll", { count: workers.length })}</button>}
        </section>}
        {historical.length > 0 && <section>
          <button type="button" className="fox-native-text-button" aria-expanded={showHistorical} onClick={() => setShowHistorical(!showHistorical)}>{t("fox.report.otherConversations", { count: historical.length })}</button>
          {showHistorical && <><p className="fox-native-report-note">{t("fox.report.originalParentHint")}</p>{historical.map((worker) => renderWorker(worker, true))}</>}
        </section>}
        {!state.loading && !incomplete && workers.length === 0 && historical.length === 0 && attention.length === 0 && <div className="fox-native-activity-empty">
          <CircleDot size={23} aria-hidden="true" />
          <h3>{t("fox.native.noWorkers")}</h3>
          <p>{t("fox.native.noWorkersHint")}</p>
        </div>}
      </div>
      <div className="fox-native-activity-footer">
        <p>{t("fox.native.activityHint")}</p>
        <button type="button" onClick={() => onDiscuss(t("fox.native.prompt.progress"))}>{t("fox.native.discussProgress")}<ArrowUpRight size={14} /></button>
      </div>
    </section>
  );
}
