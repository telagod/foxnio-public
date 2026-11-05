"use client";

import { useEffect, useMemo, useRef } from "react";
import { useI18n } from "@/lib/i18n";
import { buildSidebarModel, type SidebarLiveHint, type SidebarModelResult } from "@/lib/sidebar-model";
import type { SidebarSearchState, SidebarUiState } from "@/lib/sidebar-types";
import type { SessionInfo } from "@/lib/types";
import { combineLoadState } from "./load-state";
import { frozenOrderFor, orderingKey, type OrderSnapshot } from "./pending-order";
import type { SidebarData } from "./useSidebarData";

export interface SidebarModelOptions {
  readonly data: SidebarData;
  /** Sessions with an unanswered question for the user. */
  readonly waiting: ReadonlySet<string>;
  readonly ui: SidebarUiState;
  readonly search: SidebarSearchState | null;
  readonly selectedSessionId: string | null;
  readonly selectedProjectKey: string | null;
  readonly optimisticSession: SessionInfo | null;
  /** A new session is pending: the workspace order stays as it was. */
  readonly pending: boolean;
}

/** Where live sessions that are not listed yet run, from what the store knows. */
function liveHintsOf(data: Pick<SidebarData, "running" | "runningCwd" | "exited">): Map<string, SidebarLiveHint> {
  const hints = new Map<string, SidebarLiveHint>();
  for (const id of data.running) {
    const cwd = data.runningCwd.get(id);
    if (cwd) hints.set(id, { cwd });
  }
  for (const [id, exit] of data.exited) {
    if (!hints.has(id) && exit.cwd) hints.set(id, { cwd: exit.cwd });
  }
  return hints;
}

/**
 * The rows of the sidebar. Recomputed only when one of its inputs changes; a
 * store frame that leaves the slices alone costs nothing.
 */
export function useSidebarModel(options: SidebarModelOptions): SidebarModelResult {
  const { data, waiting, ui, search, selectedSessionId, selectedProjectKey, optimisticSession, pending } = options;
  const { t } = useI18n();
  const { running, runningCwd, exited } = data;
  const liveHints = useMemo(() => liveHintsOf({ running, runningCwd, exited }), [running, runningCwd, exited]);

  const key = useMemo(() => orderingKey(ui.sortMode, data.projects), [ui.sortMode, data.projects]);
  const snapshot = useRef<OrderSnapshot | null>(null);
  const frozenOrder = frozenOrderFor(snapshot.current, pending, key);
  const effectiveUi = useMemo(() => (frozenOrder ? { ...ui, orderFrozen: true } : ui), [ui, frozenOrder]);

  const { sessionsStatus, sessionsError, projectsStatus, projectsError } = data;
  const load = useMemo(
    () => combineLoadState(
      { sessionsStatus, sessionsError, projectsStatus, projectsError },
      (messageKey, detail) => t(messageKey, { detail }),
    ),
    [sessionsStatus, sessionsError, projectsStatus, projectsError, t],
  );

  const model = useMemo(
    () => buildSidebarModel(
      {
        sessions: data.sessions,
        projects: data.projects,
        sessionsStatus: load.status,
        sessionsError: load.error,
        running: data.running,
        waiting,
        exited: data.exited,
        unread: data.unread,
        recentlyCompleted: data.recentlyCompleted,
        pinnedSessionIds: data.pinnedSessionIds,
        selectedSessionId,
        selectedProjectKey,
        optimisticSession,
        ui: effectiveUi,
        search,
      },
      { liveHints, frozenOrder },
    ),
    [data.sessions, data.projects, load, data.running, waiting, data.exited, data.unread, data.recentlyCompleted, data.pinnedSessionIds, selectedSessionId, selectedProjectKey, optimisticSession, effectiveUi, search, liveHints, frozenOrder],
  );

  // Only committed orders are remembered: render work React discards must not leak into the freeze.
  useEffect(() => {
    if (!frozenOrder) snapshot.current = { key, order: model.projectOrder };
  }, [frozenOrder, key, model.projectOrder]);

  return model;
}
