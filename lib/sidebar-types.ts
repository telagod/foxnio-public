import type { ExitedRpcSession, ManagedProject, SessionInfo } from "@/lib/types";
import type { ProjectSortMode } from "@/lib/project-ordering";

/**
 * Shared contract of the sidebar: the pure row model (`lib/sidebar-model.ts`)
 * produces `SidebarRow[]`, the virtual list measures them with
 * `SIDEBAR_ROW_HEIGHTS`, and `components/sidebar/*` renders them. Types only;
 * keep this file free of runtime logic apart from the height table.
 */

/** Row density. `touch` is used for coarse pointers or the "accessible" touch-target setting. */
export type SidebarDensity = "compact" | "comfortable" | "touch";

export type SidebarSectionId = "pinned" | "workspaces";

/**
 * What a session row shows in its leading seat, strongest first:
 * waiting (needs the user) > running > exited (child died) > unread (finished
 * while not viewed) > completed (finished recently, already seen) > idle.
 */
export type SidebarSessionStatus = "waiting" | "running" | "exited" | "unread" | "completed" | "idle";

/**
 * Row heights in CSS px, indexed by row kind. The virtual list positions rows with these numbers only.
 * Touch rows that hold a control are 44 px: rows are absolutely positioned siblings, so a pseudo-element
 * cannot stretch a hit area over the neighbouring rows.
 */
export const SIDEBAR_ROW_HEIGHTS: Readonly<Record<SidebarDensity, Readonly<Record<SidebarRow["kind"], number>>>> = {
  compact: { section: 26, group: 30, session: 28, more: 26, placeholder: 32 },
  comfortable: { section: 30, group: 34, session: 32, more: 28, placeholder: 36 },
  touch: { section: 44, group: 44, session: 44, more: 44, placeholder: 56 },
};

interface RowBase {
  /** Stable React key; unique across the whole list (a session may appear in several sections). */
  readonly key: string;
}

export interface SidebarSectionRow extends RowBase {
  readonly kind: "section";
  readonly section: SidebarSectionId;
  readonly count: number;
  readonly collapsed: boolean;
  /** `workspaces` is not collapsible; `pinned` is. */
  readonly collapsible: boolean;
}

export interface SidebarGroupRow extends RowBase {
  readonly kind: "group";
  readonly projectKey: string;
  /** Directory that new sessions start in (project root). */
  readonly path: string;
  /** Alias if set, else the directory name. */
  readonly label: string;
  readonly alias: string | undefined;
  readonly expanded: boolean;
  /** The workspace of the active session / selected cwd. */
  readonly selected: boolean;
  readonly pinned: boolean;
  readonly hasLaunchConfig: boolean;
  /** Aggregates over ALL sessions of the workspace, also while folded. */
  readonly counts: { readonly total: number; readonly running: number; readonly waiting: number; readonly unread: number; readonly exited: number };
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  /** Position among shown groups, for aria-posinset / aria-setsize. */
  readonly index: number;
  readonly setSize: number;
}

export interface SidebarSessionRow extends RowBase {
  readonly kind: "session";
  readonly sessionId: string;
  readonly projectKey: string;
  /** Fork depth below the workspace row (0 for roots and for flat lists such as Active/Pinned/search). */
  readonly depth: number;
  readonly status: SidebarSessionStatus;
  /** Display title: name, else first message, else id prefix. Already truncated for display. */
  readonly title: string;
  /** ISO timestamp the relative time is computed from (`lastMessageAt ?? modified`). */
  readonly timestamp: string;
  readonly worktreeBranch: string | undefined;
  readonly selected: boolean;
  readonly pinned: boolean;
  /** Has fork children in the list; `expanded` says whether they are shown. */
  readonly hasChildren: boolean;
  readonly expanded: boolean;
  /** Where the row is rendered: workspace tree rows are indented; flat rows show `workspaceLabel`. */
  readonly context: "tree" | "pinned" | "search";
  /** Workspace label for flat contexts (`pinned`, `search`). */
  readonly workspaceLabel: string | undefined;
  /** Search hit text around the best content match, if any. */
  readonly snippet: string | undefined;
  /** Placeholder session that exists in memory only (not flushed to disk yet): no menu actions. */
  readonly optimistic: boolean;
}

export interface SidebarMoreRow extends RowBase {
  readonly kind: "more";
  readonly projectKey: string;
  /** Sessions still hidden below this row (0 when the row only offers "show less"). */
  readonly hidden: number;
  readonly canCollapse: boolean;
}

export type SidebarPlaceholderVariant =
  | "loading"
  | "error"
  | "no-workspaces"
  | "empty-workspace"
  | "no-matches"
  | "searching";

export interface SidebarPlaceholderRow extends RowBase {
  readonly kind: "placeholder";
  readonly variant: SidebarPlaceholderVariant;
  readonly projectKey: string | undefined;
  /** Error text, when `variant` is `error`. */
  readonly detail: string | undefined;
}

export type SidebarRow =
  | SidebarSectionRow
  | SidebarGroupRow
  | SidebarSessionRow
  | SidebarMoreRow
  | SidebarPlaceholderRow;

/** User-controlled sidebar state (persisted in localStorage unless noted). */
export interface SidebarUiState {
  readonly sortMode: ProjectSortMode;
  /** Show only workspaces/sessions that are running or recently completed. */
  readonly runningOnly: boolean;
  readonly recentRunsLimit: number;
  /** Workspaces the user explicitly folded; wins over auto-open (selected/active workspaces) except for sticky ones. */
  readonly collapsedProjects: ReadonlySet<string>;
  readonly collapsedSections: ReadonlySet<SidebarSectionId>;
  /** Extra rows revealed per workspace through "show more" (not persisted). */
  readonly extraRows: ReadonlyMap<string, number>;
  /** Session ids whose fork subtree is folded. */
  readonly collapsedForks: ReadonlySet<string>;
  /** Workspaces kept open after the user navigated away so rows do not jump under the pointer (not persisted). */
  readonly stickyOpenProjects: ReadonlySet<string>;
  /** True while a new session is being created: ordering is frozen so rows do not jump. */
  readonly orderFrozen: boolean;
}

export interface SidebarSearchHit {
  readonly sessionId: string;
  readonly score: number;
  readonly snippet: string | undefined;
}

/** Search state fed to the model; `hits` is already ranked best-first. */
export interface SidebarSearchState {
  readonly query: string;
  readonly hits: readonly SidebarSearchHit[];
  /** True while the streaming transcript search is still running. */
  readonly searching: boolean;
}

export interface SidebarModelInput {
  readonly sessions: readonly SessionInfo[];
  readonly projects: readonly ManagedProject[];
  /** Load state of the two lists. */
  readonly sessionsStatus: "loading" | "ready" | "error";
  readonly sessionsError: string | undefined;
  readonly running: ReadonlySet<string>;
  /** Sessions with an unanswered question / approval for the user. */
  readonly waiting: ReadonlySet<string>;
  readonly exited: ReadonlyMap<string, ExitedRpcSession>;
  /** Finished while not being viewed. */
  readonly unread: ReadonlySet<string>;
  /** Finished recently and already seen. */
  readonly recentlyCompleted: ReadonlySet<string>;
  /** Pinned session ids, newest pin first. */
  readonly pinnedSessionIds: readonly string[];
  readonly selectedSessionId: string | null;
  readonly selectedProjectKey: string | null;
  /** Active session that exists only in memory. */
  readonly optimisticSession: SessionInfo | null;
  readonly ui: SidebarUiState;
  readonly search: SidebarSearchState | null;
}

export interface SidebarModel {
  readonly rows: readonly SidebarRow[];
  /** Row index of the first row showing each session / group, for scrollIntoView and keyboard focus. */
  readonly sessionRowIndex: ReadonlyMap<string, number>;
  readonly groupRowIndex: ReadonlyMap<string, number>;
}
