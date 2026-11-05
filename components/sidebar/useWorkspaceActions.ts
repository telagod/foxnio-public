"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "@/components/ui/toast";
import { getSessionStore } from "@/hooks/useSessionStore";
import { comparableProjectPath } from "@/lib/comparable-path";
import { useI18n } from "@/lib/i18n";
import { openProject, toggleProject } from "@/lib/sidebar-ui-state";
import type { SidebarGroupRow } from "@/lib/sidebar-types";
import type { SidebarModelResult } from "@/lib/sidebar-model";
import type { ManagedProject, ProjectLaunchConfig } from "@/lib/types";
import {
  addProject,
  orderUpdates,
  persistOrder,
  pinUpdate,
  removeProject,
  moveWorkspacePath,
  reorderableWorkspacePaths,
  updateProject,
  type ProjectPresentationUpdate,
} from "./project-requests";
import { newSessionId } from "./session-requests";
import type { SidebarActions } from "./types";
import type { SidebarUiUpdate } from "./useSidebarUi";
import { planGroupClick, selectionAfterRemoval } from "./workspace-selection";

type WorkspaceActionNames =
  | "toggleGroup"
  | "newSessionInWorkspace"
  | "setWorkspaceAlias"
  | "editLaunchConfig"
  | "pinWorkspace"
  | "moveWorkspace"
  | "removeWorkspace"
  | "addWorkspace";

export type WorkspaceActions = Pick<SidebarActions, WorkspaceActionNames>;

/** The add-workspace picker's state. */
export interface AddWorkspaceDialog {
  readonly busy: boolean;
  readonly error: string | null;
  readonly cancel: () => void;
  readonly commit: (path: string, launchConfig?: ProjectLaunchConfig) => void;
}

/** The launch-configuration dialog of one workspace. */
export interface LaunchConfigDialog {
  readonly project: ManagedProject;
  readonly close: () => void;
  readonly save: (config: ProjectLaunchConfig | null) => Promise<void>;
}

export interface WorkspaceActionsOptions {
  /** The rows currently shown; workspaces are addressed by the key of their group row. */
  readonly model: Pick<SidebarModelResult, "rows" | "groupRowIndex" | "projectOrder">;
  readonly pinsActive: boolean;
  readonly selectedProject: string | null;
  readonly selectCwd: (cwd: string | null) => void;
  readonly update: SidebarUiUpdate;
  readonly setAddProjectOpen: (open: boolean) => void;
  readonly onNewSession?: (sessionId: string, cwd: string) => void;
}

export interface WorkspaceActionsResult {
  readonly actions: WorkspaceActions;
  readonly addDialog: AddWorkspaceDialog;
  readonly launchConfigDialog: LaunchConfigDialog | null;
}

/** Apply a presentation change (alias, launch config, pin) and reload the project list. A refusal is toasted and rethrown. */
async function applyPresentation(path: string, change: ProjectPresentationUpdate, failure: string): Promise<void> {
  try {
    if (!(await updateProject(fetch, path, change))) throw new Error(failure);
    await getSessionStore().refresh({ sessions: false, projects: true });
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** Everything a workspace row and the workspaces toolbar can ask for. */
export function useWorkspaceActions(options: WorkspaceActionsOptions): WorkspaceActionsResult {
  const { t } = useI18n();
  const live = useRef({ options, t });
  live.current = { options, t };

  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [launchProject, setLaunchProject] = useState<ManagedProject | null>(null);
  const addBusyRef = useRef(false);

  const setAddProjectOpen = useCallback((open: boolean) => live.current.options.setAddProjectOpen(open), []);
  const commit = useCallback(async (path: string, launchConfig?: ProjectLaunchConfig) => {
    const candidate = path.trim();
    if (!candidate || addBusyRef.current) return;
    addBusyRef.current = true;
    setAddBusy(true);
    setAddError(null);
    try {
      const result = await addProject(fetch, candidate, launchConfig);
      if (!result.ok) {
        setAddError(result.error);
        return;
      }
      await getSessionStore().refresh({ sessions: false, projects: true });
      const { selectCwd, update } = live.current.options;
      selectCwd(result.value.path);
      update((state) => openProject(state, result.value.path));
      setAddProjectOpen(false);
    } catch (error) {
      setAddError(error instanceof Error ? error.message : String(error));
    } finally {
      addBusyRef.current = false;
      setAddBusy(false);
    }
  }, [setAddProjectOpen]);

  const cancel = useCallback(() => {
    setAddProjectOpen(false);
    setAddError(null);
  }, [setAddProjectOpen]);

  const actions = useMemo<WorkspaceActions>(() => {
    const store = getSessionStore();
    let orderWriteBusy = false;
    let removing = false;

    const groupOf = (projectKey: string): SidebarGroupRow | undefined => {
      const { rows, groupRowIndex } = live.current.options.model;
      const index = groupRowIndex.get(projectKey);
      const row = index === undefined ? undefined : rows[index];
      return row?.kind === "group" ? row : undefined;
    };
    const projectOf = (group: SidebarGroupRow): ManagedProject =>
      store.getSnapshot().projects.find((project) => comparableProjectPath(project.path) === group.projectKey) ?? { path: group.path };

    const present = (path: string, change: ProjectPresentationUpdate): Promise<void> =>
      applyPresentation(path, change, live.current.t("projects.updateFailed"));

    /** One ordering write at a time: each computes its payload from the list on screen, which is stale until the previous write reloads it. */
    const orderWrite = async (write: () => Promise<void>): Promise<void> => {
      if (orderWriteBusy) return;
      orderWriteBusy = true;
      try {
        await write();
      } finally {
        orderWriteBusy = false;
      }
    };

    return {
      toggleGroup(projectKey) {
        const group = groupOf(projectKey);
        if (!group) return;
        const { selectCwd, update } = live.current.options;
        if (planGroupClick(group) === "toggle") {
          update((state) => toggleProject(state, projectKey, group.expanded));
          return;
        }
        selectCwd(group.path);
        update((state) => openProject(state, projectKey));
      },

      newSessionInWorkspace(projectKey, path) {
        const { selectCwd, update, onNewSession } = live.current.options;
        selectCwd(path);
        update((state) => openProject(state, projectKey));
        onNewSession?.(newSessionId(), path);
      },

      async setWorkspaceAlias(projectKey, alias) {
        const group = groupOf(projectKey);
        if (!group) return;
        await present(group.path, { alias: alias.trim() }).catch(() => undefined);
      },

      editLaunchConfig(projectKey) {
        const group = groupOf(projectKey);
        if (group) setLaunchProject(projectOf(group));
      },

      async pinWorkspace(projectKey, pinned) {
        const group = groupOf(projectKey);
        if (!group) return;
        await orderWrite(async () => {
          const { cwd, pinOrder } = pinUpdate(projectOf(group), store.getSnapshot().projects, pinned);
          await present(cwd, { pinOrder }).catch(() => undefined);
        });
      },

      async moveWorkspace(projectKey, direction) {
        const group = groupOf(projectKey);
        if (!group) return;
        await orderWrite(async () => {
          const { model, pinsActive } = live.current.options;
          const paths = reorderableWorkspacePaths(model.projectOrder, store.getSnapshot().projects, pinsActive);
          const next = moveWorkspacePath(paths, group.path, direction);
          if (!next) return;
          try {
            if (!(await persistOrder(fetch, orderUpdates(next, pinsActive)))) throw new Error(live.current.t("projects.reorderFailed"));
          } catch (error) {
            toast.error(error instanceof Error ? error.message : String(error));
          }
          await store.refresh({ sessions: false, projects: true });
        });
      },

      async removeWorkspace(projectKey) {
        const group = groupOf(projectKey);
        if (!group || removing) return;
        removing = true;
        try {
          const result = await removeProject(fetch, group.path);
          if (!result.ok) {
            toast.error(result.error);
            return;
          }
          // Hiding the active workspace leaves nothing selected: move to the next one so New Session and the explorer stay usable.
          const { model, selectedProject, selectCwd } = live.current.options;
          const remaining = reorderableWorkspacePaths(model.projectOrder, store.getSnapshot().projects, false);
          const next = selectionAfterRemoval(selectedProject, group.path, remaining);
          if (next !== undefined) selectCwd(next);
          await store.refresh({ sessions: false, projects: true });
        } catch (error) {
          toast.error(error instanceof Error ? error.message : String(error));
        } finally {
          removing = false;
        }
      },

      addWorkspace() {
        setAddProjectOpen(true);
        setAddError(null);
      },
    };
  }, [setAddProjectOpen]);

  const closeLaunchConfig = useCallback(() => setLaunchProject(null), []);
  const saveLaunchConfig = useCallback(async (config: ProjectLaunchConfig | null) => {
    if (!launchProject) return;
    await applyPresentation(launchProject.path, { launchConfig: config }, live.current.t("projects.updateFailed"));
    toast.info(live.current.t("sessionSidebar.launchConfigSaved"));
  }, [launchProject]);

  return {
    actions,
    addDialog: { busy: addBusy, error: addError, cancel, commit: (path, launchConfig) => void commit(path, launchConfig) },
    launchConfigDialog: launchProject ? { project: launchProject, close: closeLaunchConfig, save: saveLaunchConfig } : null,
  };
}
