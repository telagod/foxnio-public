"use client";

import { memo } from "react";
import { ArrowDownUp, ChevronRight, Plus, SlidersHorizontal } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { SidebarSectionId, SidebarSectionRow } from "@/lib/sidebar-types";
import { IconButton, RowFrame, frameLayout, rowPropsEqual, type RowBaseProps } from "./row-support";
import type { WorkspaceToolbarState } from "./types";

const LABEL_KEYS: Record<SidebarSectionId, string> = {
  pinned: "sidebar.section.pinned",
  workspaces: "projects.heading",
};

export interface SectionRowProps extends RowBaseProps<SidebarSectionRow> {
  /** Sort / filter / add controls; only the `workspaces` section shows them. */
  readonly toolbar: WorkspaceToolbarState | undefined;
}

function SectionRowView(props: SectionRowProps) {
  const { row, actions, ui, toolbar } = props;
  const { t } = useI18n();
  const label = t(LABEL_KEYS[row.section]);
  const title = (
    <>
      <span className="sb-section-label">{label}</span>
      <span className="sb-count-chip">{row.count}</span>
    </>
  );

  return (
    <RowFrame
      {...frameLayout(props)}
      kind="section"
      expanded={row.collapsible ? !row.collapsed : undefined}
      data-section={row.section}
      data-collapsed={row.collapsible ? row.collapsed : undefined}
    >
      {row.collapsible ? (
        <button
          type="button"
          className="sb-main sb-section-main"
          tabIndex={-1}
          aria-label={t(row.collapsed ? "sidebar.section.expand" : "sidebar.section.collapse", { name: label })}
          onClick={() => actions.toggleSection(row.section)}
        >
          <ChevronRight className="sb-chevron" size={12} strokeWidth={2.2} aria-hidden="true" />
          {title}
        </button>
      ) : (
        <span className="sb-section-main">{title}</span>
      )}
      {row.section === "workspaces" && toolbar && (
        <span className="sb-toolbar">
          <IconButton
            tabbable={false}
            label={t("projects.sort")}
            expanded={toolbar.openMenu === "sort"}
            className={toolbar.sortMode === "none" ? undefined : "sb-active"}
            onClick={(event) => ui.openToolbarMenu("sort", { element: event.currentTarget })}
          >
            <ArrowDownUp size={14} strokeWidth={1.9} aria-hidden="true" />
          </IconButton>
          <IconButton
            tabbable={false}
            label={t("sessionSidebar.filterRunning")}
            title={t("sessionSidebar.filterRunningTitle", { count: toolbar.recentRunsLimit })}
            expanded={toolbar.openMenu === "filter"}
            className={toolbar.runningOnly ? "sb-active" : undefined}
            onClick={(event) => ui.openToolbarMenu("filter", { element: event.currentTarget })}
          >
            <SlidersHorizontal size={14} strokeWidth={1.9} aria-hidden="true" />
          </IconButton>
          <IconButton tabbable={false} label={t("projects.add")} title={t("projects.addTitle")} onClick={() => actions.addWorkspace()}>
            <Plus size={14} strokeWidth={2} aria-hidden="true" />
          </IconButton>
        </span>
      )}
    </RowFrame>
  );
}

export const SectionRow = memo(SectionRowView, rowPropsEqual);
