"use client";

import { useRef, useState } from "react";
import { ArrowUpRight, Check, MessageSquare, X } from "lucide-react";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/primitives";
import { FoxTime, FoxWorkBadge } from "@/components/FoxOverview";
import { useChief } from "@/hooks/useChief";
import { shortFoxTitle, type FoxAttention, type FoxWork } from "@/lib/fox-workbench";
import { useI18n } from "@/lib/i18n";

interface Props {
  attention?: FoxAttention;
  work?: FoxWork;
  onClose: () => void;
  onOpenSession: (id: string) => void;
  onDiscuss: (text: string) => void;
}

export function FoxWorkDetails({ attention, work: selectedWork, onClose, onOpenSession, onDiscuss }: Props) {
  const { t } = useI18n();
  const chief = useChief();
  const work = selectedWork ?? attention?.work;
  const approval = attention?.approval;
  const args = approval?.action.args && typeof approval.action.args === "object" ? approval.action.args as Record<string, unknown> : null;
  const request = typeof args?.prompt === "string" ? args.prompt : typeof args?.message === "string" ? args.message : approval?.title;
  const knownAction = approval?.action.toolName === "new_session" || approval?.action.toolName === "send_to_session";
  const signal = attention?.signal;
  const title = attention?.title ?? work?.title ?? t("fox.detail.resolved");
  const project = attention?.projectName ?? work?.projectName;
  const projectKey = attention?.projectKey ?? work?.projectKey;
  const sessionId = signal?.sessionId ?? work?.sessionId ?? (typeof args?.sessionId === "string" ? args.sessionId : undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const decide = async (decision: "approve" | "deny" | "done") => {
    if (lock.current || (decision !== "done" && !approval)) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      if (decision === "done" && work?.ticket) {
        await chief.mutate(`/api/chief/tickets/${encodeURIComponent(work.ticket.id)}`, "PATCH", { state: "done" });
      } else if (approval) {
        await chief.mutate(`/api/chief/approvals/${encodeURIComponent(approval.id)}`, "POST", { decision });
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("fox.actionFailed"));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const discuss = () => {
    onClose();
    onDiscuss(t("fox.prompt.work", { project: projectKey || project || "", task: title, session: sessionId || t("fox.detail.notDispatched") }));
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent className="fox-detail-dialog" style={{ top: 0, bottom: 0, right: 0, left: "auto", transform: "none", animation: "none", borderRadius: 0, width: "min(100vw, 480px)", maxWidth: "100vw", maxHeight: "100dvh", padding: 0 }}>
        <header className="fox-detail-header">
          <span>{t("fox.detail.title")}</span>
          <DialogClose className="fox-button fox-icon-button" disabled={busy} aria-label={t("fox.detail.close")}><X size={18} /></DialogClose>
        </header>
        <div className="fox-detail-body">
          {project && <div className="fox-row-meta">{project}</div>}
          <DialogTitle style={{ fontFamily: "inherit", fontSize: 20, lineHeight: 1.45, overflowWrap: "anywhere", margin: "8px 0 12px" }}>{shortFoxTitle(title)}</DialogTitle>
          {work && <FoxWorkBadge status={work.status} />}
          {attention && <p className="fox-detail-explanation">{t(`fox.attentionHint.${attention.kind}`)}</p>}
          {projectKey && <div className="fox-detail-field"><h3>{t("fox.detail.scope")}</h3><code>{projectKey}</code></div>}
          {signal?.detail && <div className="fox-detail-field"><h3>{t("fox.detail.context")}</h3><p>{signal.detail}</p></div>}
          {approval && (
            <>
              <div className="fox-detail-field">
                <h3>{t("fox.detail.action")}</h3>
                <p>{t(approval.action.toolName === "new_session" ? "fox.detail.spawn" : approval.action.toolName === "send_to_session" ? "fox.detail.followUp" : "fox.detail.actionUnknown")}</p>
              </div>
              <div className="fox-detail-field"><h3>{t("fox.detail.evidence")}</h3><p>{approval.evidence}</p></div>
              <div className="fox-detail-field"><h3>{t("fox.detail.request")}</h3><p>{request}</p></div>
              <p className="fox-detail-note">{t("fox.detail.approvalNote")}</p>
            </>
          )}
          {work?.ticket?.proposal && <div className="fox-detail-field"><h3>{t("fox.detail.context")}</h3><p>{work.ticket.proposal}</p></div>}
          {!approval && work?.ticket && <div className="fox-detail-field"><h3>{t("fox.detail.request")}</h3><p>{work.ticket.title}</p></div>}
          {work && work.dispatches.length > 0 && (
            <div className="fox-detail-field">
              <h3>{t("fox.detail.dispatchHistory")}</h3>
              {work.dispatches.map((dispatch) => (
                <details className="fox-dispatch-history" key={dispatch.id}>
                  <summary><FoxTime at={dispatch.at} /><span>{shortFoxTitle(dispatch.task)}</span></summary>
                  <p>{dispatch.task}</p>
                </details>
              ))}
            </div>
          )}
          {work?.ticket?.artifacts && work.ticket.artifacts.length > 0 && (
            <div className="fox-detail-field"><h3>{t("fox.detail.artifacts")}</h3><ul>{work.ticket.artifacts.map((artifact, index) => <li key={index}>{artifact}</li>)}</ul></div>
          )}
          {work && ["updated", "ended", "review"].includes(work.status) && <p className="fox-detail-note">{t("fox.detail.resultNote")}</p>}
          {sessionId && <div className="fox-detail-field"><h3>{t("fox.detail.session")}</h3><code>{sessionId}</code></div>}
          {!attention && !work && <p>{t("fox.detail.resolvedHint")}</p>}
          {error && <p className="fox-inline-warning" role="alert">{error}</p>}
        </div>
        <footer className="fox-detail-actions">
          {approval && (
            <div className="fox-decision-buttons">
              <button type="button" className="fox-button fox-button-primary" disabled={busy || chief.failed || !knownAction} onClick={() => void decide("approve")}><Check size={16} />{t("fox.allowAction")}</button>
              <button type="button" className="fox-button" disabled={busy || chief.failed} onClick={() => void decide("deny")}>{t("chief.deny")}</button>
            </div>
          )}
          {work?.ticket?.state === "review" && <button type="button" className="fox-button" disabled={busy || chief.failed} onClick={() => void decide("done")}><Check size={16} />{t("fox.confirmResult")}</button>}
          {sessionId && <button type="button" className="fox-button" disabled={busy} onClick={() => { onClose(); onOpenSession(sessionId); }}>{t(signal?.kind === "input" ? "fox.answerInSession" : "fox.openExecution")}<ArrowUpRight size={16} /></button>}
          {(attention || work) && <button type="button" className="fox-button fox-button-quiet" disabled={busy} onClick={discuss}><MessageSquare size={16} />{t("fox.discuss")}</button>}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
