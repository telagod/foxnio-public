"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, LoaderCircle, Plus, ShieldCheck, Ticket, Trash2, X } from "lucide-react";
import type { ProjectBriefing } from "@/lib/briefing";
import type {
  ChiefApproval,
  ChiefAutonomy,
  ChiefPreference,
  ChiefState,
  ChiefTicket,
} from "@/lib/chief-store";
import { useI18n } from "@/lib/i18n";

const AUTONOMY: ChiefAutonomy[] = ["observe", "suggest", "approve", "auto"];

function ticketTone(state: ChiefTicket["state"]): string {
  if (state === "working" || state === "queued" || state === "assessing") return "running";
  if (state === "waiting_human" || state === "review") return "waiting";
  if (state === "dropped") return "quiet";
  if (state === "done") return "done";
  return "inbox";
}

function ApprovalRow({ approval, busy, onDecide, t }: {
  approval: ChiefApproval;
  busy: boolean;
  onDecide: (decision: "approve" | "deny") => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div className="fox-approval" data-tool={approval.action.toolName ?? "unknown"}>
      <div className="fox-approval-copy">
        <strong>{approval.title}</strong>
        <small>{approval.projectName} · {String(approval.action.toolName ?? "action")}</small>
        <span>{approval.evidence}</span>
      </div>
      <div className="fox-approval-actions">
        <button type="button" className="fox-approve" disabled={busy} onClick={() => onDecide("approve")} title={t("chief.approve")}>
          <Check size={12} aria-hidden="true" />
        </button>
        <button type="button" className="fox-deny" disabled={busy} onClick={() => onDecide("deny")} title={t("chief.deny")}>
          <X size={12} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}

export function ChiefPanel({ projects, settingsOnly = false }: { projects: ProjectBriefing[]; settingsOnly?: boolean }) {
  const { t } = useI18n();
  const [state, setState] = useState<ChiefState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preference, setPreference] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/chief/state", {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setState(await response.json() as ChiefState);
      setError(null);
    } catch {
      setError(t("chief.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const decide = useCallback(async (approval: ChiefApproval, decision: "approve" | "deny") => {
    setBusy(approval.id);
    setError(null);
    try {
      const response = await fetch(`/api/chief/approvals/${encodeURIComponent(approval.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const data = await response.json().catch(() => null) as { state?: ChiefState; error?: string } | null;
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      if (data?.state) setState(data.state);
      else await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await load();
    } finally {
      setBusy(null);
    }
  }, [load]);

  const updateAutonomy = useCallback(async (projectRef: string, level: ChiefAutonomy) => {
    setBusy(`autonomy:${projectRef}`);
    try {
      const response = await fetch("/api/chief/projects", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectRef, level }),
      });
      const data = await response.json().catch(() => null) as ChiefState | { error?: string } | null;
      if (!response.ok) throw new Error((data as { error?: string } | null)?.error || `HTTP ${response.status}`);
      setState(data as ChiefState);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  const addPreference = useCallback(async () => {
    if (!preference.trim()) return;
    setBusy("preference:add");
    try {
      const response = await fetch("/api/chief/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: preference.trim() }),
      });
      const data = await response.json().catch(() => null) as ChiefState | { error?: string } | null;
      if (!response.ok) throw new Error((data as { error?: string } | null)?.error || `HTTP ${response.status}`);
      setState(data as ChiefState);
      setPreference("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, [preference]);

  const removePreference = useCallback(async (id: string) => {
    setBusy(`preference:${id}`);
    try {
      const response = await fetch(`/api/chief/preferences?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const data = await response.json().catch(() => null) as ChiefState | { error?: string } | null;
      if (!response.ok) throw new Error((data as { error?: string } | null)?.error || `HTTP ${response.status}`);
      setState(data as ChiefState);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  const markTicketDone = useCallback(async (ticket: ChiefTicket) => {
    setBusy(`ticket:${ticket.id}`);
    try {
      const response = await fetch(`/api/chief/tickets/${encodeURIComponent(ticket.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "done" }),
      });
      const data = await response.json().catch(() => null) as ChiefState | { error?: string } | null;
      if (!response.ok) throw new Error((data as { error?: string } | null)?.error || `HTTP ${response.status}`);
      setState(data as ChiefState);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  const approvals = state?.approvals ?? [];
  const tickets = state?.tickets ?? [];
  const preferences = state?.preferences ?? [];

  return (
    <section className="fox-chief" aria-label={t("chief.title")}>
      {!settingsOnly && <header className="fox-chief-head">
        <span><ShieldCheck size={13} aria-hidden="true" />{t("chief.title")}</span>
        <em>{approvals.length}</em>
      </header>}

      {loading ? (
        <div className="fox-chief-loading" role="status">
          <LoaderCircle size={14} className="icon-spin" aria-hidden="true" />
          {t("chief.loading")}
        </div>
      ) : (
        <>
          {error && <div className="fox-warning" role="status">{error}</div>}
          {!settingsOnly && <><div className="fox-chief-block">
            <div className="fox-chief-label">
              <span>{t("chief.approvals")}</span>
              <em>{approvals.length}</em>
            </div>
            {approvals.length === 0 ? (
              <div className="fox-chief-empty">{t("chief.approvals.empty")}</div>
            ) : approvals.slice(0, 6).map((approval) => (
              <ApprovalRow
                key={approval.id}
                approval={approval}
                busy={busy === approval.id}
                onDecide={(decision) => void decide(approval, decision)}
                t={t}
              />
            ))}
          </div>

          <div className="fox-chief-block">
            <div className="fox-chief-label">
              <span><Ticket size={12} aria-hidden="true" />{t("chief.tickets")}</span>
              <em>{tickets.length}</em>
            </div>
            {tickets.length === 0 ? (
              <div className="fox-chief-empty">{t("chief.tickets.empty")}</div>
            ) : tickets.slice(0, 6).map((ticket) => (
              <div className="fox-ticket" key={ticket.id} data-state={ticketTone(ticket.state)}>
                <span>
                  <strong>{ticket.title}</strong>
                  <small>{ticket.projectName} · {ticket.state.replace("_", " ")}</small>
                </span>
                {(ticket.state === "review" || ticket.state === "working") && (
                  <button
                    type="button"
                    className="fox-ticket-done"
                    disabled={busy === `ticket:${ticket.id}`}
                    onClick={() => void markTicketDone(ticket)}
                    title={t("chief.ticket.done")}
                  >
                    <Check size={11} aria-hidden="true" />
                  </button>
                )}
              </div>
            ))}
          </div></>}

          <details className="fox-chief-block fox-autonomy" open={settingsOnly || undefined}>
            <summary>
              <span>{t("chief.autonomy")}</span>
              <em>{projects.length}</em>
            </summary>
            <p className="fox-settings-help">{t("fox.settings.permissionsHint")}</p>
            {projects.map((project) => (
              <label className="fox-autonomy-row" key={project.key}>
                <span>{project.name}</span>
                <select
                  value={state?.autonomy[project.path] ?? "suggest"}
                  disabled={busy === `autonomy:${project.path}`}
                  onChange={(event) => void updateAutonomy(project.path, event.target.value as ChiefAutonomy)}
                >
                  {AUTONOMY.map((level) => (
                    <option key={level} value={level}>{t(`fox.autonomy.${level}`)}</option>
                  ))}
                </select>
              </label>
            ))}
          </details>

          <div className="fox-chief-block fox-preferences">
            <div className="fox-chief-label">
              <span>{t("chief.preferences")}</span>
              <em>{preferences.length}</em>
            </div>
            <div className="fox-preference-add">
              <input
                value={preference}
                onChange={(event) => setPreference(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void addPreference(); }}
                placeholder={t("chief.preferences.placeholder")}
                aria-label={t("chief.preferences.placeholder")}
              />
              <button type="button" disabled={busy === "preference:add" || !preference.trim()} onClick={() => void addPreference()} title={t("chief.preferences.add")}>
                <Plus size={12} aria-hidden="true" />
              </button>
            </div>
            {preferences.length === 0 ? (
              <div className="fox-chief-empty">{t("chief.preferences.empty")}</div>
            ) : preferences.map((item: ChiefPreference) => (
              <div className="fox-preference" key={item.id}>
                <span>{item.text}</span>
                <button type="button" disabled={busy === `preference:${item.id}`} onClick={() => void removePreference(item.id)} title={t("chief.preferences.remove")}>
                  <Trash2 size={11} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
