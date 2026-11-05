export interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

export interface WorktreeState {
  /** The cwd this data was fetched for; guards against stale responses. */
  forCwd: string;
  projectRoot: string;
  isGit: boolean;
  /** False when forCwd is a repo subdirectory: the switcher is hidden there
   *  because subdirectory sessions keep their own project identity. */
  isTopLevel: boolean;
  worktrees: WorktreeEntry[];
}

/** The active Git workspace's worktrees plus the actions that change them
 *  (owned by the sidebar, rendered by the file panel's Worktrees tab). */
export interface WorktreeContext {
  projectRoot: string;
  worktrees: WorktreeEntry[];
  /** Path of the worktree the workspace currently points at. */
  currentPath: string;
  select(path: string): void;
  /** Creates the branch's worktree and selects it; rejects with an Error whose message is user-facing. */
  create(branch: string): Promise<void>;
  /** Resolves "dirty" when the worktree has uncommitted changes and force was false; rejects with a user-facing Error otherwise. */
  remove(path: string, force: boolean): Promise<"removed" | "dirty">;
}
