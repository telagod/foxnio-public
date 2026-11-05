import type { ProjectSortMode } from "@/lib/project-ordering";
import type { SidebarSectionId } from "@/lib/sidebar-types";

export interface OpenSessionOptions {
  /** Open in a new browser tab instead of the current one. */
  readonly newTab?: boolean;
}

/**
 * Everything the sidebar can ask its owner to do. The container implements the
 * whole set once and passes ONE stable object; rows never receive per-row
 * callbacks. Session ids are `SessionInfo.id`, workspaces are addressed by the
 * `projectKey` of their group row.
 *
 * Confirmation for destructive actions (delete session, remove workspace)
 * happens inline in the row before these are called; the container must not
 * ask again.
 */
export interface SidebarActions {
  // Sessions
  openSession(sessionId: string, options?: OpenSessionOptions): void;
  toggleFork(sessionId: string): void;
  pinSession(sessionId: string, pinned: boolean): void;
  /** `title` is trimmed and non-empty. */
  renameSession(sessionId: string, title: string): void;
  archiveSession(sessionId: string): void;
  deleteSession(sessionId: string): void;
  copyTranscript(sessionId: string): void;
  copySessionId(sessionId: string): void;

  // Workspaces
  toggleGroup(projectKey: string): void;
  /** `path` is the directory the new session starts in (the group's `path`). */
  newSessionInWorkspace(projectKey: string, path: string): void;
  /** Empty `alias` clears the alias. */
  setWorkspaceAlias(projectKey: string, alias: string): void;
  editLaunchConfig(projectKey: string): void;
  pinWorkspace(projectKey: string, pinned: boolean): void;
  moveWorkspace(projectKey: string, direction: -1 | 1): void;
  removeWorkspace(projectKey: string): void;

  // Sections and "show more"
  toggleSection(section: SidebarSectionId): void;
  showMore(projectKey: string): void;
  showLess(projectKey: string): void;

  // Workspaces toolbar
  setSortMode(mode: ProjectSortMode): void;
  setRunningOnly(runningOnly: boolean): void;
  setRecentRunsLimit(limit: number): void;
  addWorkspace(): void;

  // Overflow menu
  openArchive(): void;
  importSession(): void;
  refresh(): void;

  // Search and placeholders
  changeSearch(query: string): void;
  stopSearch(): void;
  retry(): void;
}

/** What a row is currently being edited as. */
export type RowMode = "rename" | "confirm";

/** Where a menu is anchored: an element, optionally at the pointer position (context menu). */
export interface MenuAnchor {
  readonly element: HTMLElement;
  readonly point?: { readonly x: number; readonly y: number };
}

export type ToolbarMenuKind = "sort" | "filter" | "overflow";

/**
 * View-state hooks of the list, created once by the view (stable). They are
 * separate from `SidebarActions` because they only change presentation.
 */
export interface RowUi {
  /** Open (or, for a button anchor, toggle) the menu of a session/group row. */
  openRowMenu(rowKey: string, anchor: MenuAnchor): void;
  openToolbarMenu(kind: ToolbarMenuKind, anchor: MenuAnchor): void;
  beginMode(rowKey: string, mode: RowMode): void;
  endMode(): void;
}

/** Current values of the workspaces toolbar; rendered by the `workspaces` section row. */
export interface WorkspaceToolbarState {
  readonly sortMode: ProjectSortMode;
  readonly runningOnly: boolean;
  readonly recentRunsLimit: number;
  /** Which of the toolbar's menus is open, for `aria-expanded`. */
  readonly openMenu: ToolbarMenuKind | null;
}

/** Back/forward over visited chat views (sidebar header buttons). */
export interface SidebarNavigation {
  readonly canBack: boolean;
  readonly canForward: boolean;
  readonly onBack: () => void;
  readonly onForward: () => void;
  /** Platform shortcut label for the tooltip, e.g. "⌘[" / "Alt+←". */
  readonly backShortcut: string;
  readonly forwardShortcut: string;
}

export type MenuTarget =
  | { readonly type: "row"; readonly rowKey: string }
  | { readonly type: "sort" }
  | { readonly type: "filter" }
  | { readonly type: "overflow" };

/** The one menu that is open, if any. */
export interface OpenMenu {
  readonly target: MenuTarget;
  readonly anchor: MenuAnchor;
  /** Element that had focus when the menu opened; focus goes back there on close. */
  readonly returnFocus: HTMLElement | null;
}
