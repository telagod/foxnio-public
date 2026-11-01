"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { MessageCircleQuestion, Plus, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useNotificationHistory } from "@/lib/notification-history";
import { sessionIdsWaitingForInput, type SessionTab } from "@/lib/session-tabs";
import { RunningSessionIndicator } from "./SessionSidebar-chrome";

interface Props {
  tabs: SessionTab[];
  /** The session on screen; null on the new-chat view. */
  activeId: string | null;
  runningIds: ReadonlySet<string>;
  onSelect: (tab: SessionTab) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  newDisabled?: boolean;
  onMove: (id: string, toIndex: number) => void;
  onShift: (id: string, direction: -1 | 1) => void;
}

/**
 * Desktop tab strip above the chat: one tab per open session. Tabs are
 * shortcuts: the app keeps a single live chat, so activating a tab selects that
 * session there. Keyboard: arrows/Home/End move focus, Enter/Space opens,
 * Delete closes, Ctrl+Shift+arrows reorders (activation is manual so arrowing
 * past tabs never reconnects each session on the way).
 */
export function SessionTabs({ tabs, activeId, runningIds, onSelect, onClose, onNew, newDisabled = false, onMove, onShift }: Props) {
  const { t } = useI18n();
  // Subscribed here, not in the shell, so a notification arriving re-renders only the strip.
  const notifications = useNotificationHistory();
  const waitingIds = useMemo(() => sessionIdsWaitingForInput(notifications), [notifications]);
  const listRef = useRef<HTMLDivElement>(null);
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);

  const focusTab = (id: string) => {
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-session-tab-id="${CSS.escape(id)}"]`)?.focus();
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>, tab: SessionTab) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(tab);
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      onClose(tab.id);
      return;
    }
    const index = tabs.findIndex((item) => item.id === tab.id);
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      onShift(tab.id, event.key === "ArrowLeft" ? -1 : 1);
      focusTab(tab.id);
      return;
    }
    let next: number | null = null;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    focusTab(tabs[next].id);
  };

  // Keep the active tab in view when the strip overflows.
  useEffect(() => {
    const list = listRef.current;
    if (!list || !activeId) return;
    const active = list.querySelector<HTMLElement>(`[data-session-tab-id="${CSS.escape(activeId)}"]`);
    if (!active) return;
    const listRect = list.getBoundingClientRect();
    const tabRect = active.getBoundingClientRect();
    if (tabRect.left < listRect.left) list.scrollLeft -= listRect.left - tabRect.left;
    else if (tabRect.right > listRect.right) list.scrollLeft += tabRect.right - listRect.right;
  }, [activeId, tabs.length]);

  const endDrag = () => {
    setDragId(null);
    setDropId(null);
  };
  const handleDrop = (event: DragEvent<HTMLElement>, targetId: string) => {
    event.preventDefault();
    const index = tabs.findIndex((tab) => tab.id === targetId);
    if (dragId && index >= 0) onMove(dragId, index);
    endDrag();
  };

  const hasActiveTab = tabs.some((tab) => tab.id === activeId);

  return (
    <div className="session-tabs" style={{ display: "flex", alignItems: "stretch", flexShrink: 0, height: "var(--tab-height)", background: "var(--bg-panel)", borderBottom: "1px solid var(--border)" }}>
      <div
        ref={listRef}
        role="tablist"
        aria-label={t("sessionTabs.ariaLabel")}
        aria-orientation="horizontal"
        className="session-tabs-list"
        style={{ display: "flex", alignItems: "flex-end", flex: "0 1 auto", minWidth: 0, overflowX: "auto", overflowY: "hidden" }}
      >
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeId;
          const running = runningIds.has(tab.id);
          const waiting = waitingIds.has(tab.id);
          const title = tab.title || t("appShell.newSession");
          const label = waiting ? t("sessionTabs.waiting", { title }) : running ? t("sessionTabs.running", { title }) : title;
          return (
            <div
              key={tab.id}
              data-session-tab-id={tab.id}
              className="tabbar-tab session-tab ui-focus-ring"
              role="tab"
              aria-selected={isActive}
              aria-label={label}
              aria-description={tabs.length > 1 ? t("sessionTabs.reorderHint") : undefined}
              tabIndex={isActive || (!hasActiveTab && index === 0) ? 0 : -1}
              title={tab.cwd ? `${title}\n${tab.cwd}` : title}
              draggable
              onClick={() => onSelect(tab)}
              onKeyDown={(event) => handleKeyDown(event, tab)}
              onMouseDown={(event) => {
                // Middle click would start the browser's autoscroll.
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                event.stopPropagation();
                onClose(tab.id);
              }}
              onDragStart={(event) => {
                setDragId(tab.id);
                event.dataTransfer.effectAllowed = "move";
                // Firefox starts a drag only when some data is set.
                event.dataTransfer.setData("text/plain", tab.id);
              }}
              onDragOver={(event) => {
                if (!dragId) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                if (dropId !== tab.id) setDropId(tab.id);
              }}
              onDrop={(event) => handleDrop(event, tab.id)}
              onDragEnd={endDrag}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                height: "var(--tab-height)",
                paddingLeft: 12,
                paddingRight: 6,
                borderRight: "1px solid var(--border)",
                boxShadow: dragId && dropId === tab.id && dragId !== tab.id ? "inset 2px 0 0 var(--accent)" : undefined,
                background: isActive ? "var(--bg)" : "var(--bg-panel)",
                opacity: dragId === tab.id ? 0.55 : 1,
                cursor: "pointer",
                fontSize: "var(--text-sm)",
                color: isActive ? "var(--text)" : "var(--text-muted)",
                whiteSpace: "nowrap",
                maxWidth: 220,
                minWidth: 96,
                flexShrink: 0,
                userSelect: "none",
                position: "relative",
              }}
            >
              {isActive && (
                <span
                  aria-hidden="true"
                  style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2, background: "var(--accent)", borderTopLeftRadius: "var(--radius-control)", borderTopRightRadius: "var(--radius-control)" }}
                />
              )}
              {waiting ? (
                <span title={t("sessionTabs.waitingTitle")} style={{ display: "inline-flex", flexShrink: 0, color: "var(--accent)" }}>
                  <MessageCircleQuestion size={12} strokeWidth={2.2} aria-hidden="true" />
                </span>
              ) : running ? (
                <RunningSessionIndicator size={12} />
              ) : null}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", flex: 1, minWidth: 0, fontWeight: isActive ? 500 : 400 }}>
                {title}
              </span>
              <button
                type="button"
                className="tabbar-close ui-focus-ring"
                onClick={(event) => { event.stopPropagation(); onClose(tab.id); }}
                tabIndex={-1}
                onKeyDown={(event) => event.stopPropagation()}
                onMouseEnter={() => setHoveredClose(tab.id)}
                onMouseLeave={() => setHoveredClose(null)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: "var(--icon-control-size-compact)", height: "var(--icon-control-size-compact)",
                  background: hoveredClose === tab.id ? "var(--bg-hover)" : "transparent",
                  border: "none",
                  borderRadius: "var(--radius-control)",
                  color: hoveredClose === tab.id ? "var(--text)" : "var(--text-dim)",
                  cursor: "pointer",
                  padding: 0,
                  flexShrink: 0,
                }}
                title={t("sessionTabs.close")}
                aria-label={t("sessionTabs.closeTab", { title })}
              >
                <X size={11} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="tabbar-tab ui-focus-ring"
        onClick={onNew}
        disabled={newDisabled}
        title={t("sessionTabs.new")}
        aria-label={t("sessionTabs.new")}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: "var(--tab-height)", height: "var(--tab-height)",
          flexShrink: 0, padding: 0, border: "none", background: "transparent",
          color: "var(--text-muted)", cursor: newDisabled ? "default" : "pointer",
          opacity: newDisabled ? 0.45 : 1,
        }}
      >
        <Plus size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}
