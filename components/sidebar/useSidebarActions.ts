"use client";

import { useMemo, useRef } from "react";
import {
  setRunningOnly,
  setSortMode,
  showLess,
  showMore,
  toggleFork,
  toggleSection,
} from "@/lib/sidebar-ui-state";
import { saveRecentRunsLimitState } from "@/hooks/useRecentRunsLimit";
import { recentRunsChoice } from "./recent-runs-choice";
import type { SidebarActions } from "./types";
import type { SessionActions } from "./useSessionActions";
import type { SidebarUiUpdate } from "./useSidebarUi";
import type { WorkspaceActions } from "./useWorkspaceActions";

export interface SidebarActionParts {
  readonly session: SessionActions;
  readonly workspace: WorkspaceActions;
  readonly update: SidebarUiUpdate;
  readonly changeSearch: (query: string) => void;
  readonly stopSearch: () => void;
  /** Reload everything the list shows. */
  readonly refresh: () => void;
  readonly openArchive: () => void;
  readonly pickImportFile: () => void;
}

/**
 * The one `SidebarActions` object. It never changes identity (a new object
 * re-renders every mounted row); the parts that do change are read at call time.
 */
export function useSidebarActions(parts: SidebarActionParts): SidebarActions {
  const live = useRef(parts);
  live.current = parts;
  const { session, workspace } = parts;

  return useMemo<SidebarActions>(() => {
    const update: SidebarUiUpdate = (reducer) => live.current.update(reducer);
    return {
      openSession: session.openSession,
      toggleFork: (id) => update((state) => toggleFork(state, id)),
      pinSession: session.pinSession,
      renameSession: session.renameSession,
      archiveSession: session.archiveSession,
      deleteSession: session.deleteSession,
      copyTranscript: session.copyTranscript,
      copySessionId: session.copySessionId,

      toggleGroup: workspace.toggleGroup,
      newSessionInWorkspace: workspace.newSessionInWorkspace,
      setWorkspaceAlias: workspace.setWorkspaceAlias,
      editLaunchConfig: workspace.editLaunchConfig,
      pinWorkspace: workspace.pinWorkspace,
      moveWorkspace: workspace.moveWorkspace,
      removeWorkspace: workspace.removeWorkspace,

      toggleSection: (section) => update((state) => toggleSection(state, section)),
      showMore: (key) => update((state) => showMore(state, key)),
      showLess: (key) => update((state) => showLess(state, key)),

      setSortMode: (mode) => update((state) => setSortMode(state, mode)),
      setRunningOnly: (runningOnly) => update((state) => setRunningOnly(state, runningOnly)),
      // The limit belongs to the settings hook, which feeds it back into the UI state and the store.
      setRecentRunsLimit: (limit) => {
        const { preset, custom } = recentRunsChoice(limit);
        saveRecentRunsLimitState(preset, custom);
      },
      addWorkspace: workspace.addWorkspace,

      openArchive: () => live.current.openArchive(),
      importSession: () => live.current.pickImportFile(),
      refresh: () => live.current.refresh(),

      changeSearch: (query) => live.current.changeSearch(query),
      stopSearch: () => live.current.stopSearch(),
      retry: () => live.current.refresh(),
    };
  }, [session, workspace]);
}
