import { comparableProjectPath } from "@/lib/comparable-path";
import { normalizeProjectKey } from "@/lib/session-tree";
import { markStickyOpen } from "@/lib/sidebar-ui-state";
import type { SidebarUiState } from "@/lib/sidebar-types";
import type { ManagedProject, SessionInfo } from "@/lib/types";
import type { WorktreeState } from "@/lib/worktree-context";

// Pure decisions about which workspace/cwd the sidebar points at. The
// container owns the state; everything that can be decided without React lives
// here. Projects are always compared through `comparableProjectPath`.

/**
 * The workspace root a cwd belongs to, from the freshest data available.
 * A worktree belongs to the repository whose cached Git state lists it, never
 * to another repository's. Then the project registry, then a session with the
 * same cwd (its `projectRoot` is canonical), then the cwd itself.
 */
export function resolveProjectRoot(
  cwd: string | null,
  sources: {
    readonly worktreeStates: Iterable<WorktreeState>;
    readonly projects: readonly ManagedProject[];
    readonly sessions: readonly SessionInfo[];
  },
): string | null {
  if (!cwd) return null;
  const normalized = normalizeProjectKey(cwd);
  for (const state of sources.worktreeStates) {
    if (state.worktrees.some((worktree) => normalizeProjectKey(worktree.path) === normalized)) return state.projectRoot;
  }
  const folded = comparableProjectPath(cwd);
  const registered = sources.projects.find((project) => comparableProjectPath(project.path) === folded);
  if (registered) return registered.path;
  const match = sources.sessions.find((session) => comparableProjectPath(session.cwd) === folded);
  return match?.projectRoot ?? cwd;
}

/** Registry path of the first workspace in display order (`projectOrder` holds comparable keys). */
export function topWorkspacePath(projectOrder: readonly string[], projects: readonly ManagedProject[]): string | null {
  const first = projectOrder[0];
  if (first === undefined) return null;
  return projects.find((project) => comparableProjectPath(project.path) === first)?.path ?? first;
}

export interface DefaultWorkspaceInput {
  readonly selectedCwd: string | null;
  /** The current selection was an automatic pick made while the ordering was incomplete. */
  readonly provisional: boolean;
  readonly topPath: string | null;
  /** The session list is still empty: the ordering is provisional. */
  readonly sessionsEmpty: boolean;
  /** A `?session=` restore is still looking for its session. */
  readonly restorePending: boolean;
  readonly skipInitialSelection: boolean;
}

/**
 * Automatic selection when nothing points anywhere: the top workspace, so New
 * Session and the explorer have a context. When it was picked before the
 * sessions arrived it is re-picked once they do, unless the user chose by hand.
 */
export function planDefaultWorkspace(input: DefaultWorkspaceInput): { cwd: string; provisional: boolean } | null {
  if (input.skipInitialSelection || input.restorePending) return null;
  if (input.selectedCwd !== null && !input.provisional) return null;
  if (input.topPath === null) return null;
  return { cwd: input.topPath, provisional: input.sessionsEmpty };
}

/**
 * Clicking a workspace row. An unselected workspace is selected and opened
 * (never folded by the click that selects it); the selected one toggles.
 */
export function planGroupClick(group: { readonly selected: boolean; readonly expanded: boolean }): "select-and-open" | "toggle" {
  return group.selected ? "toggle" : "select-and-open";
}

/**
 * The workspace being left stays open (not persisted) so rows do not jump
 * under the pointer, unless the user folded it explicitly.
 */
export function keepOpenWhenLeaving(ui: SidebarUiState, leftProjectKey: string): SidebarUiState {
  if (ui.collapsedProjects.has(comparableProjectPath(leftProjectKey))) return ui;
  return markStickyOpen(ui, leftProjectKey);
}

/**
 * After a workspace is removed: the cwd to select instead, `undefined` when
 * the selection is unaffected. Compared case-folded; the selected cwd can
 * spell the folder differently than the row (Windows/NTFS).
 */
export function selectionAfterRemoval(
  selectedProject: string | null,
  removedPath: string,
  remainingPaths: readonly string[],
): string | null | undefined {
  if (selectedProject === null || comparableProjectPath(selectedProject) !== comparableProjectPath(removedPath)) return undefined;
  const removed = comparableProjectPath(removedPath);
  return remainingPaths.find((path) => comparableProjectPath(path) !== removed) ?? null;
}
