import { comparableProjectPath } from "@/lib/comparable-path";
import { normalizeProjectKey } from "@/lib/session-tree";
import type { WorktreeContext, WorktreeEntry, WorktreeState } from "@/lib/worktree-context";

/**
 * Git state per repository, keyed by the normalized repository root. Switching
 * workspaces never leaks one repository's branch/worktree data into another's
 * UI, and a late response for a previous repository only updates its own entry.
 */
export type WorktreeStates = Readonly<Record<string, WorktreeState>>;

/** `GET /api/worktrees` answer. */
export interface WorktreeResponse {
  projectRoot?: string;
  isGit?: boolean;
  isTopLevel?: boolean;
  worktrees?: WorktreeEntry[];
  error?: string;
}

export const NO_WORKTREE_STATES: WorktreeStates = {};

/**
 * Cache a fetched answer. A cwd that is not a Git repo (or a failed lookup)
 * leaves everything as is: a non-Git workspace never inherits another repo's
 * branch, and previously visited repos keep their state.
 */
export function withFetchedWorktreeState(prev: WorktreeStates, requestedCwd: string, data: WorktreeResponse): WorktreeStates {
  if (data.error || !data.projectRoot) return prev;
  const entry: WorktreeState = {
    forCwd: requestedCwd,
    projectRoot: data.projectRoot,
    isGit: data.isGit ?? false,
    isTopLevel: data.isTopLevel ?? false,
    worktrees: data.worktrees ?? [],
  };
  return { ...prev, [normalizeProjectKey(data.projectRoot)]: entry };
}

/**
 * Register a just-created worktree against ITS repository's entry so a cwd
 * inside it resolves to the main repo before the refetch lands (the shell must
 * not treat the new cwd as a different project).
 */
export function withCreatedWorktree(prev: WorktreeStates, root: string, path: string, branch: string): WorktreeStates {
  const key = normalizeProjectKey(root);
  const existing = prev[key];
  if (!existing) return prev;
  const created: WorktreeEntry = { path, branch, isMain: false };
  return { ...prev, [key]: { ...existing, forCwd: path, worktrees: [...existing.worktrees, created] } };
}

/** Drop a removed worktree from its repository's entry; `forCwd` falls back to the root when it pointed there. */
export function withoutWorktree(prev: WorktreeStates, root: string, path: string, selectedCwd: string | null): WorktreeStates {
  const key = normalizeProjectKey(root);
  const existing = prev[key];
  if (!existing) return prev;
  const removed = comparableProjectPath(path);
  const selectedRemoved = selectedCwd !== null && comparableProjectPath(selectedCwd) === removed;
  return {
    ...prev,
    [key]: {
      ...existing,
      forCwd: selectedRemoved ? root : existing.forCwd,
      worktrees: existing.worktrees.filter((worktree) => comparableProjectPath(worktree.path) !== removed),
    },
  };
}

/** The repository state of the selected workspace, if known. */
export function activeGitState(states: WorktreeStates, selectedProject: string | null): WorktreeState | undefined {
  return selectedProject ? states[normalizeProjectKey(selectedProject)] : undefined;
}

/**
 * The switcher exists only for a Git top-level repo whose root is the selected
 * workspace. Compared case-folded: the workspace may be spelled differently
 * than the server-resolved git root (Windows/NTFS) yet be the same repo.
 */
export function hasWorktreeSwitcher(state: WorktreeState | undefined, selectedCwd: string | null, selectedProject: string | null): state is WorktreeState {
  return Boolean(
    state?.isGit
    && state.isTopLevel
    && selectedCwd
    && selectedProject !== null
    && comparableProjectPath(selectedProject) === comparableProjectPath(state.projectRoot),
  );
}

/** The worktree the cwd points at, else the main one, else the repo root. */
export function currentWorktreePath(state: WorktreeState, selectedCwd: string | null): string {
  const folded = comparableProjectPath(selectedCwd ?? "");
  const current = state.worktrees.find((worktree) => comparableProjectPath(worktree.path) === folded)
    ?? state.worktrees.find((worktree) => worktree.isMain);
  return current?.path ?? state.projectRoot;
}

/** What the file panel's Worktrees tab gets: null unless the workspace is a Git top-level repo. */
export function buildWorktreeContext(
  states: WorktreeStates,
  selectedCwd: string | null,
  selectedProject: string | null,
  actions: Pick<WorktreeContext, "select" | "create" | "remove">,
): WorktreeContext | null {
  const state = activeGitState(states, selectedProject);
  if (!hasWorktreeSwitcher(state, selectedCwd, selectedProject)) return null;
  return {
    projectRoot: state.projectRoot,
    worktrees: state.worktrees,
    currentPath: currentWorktreePath(state, selectedCwd),
    ...actions,
  };
}
