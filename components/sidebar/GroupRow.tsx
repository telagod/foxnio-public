"use client";

import { memo, useRef, type ReactNode } from "react";
import { ChevronRight, Folder, FolderOpen, MoreHorizontal, Pin, Plus } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { SidebarGroupRow } from "@/lib/sidebar-types";
import { InlineEdit } from "./InlineEdit";
import { IconButton, RowFrame, frameLayout, rowPropsEqual, type RowBaseProps } from "./row-support";
import type { RowMode } from "./types";

export interface GroupRowProps extends RowBaseProps<SidebarGroupRow> {
  readonly mode: RowMode | undefined;
  readonly menuOpen: boolean;
}

type FolderState = "waiting" | "running" | "exited" | "unread" | "idle";

/** Strongest activity of the workspace, shown as the dot on its folder icon. */
function folderState(counts: SidebarGroupRow["counts"]): FolderState {
  if (counts.waiting > 0) return "waiting";
  if (counts.running > 0) return "running";
  if (counts.exited > 0) return "exited";
  if (counts.unread > 0) return "unread";
  return "idle";
}

function GroupRowView(props: GroupRowProps) {
  const { row, actions, ui, mode, menuOpen } = props;
  const { t } = useI18n();
  const frameRef = useRef<HTMLDivElement>(null);
  const { counts } = row;
  const state = folderState(counts);
  const FolderIcon = row.expanded ? FolderOpen : Folder;

  const activity = [
    counts.waiting > 0 && t("sidebar.count.waiting", { count: counts.waiting }),
    counts.running > 0 && t("sidebar.count.running", { count: counts.running }),
    counts.unread > 0 && t("sidebar.count.unread", { count: counts.unread }),
    counts.exited > 0 && t("sidebar.count.exited", { count: counts.exited }),
  ].filter(Boolean).join(", ");

  const restoreFocus = () => requestAnimationFrame(() => frameRef.current?.focus({ preventScroll: true }));
  const endMode = (focus: boolean) => {
    ui.endMode();
    if (focus) restoreFocus();
  };

  let body: ReactNode;
  if (mode === "rename") {
    const current = row.alias ?? row.label;
    body = (
      <InlineEdit
        initial={current}
        label={t("projects.aliasPrompt")}
        onCommit={(value, viaKeyboard) => {
          const changed = value !== current && !(value === "" && row.alias === undefined);
          if (changed) actions.setWorkspaceAlias(row.projectKey, value);
          endMode(viaKeyboard);
        }}
        onCancel={() => endMode(true)}
      />
    );
  } else if (mode === "confirm") {
    body = (
      <div
        className="sb-confirm"
        role="group"
        aria-label={t("projects.remove", { name: row.label })}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          endMode(true);
        }}
      >
        <span className="sb-confirm-text" title={t("projects.removeTitle", { name: row.label })}>{t("sidebar.confirm.remove")}</span>
        <button
          type="button"
          className="sb-confirm-btn sb-confirm-btn--danger"
          onClick={() => {
            actions.removeWorkspace(row.projectKey);
            ui.endMode();
          }}
        >
          {t("projects.removeConfirmLabel")}
        </button>
        <button type="button" className="sb-confirm-btn" autoFocus onClick={() => endMode(true)}>
          {t("sessionSidebar.cancel")}
        </button>
      </div>
    );
  } else {
    body = (
      <>
        <button
          type="button"
          className="sb-main sb-group-main"
          tabIndex={-1}
          title={row.path}
          aria-label={row.expanded ? t("projects.collapseProject", { name: row.label }) : t("projects.expandProject", { name: row.label })}
          onClick={() => actions.toggleGroup(row.projectKey)}
        >
          <ChevronRight className="sb-chevron" size={13} strokeWidth={2} aria-hidden="true" />
          <span className="sb-folder" data-state={state} aria-hidden="true">
            <FolderIcon size={14} strokeWidth={1.9} />
            {state !== "idle" && <span className="sb-folder-dot" />}
          </span>
          <span className="sb-label">{row.label}</span>
          {row.pinned && <Pin className="sb-pin-marker" size={10} strokeWidth={2.2} aria-label={t("sidebar.pinned")} role="img" />}
        </button>
        <span className="sb-trailing">
          {activity && (
            <span className="sb-counts sb-trailing-info" role="img" aria-label={activity} title={activity}>
              {counts.waiting > 0 && (
                <span className="sb-count" data-kind="waiting" aria-hidden="true"><span className="sb-dot" />{counts.waiting}</span>
              )}
              {counts.running > 0 && (
                <span className="sb-count" data-kind="running" aria-hidden="true"><span className="sb-spinner sb-spinner--small" />{counts.running}</span>
              )}
              {counts.unread > 0 && (
                <span className="sb-count" data-kind="unread" aria-hidden="true"><span className="sb-dot" />{counts.unread}</span>
              )}
            </span>
          )}
          <span className="sb-actions">
            <IconButton
              tabbable={false}
              label={t("sidebar.newSessionHere")}
              title={t("sessionSidebar.newSessionIn", { cwd: row.path })}
              onClick={() => actions.newSessionInWorkspace(row.projectKey, row.path)}
            >
              <Plus size={14} strokeWidth={2.1} aria-hidden="true" />
            </IconButton>
            <IconButton
              tabbable={false}
              label={t("projects.actions")}
              expanded={menuOpen}
              onClick={(event) => ui.openRowMenu(row.key, { element: event.currentTarget })}
            >
              <MoreHorizontal size={14} strokeWidth={2} aria-hidden="true" />
            </IconButton>
          </span>
        </span>
      </>
    );
  }

  return (
    <RowFrame
      {...frameLayout(props)}
      ref={frameRef}
      kind="group"
      selected={row.selected}
      expanded={row.expanded}
      data-selected={row.selected}
      data-expanded={row.expanded}
      data-pinned={row.pinned}
      data-menu-open={menuOpen}
      data-mode={mode}
    >
      {body}
    </RowFrame>
  );
}

export const GroupRow = memo(GroupRowView, rowPropsEqual);
