"use client";

import { memo, useRef, type MouseEvent, type ReactNode } from "react";
import { ChevronDown, GitBranch, MoreHorizontal, Pin } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { formatRelativeTime } from "@/lib/session-tree";
import type { SidebarSessionRow } from "@/lib/sidebar-types";
import { InlineEdit } from "./InlineEdit";
import { IconButton, RowFrame, frameLayout, rowPropsEqual, type RowBaseProps } from "./row-support";
import { sessionHref } from "./session-href";
import { StatusSeat } from "./StatusSeat";
import type { RowMode } from "./types";
import { useMinuteClock } from "./useMinuteClock";

/** Visual indent stops at this fork depth (the model may report deeper nesting). */
const MAX_VISUAL_DEPTH = 3;

export interface SessionRowProps extends RowBaseProps<SidebarSessionRow> {
  /** Inline editing state of this row, if any. */
  readonly mode: RowMode | undefined;
  /** True while this row's menu is open (keeps the row actions visible). */
  readonly menuOpen: boolean;
}

function SessionRowView(props: SessionRowProps) {
  const { row, density, actions, ui, mode, menuOpen } = props;
  const { t, locale } = useI18n();
  const now = useMinuteClock();
  const frameRef = useRef<HTMLDivElement>(null);
  const touch = density === "touch";
  const href = row.optimistic ? undefined : sessionHref(row.sessionId);
  const time = row.status === "waiting" ? t("sidebar.status.waitingShort") : formatRelativeTime(row.timestamp, locale, now);
  // Compact rows have no room for a second line, so the snippet only shows in comfortable and touch rows.
  const snippet = density === "compact" ? undefined : row.snippet;
  const twoLine = touch || snippet !== undefined;

  const restoreFocus = () => requestAnimationFrame(() => frameRef.current?.focus({ preventScroll: true }));
  const endMode = (focus: boolean) => {
    ui.endMode();
    if (focus) restoreFocus();
  };

  const open = (event: MouseEvent) => {
    // Let the browser handle modified clicks on the real link (new tab, new window, download).
    if (href && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
    event.preventDefault();
    actions.openSession(row.sessionId);
  };

  const chips = (
    <>
      {row.context !== "tree" && row.workspaceLabel && (
        <span className="sb-chip sb-chip--workspace" title={row.workspaceLabel}>{row.workspaceLabel}</span>
      )}
      {row.worktreeBranch && (
        <span className="sb-chip sb-chip--branch" title={t("sidebar.branchTitle", { branch: row.worktreeBranch })}>
          <GitBranch size={10} strokeWidth={2.4} aria-hidden="true" />
          <span className="sb-chip-text">{row.worktreeBranch}</span>
        </span>
      )}
    </>
  );

  let body: ReactNode;
  if (mode === "rename") {
    body = (
      <InlineEdit
        initial={row.title}
        label={t("sessionSidebar.rename")}
        onCommit={(value, viaKeyboard) => {
          if (value && value !== row.title) actions.renameSession(row.sessionId, value);
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
        aria-label={t("sessionSidebar.deleteConfirm", { title: row.title })}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          endMode(true);
        }}
      >
        <span className="sb-confirm-text" title={t("sessionSidebar.deleteConfirmBody")}>{t("sidebar.confirm.delete")}</span>
        <button
          type="button"
          className="sb-confirm-btn sb-confirm-btn--danger"
          onClick={() => {
            actions.deleteSession(row.sessionId);
            ui.endMode();
          }}
        >
          {t("sessionSidebar.delete")}
        </button>
        <button type="button" className="sb-confirm-btn" autoFocus onClick={() => endMode(true)}>
          {t("sessionSidebar.cancel")}
        </button>
      </div>
    );
  } else {
    const content = (
      <span className="sb-text">
        <span className="sb-line">
          <span className="sb-title" title={row.title}>{row.title}</span>
          {!twoLine && chips}
        </span>
        {twoLine && (
          <span className="sb-line sb-meta">
            {touch && time && <time className="sb-time" dateTime={row.timestamp} data-status={row.status}>{time}</time>}
            {chips}
            {snippet && <span className="sb-snippet" title={snippet}>{snippet}</span>}
          </span>
        )}
      </span>
    );
    body = (
      <>
        {href ? (
          <a className="sb-main" href={href} tabIndex={-1} aria-current={row.selected ? "page" : undefined} onClick={open}>{content}</a>
        ) : (
          <button type="button" className="sb-main" tabIndex={-1} aria-current={row.selected ? "page" : undefined} onClick={open}>{content}</button>
        )}
        {row.hasChildren && (
          <button
            type="button"
            className="sb-icon-btn sb-fork-toggle"
            tabIndex={-1}
            aria-expanded={row.expanded}
            aria-label={row.expanded ? t("sessionSidebar.collapseForks") : t("sessionSidebar.expandForks")}
            title={row.expanded ? t("sessionSidebar.collapseForks") : t("sessionSidebar.expandForks")}
            onClick={() => actions.toggleFork(row.sessionId)}
          >
            <ChevronDown size={12} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
        <span className="sb-trailing">
          {!touch && (
            <span className="sb-trailing-info">
              {row.pinned && row.context !== "pinned" && <Pin className="sb-pin-marker" size={10} strokeWidth={2.2} aria-label={t("sidebar.pinned")} role="img" />}
              {time && <time className="sb-time" dateTime={row.timestamp} data-status={row.status}>{time}</time>}
            </span>
          )}
          {!row.optimistic && (
            <span className="sb-actions">
              {!touch && (
                <IconButton
                  tabbable={false}
                  label={row.pinned ? t("sidebar.menu.unpin") : t("sidebar.menu.pin")}
                  pressed={row.pinned}
                  onClick={() => actions.pinSession(row.sessionId, !row.pinned)}
                >
                  <Pin size={13} strokeWidth={2} aria-hidden="true" />
                </IconButton>
              )}
              <IconButton
                tabbable={false}
                label={t("sidebar.sessionActions")}
                expanded={menuOpen}
                onClick={(event) => ui.openRowMenu(row.key, { element: event.currentTarget })}
              >
                <MoreHorizontal size={14} strokeWidth={2} aria-hidden="true" />
              </IconButton>
            </span>
          )}
        </span>
      </>
    );
  }

  return (
    <RowFrame
      {...frameLayout(props)}
      ref={frameRef}
      kind="session"
      selected={row.selected}
      expanded={row.hasChildren ? row.expanded : undefined}
      data-status={row.status}
      data-context={row.context}
      data-depth={Math.min(row.depth, MAX_VISUAL_DEPTH)}
      data-selected={row.selected}
      data-pinned={row.pinned}
      data-menu-open={menuOpen}
      data-mode={mode}
      data-lines={twoLine ? 2 : 1}
    >
      <StatusSeat status={row.status} />
      {body}
    </RowFrame>
  );
}

export const SessionRow = memo(SessionRowView, rowPropsEqual);
