"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { comparableProjectPath } from "@/lib/comparable-path";
import type { ManagedProject, SessionInfo } from "@/lib/types";
import type { WorktreeContext } from "@/lib/worktree-context";
import { createWorktree, fetchWorktrees, removeWorktree } from "./worktree-api";
import {
  NO_WORKTREE_STATES,
  activeGitState,
  buildWorktreeContext,
  withCreatedWorktree,
  withFetchedWorktreeState,
  withoutWorktree,
  type WorktreeStates,
} from "./worktree-state";
import { resolveProjectRoot } from "./workspace-selection";

export interface SidebarWorktreesOptions {
  readonly selectedCwd: string | null;
  /** Moves the effective cwd (selecting a worktree, or falling back to the root after removing it). */
  readonly selectCwd: (cwd: string) => void;
  readonly projects: readonly ManagedProject[];
  readonly sessions: readonly SessionInfo[];
  /** Called after a worktree was created or removed: its sessions and projects changed. */
  readonly onChanged: () => void;
  readonly onContextChange?: (context: WorktreeContext | null) => void;
}

export interface SidebarWorktrees {
  /** The workspace root of a cwd (see `resolveProjectRoot`). */
  readonly projectRootFor: (cwd: string | null) => string | null;
  /** Workspace root of the selected cwd. */
  readonly selectedProject: string | null;
  /** Refetch the Git state of the selected workspace. */
  readonly refresh: () => void;
}

/**
 * Git state of the selected workspace and the context the file panel's
 * Worktrees tab renders. State is cached per repository, so switching
 * workspaces never shows another repository's branches.
 */
export function useSidebarWorktrees(options: SidebarWorktreesOptions): SidebarWorktrees {
  const { selectedCwd, projects, sessions, onContextChange } = options;
  const [states, setStates] = useState<WorktreeStates>(NO_WORKTREE_STATES);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!selectedCwd) return;
    let cancelled = false;
    void fetchWorktrees(fetch, selectedCwd).then((data) => {
      if (!cancelled && data) setStates((prev) => withFetchedWorktreeState(prev, selectedCwd, data));
    });
    return () => {
      cancelled = true;
    };
  }, [selectedCwd, refreshKey]);

  const projectRootFor = useCallback(
    (cwd: string | null) => resolveProjectRoot(cwd, { worktreeStates: Object.values(states), projects, sessions }),
    [states, projects, sessions],
  );
  const selectedProject = useMemo(() => projectRootFor(selectedCwd), [projectRootFor, selectedCwd]);

  // Create/remove act on the active repo's own state and read the latest values through a ref,
  // so the context handed to the file panel changes only when the Git state does.
  const live = useRef({ states, selectedCwd, selectedProject, onChanged: options.onChanged, selectCwd: options.selectCwd });
  live.current = { states, selectedCwd, selectedProject, onChanged: options.onChanged, selectCwd: options.selectCwd };

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  const create = useCallback(async (branch: string) => {
    const { states: current, selectedProject: project } = live.current;
    const root = activeGitState(current, project)?.projectRoot;
    if (!root) return;
    const path = await createWorktree(fetch, root, branch);
    // Register the worktree before the refetch lands so it resolves to this repo, not to a new project.
    setStates((prev) => withCreatedWorktree(prev, root, path, branch));
    live.current.selectCwd(path);
    setRefreshKey((key) => key + 1);
    live.current.onChanged();
  }, []);

  const remove = useCallback(async (path: string, force: boolean): Promise<"removed" | "dirty"> => {
    const { states: current, selectedProject: project, selectedCwd: cwd } = live.current;
    const root = activeGitState(current, project)?.projectRoot;
    if (!root) return "removed";
    const outcome = await removeWorktree(fetch, root, path, force);
    if (outcome === "dirty") return outcome;
    setStates((prev) => withoutWorktree(prev, root, path, cwd));
    if (cwd !== null && comparableProjectPath(cwd) === comparableProjectPath(path)) live.current.selectCwd(root);
    setRefreshKey((key) => key + 1);
    live.current.onChanged();
    return "removed";
  }, []);

  const context = useMemo(
    () => buildWorktreeContext(states, selectedCwd, selectedProject, { select: options.selectCwd, create, remove }),
    [states, selectedCwd, selectedProject, options.selectCwd, create, remove],
  );
  useEffect(() => {
    onContextChange?.(context);
  }, [onContextChange, context]);

  return { projectRootFor, selectedProject, refresh };
}
