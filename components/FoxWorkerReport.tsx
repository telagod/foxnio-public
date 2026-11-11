"use client";

import { ArrowUpRight, MessageSquareText } from "lucide-react";
import type { FoxWorkerReport as WorkerReport } from "@/lib/fox-report-types";
import { useI18n } from "@/lib/i18n";
import { OPEN_SESSION_EVENT } from "@/lib/notification-client";
import { MarkdownBody } from "./MarkdownBody";

export function FoxWorkerReport({ report, onOpenFile }: { report: WorkerReport; onOpenFile?: (path: string) => void }) {
  const { t, locale } = useI18n();
  const project = report.cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() || report.cwd;
  const humanQuestion = report.status === "needs_input" && (report.source === "native" || report.audience !== "coordinator");
  const originalSession = humanQuestion ? report.question?.sessionId || report.sourceSessionId : report.sourceSessionId;
  return (
    <article className="fox-native-report" data-report-id={report.id} aria-label={t("fox.report.title")}>
      <header>
        <MessageSquareText size={17} aria-hidden="true" />
        <strong>{project}<span>·</span>{t(`fox.report.status.${report.status}`)}</strong>
        <time dateTime={report.at}>{new Date(report.at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}</time>
      </header>
      <div className="fox-native-report-body">
        <p className="fox-native-report-source">{t(report.source === "agent" ? "fox.report.agent" : "fox.report.native")}<span title={report.cwd}>{report.cwd}</span></p>
        <p className="fox-native-report-note">{t(humanQuestion || report.audience === "human" ? "fox.goal.audience.human" : "fox.goal.audience.coordinator")}</p>
        {humanQuestion && <p className="fox-native-report-note">{t("fox.goal.questionHint")}{report.question?.requestId && <><br /><code>{t("fox.goal.request")}: {report.question.requestId}</code></>}</p>}
        <MarkdownBody cwd={report.cwd} onOpenFile={onOpenFile}>{report.summary}</MarkdownBody>
        {report.evidence.length > 0 && <details>
          <summary>{t("fox.report.evidence", { count: report.evidence.length })}</summary>
          <ul>{report.evidence.map((evidence, index) => <li key={index}>{evidence}</li>)}</ul>
        </details>}
        {report.structuredEvidence && report.structuredEvidence.length > 0 && <details>
          <summary>{t("fox.goal.structuredEvidence")}</summary>
          {report.structuredEvidence.map((evidence, index) => <div className="fox-goal-evidence" key={index}><small>{t(evidence.kind === "artifact" && evidence.reference.startsWith("report:") ? "fox.goal.evidence.report" : `fox.goal.evidence.${evidence.kind}`)}</small><code>{evidence.reference}</code><p>{evidence.observed}</p><small>{evidence.revision ? `${t("fox.goal.revision")}: ${evidence.revision}` : t("fox.goal.unversioned")}</small></div>)}
        </details>}
        {report.status === "result" && <p className="fox-native-report-note">{t("fox.report.unverified")}</p>}
        {report.truncated && <p className="fox-native-report-note">{t("fox.report.truncated")}</p>}
      </div>
      <footer>
        <button type="button" className="fox-native-text-button" onClick={() => window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: originalSession }))}>
          {t(humanQuestion ? "fox.goal.openQuestion" : "fox.report.openWorker")}<ArrowUpRight size={14} aria-hidden="true" />
        </button>
        <span title={report.id}>{report.sourceSessionId.slice(0, 8)}</span>
      </footer>
    </article>
  );
}
