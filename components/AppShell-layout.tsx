"use client";

import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { CircleAlert, MessageSquareText } from "lucide-react";
import { useI18n } from "@/lib/i18n";

// Resizable desktop sidebar: the width is stored on the container as the
// --sidebar-width CSS variable (globals.css) and persisted between sessions.
export const SIDEBAR_WIDTH_STORAGE_KEY = "omp-web:sidebar-width";
export const SIDEBAR_MIN_WIDTH = 220;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 280;
export const SIDEBAR_KEY_STEP = 12;
export const SIDEBAR_KEY_STEP_LARGE = 32;

export function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)));
}

export function loadSidebarWidth(): number {
  if (typeof window === "undefined") return SIDEBAR_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const width = raw ? Number(raw) : NaN;
    return Number.isFinite(width) ? clampSidebarWidth(width) : SIDEBAR_DEFAULT_WIDTH;
  } catch {
    return SIDEBAR_DEFAULT_WIDTH;
  }
}

/**
 * Interface Scale (html[data-ui-scale] zoom) leaves clientX in viewport pixels
 * while the sidebar width is zoomed layout pixels. `--ui-scale` is the ground
 * truth the zoom-aware menus use too.
 */
export function readUiScale(): number {
  try {
    const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale"));
    return Number.isFinite(value) && value > 0 ? value : 1;
  } catch {
    return 1;
  }
}

/** Sidebar width while dragging: the pointer delta is divided by the interface scale so the edge tracks the pointer at any zoom. */
export function dragSidebarWidth(startWidth: number, startX: number, clientX: number, uiScale: number): number {
  return clampSidebarWidth(startWidth + (clientX - startX) / uiScale);
}

/** Window-splitter keys: arrows step 12 px (Shift 32), Home/End jump to the limits, Enter resets. Null for any other key. */
export function sidebarWidthForKey(key: string, shiftKey: boolean, width: number): number | null {
  const step = shiftKey ? SIDEBAR_KEY_STEP_LARGE : SIDEBAR_KEY_STEP;
  if (key === "ArrowLeft") return clampSidebarWidth(width - step);
  if (key === "ArrowRight") return clampSidebarWidth(width + step);
  if (key === "Home") return SIDEBAR_MIN_WIDTH;
  if (key === "End") return SIDEBAR_MAX_WIDTH;
  if (key === "Enter") return SIDEBAR_DEFAULT_WIDTH;
  return null;
}

type SidebarResizeDrag = { pointerId: number; startX: number; startWidth: number; uiScale: number; width: number };

/**
 * Separator between the sidebar and the chat. A drag uses pointer capture and
 * writes --sidebar-width straight onto the sidebar element (no React render per
 * move); the final width is committed once on release.
 */
export function SidebarResizeHandle({ sidebarRef, width, onCommit }: {
  sidebarRef: RefObject<HTMLElement | null>;
  width: number;
  onCommit: (width: number) => void;
}) {
  const { t } = useI18n();
  const drag = useRef<SidebarResizeDrag | null>(null);

  const show = (value: number) => sidebarRef.current?.style.setProperty("--sidebar-width", `${value}px`);
  const end = (event: PointerEvent<HTMLDivElement>, commit: boolean) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    drag.current = null;
    event.currentTarget.removeAttribute("data-resizing");
    sidebarRef.current?.removeAttribute("data-resizing");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (commit) onCommit(current.width);
    else show(width);
  };

  return (
    <div
      className="sidebar-resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={t("appShell.resizeSidebar")}
      aria-controls="workspace-sidebar"
      aria-valuenow={width}
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      tabIndex={0}
      title={t("appShell.resizeSidebarTitle")}
      onPointerDown={(event) => {
        if (!event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.setAttribute("data-resizing", "");
        sidebarRef.current?.setAttribute("data-resizing", "");
        drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, uiScale: readUiScale(), width };
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || event.pointerId !== current.pointerId) return;
        current.width = dragSidebarWidth(current.startWidth, current.startX, event.clientX, current.uiScale);
        show(current.width);
      }}
      onPointerUp={(event) => end(event, true)}
      onPointerCancel={(event) => end(event, false)}
      onDoubleClick={() => onCommit(SIDEBAR_DEFAULT_WIDTH)}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        const next = sidebarWidthForKey(event.key, event.shiftKey, width);
        if (next === null) return;
        event.preventDefault();
        onCommit(next);
      }}
    />
  );
}

// Resizable right (file) panel: null means the fluid 42% default; a number is
// a user-chosen pixel width persisted between sessions (same drag pattern as
// the left sidebar, mirrored — the handle sits on the panel's left edge).
export const RIGHT_PANEL_WIDTH_STORAGE_KEY = "omp-web:right-panel-width";
export const RIGHT_PANEL_MIN_WIDTH = 300;
export const RIGHT_PANEL_MAX_WIDTH = 900;

export function clampRightPanelWidth(width: number): number {
  return Math.min(RIGHT_PANEL_MAX_WIDTH, Math.max(RIGHT_PANEL_MIN_WIDTH, Math.round(width)));
}

export function loadRightPanelWidth(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY);
    if (!raw) return null;
    const width = Number(raw);
    return Number.isFinite(width) ? clampRightPanelWidth(width) : null;
  } catch {
    return null;
  }
}

type WorkspaceStateKind = "loading" | "error" | "empty";

export function WorkspaceState({
  kind,
  title,
  detail,
}: {
  kind: WorkspaceStateKind;
  title: string;
  detail?: ReactNode;
}) {
  return (
    <div
      className={`workspace-state workspace-state-${kind}`}
      role={kind === "error" ? "alert" : kind === "loading" ? "status" : undefined}
      aria-busy={kind === "loading" ? true : undefined}
      aria-label={kind === "loading" ? title : undefined}
    >
      <div className="workspace-state-surface">
        {kind === "loading" ? (
          <div className="workspace-state-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        ) : kind === "error" ? (
          <CircleAlert className="workspace-state-icon" size={18} strokeWidth={1.8} aria-hidden="true" />
        ) : (
          <MessageSquareText className="workspace-state-icon" size={18} strokeWidth={1.8} aria-hidden="true" />
        )}
        <div className="workspace-state-copy">
          <div className="workspace-state-title">{title}</div>
          {detail ? <div className="workspace-state-detail">{detail}</div> : null}
        </div>
      </div>
    </div>
  );
}

export function PanelLoadingFallback() {
  const { t } = useI18n();
  return <WorkspaceState kind="loading" title={t("appShell.loading")} />;
}
