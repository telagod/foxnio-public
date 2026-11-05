"use client";

import { memo, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { SidebarPlaceholderRow } from "@/lib/sidebar-types";
import { rowPropsEqual, type RowBaseProps } from "./row-support";

export type PlaceholderRowProps = RowBaseProps<SidebarPlaceholderRow>;

/**
 * Loading, error and empty states. They are not tree items (no selection, no
 * roving focus); their buttons are ordinary tab stops.
 */
function PlaceholderRowView({ row, index, top, height, density, actions }: PlaceholderRowProps) {
  const { t } = useI18n();
  let content: ReactNode;
  switch (row.variant) {
    case "loading":
      return (
        <div
          className="sb-row sb-row--placeholder"
          role="status"
          aria-label={t("sessionSidebar.loading")}
          data-variant="loading"
          data-density={density}
          data-row-index={index}
          style={{ height, transform: `translateY(${top}px)` }}
        >
          <span className="skeleton sb-skeleton" data-bar={index % 3} aria-hidden="true" />
        </div>
      );
    case "error": {
      const message = row.detail ?? t("sidebar.loadFailed");
      content = (
        <>
          <span className="sb-placeholder-text" role="alert" title={message}>{message}</span>
          <button type="button" className="sb-placeholder-btn" onClick={() => actions.retry()}>{t("sidebar.retry")}</button>
        </>
      );
      break;
    }
    case "no-workspaces":
      content = (
        <>
          <span className="sb-placeholder-text" title={t("projects.noProjects")}>{t("sidebar.empty.noWorkspaces")}</span>
          <button type="button" className="sb-placeholder-btn" onClick={() => actions.addWorkspace()}>{t("projects.add")}</button>
        </>
      );
      break;
    case "empty-workspace":
      content = <span className="sb-placeholder-text">{t("projects.emptyProject")}</span>;
      break;
    case "no-matches":
      content = <span className="sb-placeholder-text">{t("sessionSidebar.noMatches")}</span>;
      break;
    case "searching":
      content = (
        <>
          <Loader2 className="sb-searching-icon" size={12} strokeWidth={2} aria-hidden="true" />
          <span className="sb-placeholder-text" title={t("sessionSidebar.searchingTranscripts")}>{t("sidebar.searching")}</span>
          <button type="button" className="sb-placeholder-btn" onClick={() => actions.stopSearch()}>{t("sessionSidebar.stopSearch")}</button>
        </>
      );
      break;
  }

  return (
    <div
      className="sb-row sb-row--placeholder"
      role={row.variant === "searching" ? "status" : "none"}
      data-variant={row.variant}
      data-density={density}
      data-row-index={index}
      style={{ height, transform: `translateY(${top}px)` }}
    >
      {content}
    </div>
  );
}

export const PlaceholderRow = memo(PlaceholderRowView, rowPropsEqual);
