"use client";

import { ChevronRight, LoaderCircle } from "lucide-react";
import FoxLogo from "@/components/FoxLogo";
import { useBriefing } from "@/hooks/useBriefing";
import { useI18n } from "@/lib/i18n";

/**
 * The pinned FOX entry above the workspace tree. It shows actionable items
 * from native session attention, including pending questions, without
 * changing the workspace tree's position or expansion.
 */
export function FoxCard({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  const { t, tn } = useI18n();
  const { briefing, loading, error } = useBriefing();
  const count = briefing?.needsYou.length ?? 0;
  const incomplete = Boolean(error || briefing?.warnings?.length);
  const statusText = loading ? t("fox.overview.loading")
    : incomplete ? t("fox.card.partial")
      : count ? tn("fox.card.needYou", count)
        : t("fox.native.cardHint");

  return (
    <button
      type="button"
      className="sb-fox-entry ui-focus-ring"
      data-active={active}
      onClick={onOpen}
      aria-pressed={active}
      aria-label={`${t("fox.open")} · ${statusText}`}
      title={t("fox.open")}
    >
      <FoxLogo size={26} />
      <span className="sb-fox-entry-copy"><strong>{t("fox.workspaceTitle")}</strong><small>{statusText}</small></span>
      {count > 0 ? <span className="sb-fox-entry-count">{count}</span> : loading ? <LoaderCircle size={14} className="icon-spin" aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
    </button>
  );
}
