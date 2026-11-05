"use client";

import { useI18n } from "@/lib/i18n";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

/** Spinner arc that marks a session with a run in flight. */
export function RunningSessionIndicator({ size = 14 }: { size?: number }) {
  const { t } = useI18n();
  const reducedMotion = usePrefersReducedMotion();
  return (
    <span
      title={t("sessionSidebar.agentRunning")}
      aria-label={t("sessionSidebar.agentRunningAria")}
      style={{
        width: size,
        height: size,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "var(--accent)",
      }}
    >
      <span
        aria-hidden="true"
        className="sidebar-running-spinner"
        data-reduced-motion={reducedMotion ? "true" : "false"}
        style={{ width: size - 2, height: size - 2 }}
      />
    </span>
  );
}
