"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DirectoryPicker } from "@/components/DirectoryPicker";
import { ProjectLaunchConfigDialog } from "@/components/ProjectLaunchConfigDialog";
import { ProviderUsageBar } from "@/components/ProviderUsageBar";
import { getSessionStore, useSessionStoreSelector } from "@/hooks/useSessionStore";
import { useSidebarSearch } from "@/hooks/useSidebarSearch";
import { comparableProjectPath } from "@/lib/comparable-path";
import { useNotificationHistory } from "@/lib/notification-history";
import { selectSession, shallowEqualSet, type SessionStoreSnapshot } from "@/lib/session-store";
import { sessionIdsWaitingForInput } from "@/lib/session-tabs";
import { openProject, pruneProjects } from "@/lib/sidebar-ui-state";
import type { ManagedProject, SessionInfo } from "@/lib/types";
import type { WorktreeContext } from "@/lib/worktree-context";
import { setLastOpenSession, workspaceKeyOf } from "@/lib/workspace-memory";
import { shouldFocusSearch } from "./global-keys";
import { SidebarView } from "./SidebarView";
import type { SidebarNavigation } from "./types";
import { useInitialSessionRestore } from "./useInitialSessionRestore";
import { useSessionActions } from "./useSessionActions";
import { useSidebarActions } from "./useSidebarActions";
import { useSidebarData } from "./useSidebarData";
import { useSidebarDensity } from "./useSidebarDensity";
import { useSidebarModel } from "./useSidebarModel";
import { useSidebarUi } from "./useSidebarUi";
import { useSidebarWorktrees } from "./useSidebarWorktrees";
import { sameItems, useStable } from "./useStable";
import { useWorkspaceActions } from "./useWorkspaceActions";
import { useSelectedCwd, useWorkspaceSync } from "./useWorkspaceSelection";
import { keepOpenWhenLeaving, topWorkspacePath } from "./workspace-selection";

export interface SidebarProps {
  selectedSessionId: string | null;
  /** The active session can exist in memory before its JSONL file is flushed. */
  optimisticSession?: SessionInfo | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean) => void;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  onInitialRestoreDone?: () => void;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (cwd: string | null, projectRoot?: string | null) => void;
  /** Workspaces in display order, the selected workspace root and the effective cwd. */
  onWorkspaceOptionsChange?: (projects: ManagedProject[], selectedProject: string | null, cwd: string | null) => void;
  /** The active Git workspace's worktrees and actions (null when the active
   *  workspace is not a Git top-level repo); rendered by the file panel. */
  onWorktreeContextChange?: (ctx: WorktreeContext | null) => void;
  addProjectOpen: boolean;
  setAddProjectOpen: (open: boolean) => void;
  /** Shows the provider usage bar above Settings; toggle lives in Settings. */
  usageVisible?: boolean;
  /** Opens the app settings (pinned sidebar footer row). */
  onOpenSettings?: () => void;
  /** True when an omp/ompweb update is available: shows a badge on the gear. */
  updateAvailable?: boolean;
  /** Opens the archived sessions browser. */
  onOpenArchive?: () => void;
  /** In-app back/forward over visited chat views (sidebar header buttons). */
  navigation?: SidebarNavigation;
  /** True when the settings full-page view is currently open. */
  settingsOpen?: boolean;
  /** Collapse (desktop) or close (drawer) control in the header. */
  onClose?: () => void;
  /** Drawer layout: no back/forward in the header, touch interaction. */
  mobile?: boolean;
  /** FOX workspace is the active main view. */
  foxOpen?: boolean;
  /** Opens the FOX workspace from the pinned sidebar card. */
  onOpenFox?: () => void;
}

function ignore(): void {}

/**
 * The session sidebar: wires the session store, the row model, the persisted UI
 * state and the search into `SidebarView` and implements every action it can
 * ask for. Callers reload data through the store (`store.refresh`).
 */
export const Sidebar = memo(function Sidebar({
  selectedSessionId,
  optimisticSession,
  onSelectSession,
  onNewSession,
  initialSessionId,
  skipInitialProjectSelection,
  onInitialRestoreDone,
  onSessionDeleted,
  selectedCwd: selectedCwdProp,
  onCwdChange,
  onWorkspaceOptionsChange,
  onWorktreeContextChange,
  addProjectOpen,
  setAddProjectOpen,
  usageVisible = true,
  onOpenSettings,
  updateAvailable,
  onOpenArchive,
  navigation,
  settingsOpen = false,
  onClose,
  mobile = false,
  foxOpen = false,
  onOpenFox,
}: SidebarProps) {
  const store = getSessionStore();
  const data = useSidebarData();
  const { ui, update } = useSidebarUi();
  const { search, query, setQuery, stop: stopSearch } = useSidebarSearch(data.sessions, data.projects);
  const density = useSidebarDensity();

  const notifications = useNotificationHistory();
  const waiting = useStable(
    useMemo(() => sessionIdsWaitingForInput(notifications), [notifications]),
    shallowEqualSet,
  );

  // ---- Selection ---------------------------------------------------------------
  const selection = useSelectedCwd();
  const reloadProjects = useCallback(() => void store.refresh({ projects: true }), [store]);
  const { projectRootFor, selectedProject, refresh: refreshWorktrees } = useSidebarWorktrees({
    selectedCwd: selection.cwd,
    selectCwd: selection.select,
    projects: data.projects,
    sessions: data.sessions,
    onChanged: reloadProjects,
    onContextChange: onWorktreeContextChange,
  });
  const openWorkspace = useCallback((path: string) => update((state) => openProject(state, path)), [update]);

  // The workspace being left stays open, so rows do not jump under the pointer.
  const selectedKey = selectedProject ? comparableProjectPath(selectedProject) : null;
  const [lastSelectedKey, setLastSelectedKey] = useState(selectedKey);
  if (lastSelectedKey !== selectedKey) {
    setLastSelectedKey(selectedKey);
    if (lastSelectedKey !== null) update((state) => keepOpenWhenLeaving(state, lastSelectedKey));
  }

  // ---- Rows --------------------------------------------------------------------
  const model = useSidebarModel({
    data,
    waiting,
    ui,
    search,
    selectedSessionId,
    selectedProjectKey: selectedProject,
    optimisticSession: optimisticSession ?? null,
    pending: data.unlistedLive || Boolean(optimisticSession),
  });
  const projectOrder = useStable(model.projectOrder, sameItems);

  // Opening FOX keeps the workspace tree stable. The selected workspace and
  // manually expanded groups retain their positions and expansion.

  // ---- Restore and default selection -------------------------------------------
  const selectCwd = selection.select;
  const restoreSession = useCallback((target: SessionInfo) => {
    selectCwd(target.cwd);
    openWorkspace(workspaceKeyOf(target));
    onSelectSession(target, true);
  }, [selectCwd, openWorkspace, onSelectSession]);
  const restore = useInitialSessionRestore({
    initialSessionId,
    skip: skipInitialProjectSelection,
    sessionsLoading: data.sessionsStatus === "loading",
    onRestore: restoreSession,
    onGiveUp: onInitialRestoreDone,
  });
  const topPath = useMemo(() => topWorkspacePath(projectOrder, data.projects), [projectOrder, data.projects]);
  useWorkspaceSync({
    selection,
    selectedCwdProp,
    onCwdChange,
    projectRootFor,
    openWorkspace,
    topPath,
    sessionsEmpty: data.sessions.length === 0,
    restorePending: restore.pending,
    skipInitialSelection: Boolean(skipInitialProjectSelection),
  });

  // ---- Reports to the shell ----------------------------------------------------
  const orderedProjects = useMemo<ManagedProject[]>(() => {
    const byKey = new Map(data.projects.map((project) => [comparableProjectPath(project.path), project]));
    return projectOrder.map((key) => byKey.get(key) ?? { path: key });
  }, [projectOrder, data.projects]);
  useEffect(() => {
    onWorkspaceOptionsChange?.(orderedProjects, selectedProject, selection.cwd);
  }, [onWorkspaceOptionsChange, orderedProjects, selectedProject, selection.cwd]);

  // Never prune stored expansion before the first project list arrived: it is empty until then.
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  if (!projectsLoaded && data.projectsStatus === "ready") setProjectsLoaded(true);
  useEffect(() => {
    update((state) => pruneProjects(state, projectOrder, projectsLoaded));
  }, [update, projectOrder, projectsLoaded]);

  // ---- Store bridge ------------------------------------------------------------
  useEffect(() => {
    store.applyOptimisticSession(optimisticSession ?? null);
  }, [store, optimisticSession]);
  useEffect(() => {
    store.setViewedSession(selectedSessionId);
    return () => store.setViewedSession(null);
  }, [store, selectedSessionId]);
  const selectOpenSession = useCallback(
    (snapshot: SessionStoreSnapshot) => (selectedSessionId ? selectSession(snapshot, selectedSessionId) : undefined),
    [selectedSessionId],
  );
  const openSessionInfo = useSessionStoreSelector(selectOpenSession);
  useEffect(() => {
    if (openSessionInfo) setLastOpenSession(workspaceKeyOf(openSessionInfo), openSessionInfo.id);
  }, [openSessionInfo]);

  // A finished run may have created branches or worktrees.
  const previousRunning = useRef(data.running);
  useEffect(() => {
    const before = previousRunning.current;
    previousRunning.current = data.running;
    for (const id of before) {
      if (!data.running.has(id)) {
        refreshWorktrees();
        return;
      }
    }
  }, [data.running, refreshWorktrees]);

  // ---- Actions -----------------------------------------------------------------
  const session = useSessionActions({
    selectCwd: selection.select,
    openWorkspace,
    projectRootFor,
    onSelectSession,
    onSessionDeleted,
    optimisticSession,
  });
  const workspace = useWorkspaceActions({
    model,
    pinsActive: ui.sortMode !== "none",
    selectedProject,
    selectCwd: selection.select,
    update,
    setAddProjectOpen,
    onNewSession,
  });
  const importInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const refresh = useCallback(() => {
    void store.refresh({ force: true, projects: true });
    refreshWorktrees();
  }, [store, refreshWorktrees]);
  const actions = useSidebarActions({
    session,
    workspace: workspace.actions,
    update,
    changeSearch: setQuery,
    stopSearch,
    refresh,
    openArchive: () => onOpenArchive?.(),
    pickImportFile: () => importInputRef.current?.click(),
  });

  // `/` jumps to the search box unless the user is typing somewhere.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const input = searchInputRef.current;
      if (!input || input.closest("[inert]") || !shouldFocusSearch(event)) return;
      event.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const filters = useMemo(
    () => ({ sortMode: ui.sortMode, runningOnly: ui.runningOnly, recentRunsLimit: ui.recentRunsLimit }),
    [ui.sortMode, ui.runningOnly, ui.recentRunsLimit],
  );
  const searchState = useMemo(() => ({ query, searching: search?.searching ?? false }), [query, search?.searching]);
  const usage = useMemo(() => (usageVisible ? <ProviderUsageBar /> : undefined), [usageVisible]);
  const { addDialog, launchConfigDialog } = workspace;

  return (
    <>
      <SidebarView
        rows={model.rows}
        density={density}
        actions={actions}
        selectedRowIndex={selectedSessionId ? model.sessionRowIndex.get(selectedSessionId) ?? null : null}
        mobile={mobile}
        search={searchState}
        searchInputRef={searchInputRef}
        filters={filters}
        navigation={navigation}
        onClose={onClose}
        foxOpen={foxOpen}
        onOpenFox={onOpenFox}
        usage={usage}
        settingsOpen={settingsOpen}
        updateAvailable={updateAvailable}
        onOpenSettings={onOpenSettings ?? ignore}
      />
      <input
        ref={importInputRef}
        type="file"
        accept=".jsonl,.json,application/json,application/jsonl"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          event.target.value = "";
          void session.importFile(file);
        }}
      />
      {addProjectOpen && (
        <DirectoryPicker busy={addDialog.busy} error={addDialog.error} onCancel={addDialog.cancel} onSelect={addDialog.commit} />
      )}
      {launchConfigDialog && (
        <ProjectLaunchConfigDialog
          projectPath={launchConfigDialog.project.path}
          initialConfig={launchConfigDialog.project.launchConfig}
          onClose={launchConfigDialog.close}
          onSave={launchConfigDialog.save}
        />
      )}
    </>
  );
});
