"use client";

import { AlertTriangle, Check } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { SidebarSessionStatus } from "@/lib/sidebar-types";

const LABEL_KEYS: Record<Exclude<SidebarSessionStatus, "idle">, string> = {
  waiting: "sidebar.status.waiting",
  running: "sessionSidebar.agentRunningAria",
  exited: "sidebar.status.exited",
  unread: "sessionSidebar.newSessionActivity",
  completed: "sessionSidebar.recentlyCompleted",
};

/**
 * Leading 16 x 20 seat of a session row. The caller resolves the precedence
 * (waiting > running > exited > unread > completed > idle); an idle seat is an
 * empty spacer so titles stay aligned.
 */
export function StatusSeat({ status }: { status: SidebarSessionStatus }) {
  const { t } = useI18n();
  if (status === "idle") return <span className="sb-seat" aria-hidden="true" />;
  const label = t(LABEL_KEYS[status]);
  return (
    <span className="sb-seat" data-status={status} role="img" aria-label={label} title={label}>
      {status === "running" && <span className="sb-spinner" aria-hidden="true" />}
      {(status === "waiting" || status === "unread") && <span className="sb-dot" aria-hidden="true" />}
      {status === "exited" && <AlertTriangle size={13} strokeWidth={2.2} aria-hidden="true" />}
      {status === "completed" && <Check size={13} strokeWidth={2.4} aria-hidden="true" />}
    </span>
  );
}
