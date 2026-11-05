import type { ProjectSortMode } from "@/lib/project-ordering";
import type { SidebarGroupRow, SidebarSessionRow } from "@/lib/sidebar-types";
import type { RowUi, SidebarActions } from "./types";

export type MenuIcon =
  | "external"
  | "pin"
  | "pin-off"
  | "rename"
  | "copy"
  | "id"
  | "archive"
  | "trash"
  | "plus"
  | "launch"
  | "up"
  | "down"
  | "import"
  | "refresh";

export type MenuEntry =
  | {
      readonly type: "item";
      readonly id: string;
      readonly label: string;
      readonly icon?: MenuIcon;
      /** Radio and checkbox items show their state through `checked`. */
      readonly role?: "menuitem" | "menuitemradio" | "menuitemcheckbox";
      readonly checked?: boolean;
      readonly danger?: boolean;
      readonly disabled?: boolean;
      /** Tooltip, e.g. why the item is disabled. */
      readonly hint?: string;
      readonly onSelect: () => void;
    }
  | { readonly type: "separator"; readonly id: string }
  | { readonly type: "label"; readonly id: string; readonly label: string };

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export interface MenuBuildContext {
  readonly actions: SidebarActions;
  readonly ui: Pick<RowUi, "beginMode">;
  readonly t: Translate;
}

const RECENT_RUNS_PRESETS: readonly number[] = [10, 15, 20];

const SORT_MODES: readonly { readonly mode: ProjectSortMode; readonly labelKey: string }[] = [
  { mode: "none", labelKey: "projects.sortNone" },
  { mode: "alphabetical", labelKey: "projects.sortAlphabetical" },
  { mode: "updated", labelKey: "projects.sortUpdated" },
];

/** Session menu; empty for placeholder sessions that exist in memory only. */
export function sessionMenuEntries(row: SidebarSessionRow, { actions, ui, t }: MenuBuildContext): MenuEntry[] {
  if (row.optimistic) return [];
  const id = row.sessionId;
  return [
    { type: "item", id: "open-new-tab", label: t("sidebar.menu.openNewTab"), icon: "external", onSelect: () => actions.openSession(id, { newTab: true }) },
    {
      type: "item",
      id: "pin",
      label: row.pinned ? t("sidebar.menu.unpin") : t("sidebar.menu.pin"),
      icon: row.pinned ? "pin-off" : "pin",
      onSelect: () => actions.pinSession(id, !row.pinned),
    },
    { type: "item", id: "rename", label: t("sessionSidebar.rename"), icon: "rename", onSelect: () => ui.beginMode(row.key, "rename") },
    { type: "item", id: "copy-transcript", label: t("sessionSidebar.copyTranscript"), icon: "copy", onSelect: () => actions.copyTranscript(id) },
    { type: "item", id: "copy-id", label: t("sidebar.menu.copyId"), icon: "id", onSelect: () => actions.copySessionId(id) },
    { type: "separator", id: "separator" },
    {
      type: "item",
      id: "archive",
      label: t("sessionSidebar.archive"),
      icon: "archive",
      disabled: row.hasChildren,
      hint: row.hasChildren ? t("sessionSidebar.archiveLeafOnly") : undefined,
      onSelect: () => actions.archiveSession(id),
    },
    { type: "item", id: "delete", label: t("sessionSidebar.delete"), icon: "trash", danger: true, onSelect: () => ui.beginMode(row.key, "confirm") },
  ];
}

export function groupMenuEntries(row: SidebarGroupRow, { actions, ui, t }: MenuBuildContext): MenuEntry[] {
  const key = row.projectKey;
  const entries: MenuEntry[] = [
    { type: "item", id: "new-session", label: t("sidebar.newSessionHere"), icon: "plus", onSelect: () => actions.newSessionInWorkspace(key, row.path) },
    { type: "item", id: "alias", label: row.alias ? t("projects.editAlias") : t("projects.nameAlias"), icon: "rename", onSelect: () => ui.beginMode(row.key, "rename") },
    {
      type: "item",
      id: "launch-config",
      label: row.hasLaunchConfig ? t("sessionSidebar.editLaunchConfig") : t("sessionSidebar.configureLaunchConfig"),
      icon: "launch",
      onSelect: () => actions.editLaunchConfig(key),
    },
    {
      type: "item",
      id: "pin",
      label: row.pinned ? t("sidebar.menu.unpinWorkspace") : t("sidebar.menu.pinWorkspace"),
      icon: row.pinned ? "pin-off" : "pin",
      onSelect: () => actions.pinWorkspace(key, !row.pinned),
    },
  ];
  if (row.canMoveUp || row.canMoveDown) {
    entries.push(
      { type: "item", id: "move-up", label: t("projects.moveUp"), icon: "up", disabled: !row.canMoveUp, onSelect: () => actions.moveWorkspace(key, -1) },
      { type: "item", id: "move-down", label: t("projects.moveDown"), icon: "down", disabled: !row.canMoveDown, onSelect: () => actions.moveWorkspace(key, 1) },
    );
  }
  entries.push(
    { type: "separator", id: "separator" },
    { type: "item", id: "remove", label: t("sidebar.menu.removeWorkspace"), icon: "trash", danger: true, onSelect: () => ui.beginMode(row.key, "confirm") },
  );
  return entries;
}

export function sortMenuEntries(sortMode: ProjectSortMode, { actions, t }: Pick<MenuBuildContext, "actions" | "t">): MenuEntry[] {
  return SORT_MODES.map(({ mode, labelKey }) => ({
    type: "item",
    id: `sort-${mode}`,
    label: t(labelKey),
    role: "menuitemradio",
    checked: sortMode === mode,
    onSelect: () => actions.setSortMode(mode),
  }));
}

export function filterMenuEntries(runningOnly: boolean, recentRunsLimit: number, { actions, t }: Pick<MenuBuildContext, "actions" | "t">): MenuEntry[] {
  const limits = RECENT_RUNS_PRESETS.includes(recentRunsLimit)
    ? RECENT_RUNS_PRESETS
    : [...RECENT_RUNS_PRESETS, recentRunsLimit].sort((a, b) => a - b);
  return [
    {
      type: "item",
      id: "running-only",
      label: t("sessionSidebar.filterRunning"),
      role: "menuitemcheckbox",
      checked: runningOnly,
      onSelect: () => actions.setRunningOnly(!runningOnly),
    },
    { type: "separator", id: "separator" },
    { type: "label", id: "recent-runs", label: t("sidebar.menu.recentRuns") },
    ...limits.map((limit): MenuEntry => ({
      type: "item",
      id: `limit-${limit}`,
      label: String(limit),
      role: "menuitemradio",
      checked: recentRunsLimit === limit,
      onSelect: () => actions.setRecentRunsLimit(limit),
    })),
  ];
}

export function overflowMenuEntries(
  state: { readonly sortMode: ProjectSortMode; readonly runningOnly: boolean },
  { actions, t }: Pick<MenuBuildContext, "actions" | "t">,
): MenuEntry[] {
  return [
    { type: "item", id: "archive-browser", label: t("sessionSidebar.archiveBrowser"), icon: "archive", onSelect: () => actions.openArchive() },
    { type: "item", id: "import", label: t("sessionSidebar.import"), icon: "import", onSelect: () => actions.importSession() },
    { type: "item", id: "refresh", label: t("sessionSidebar.refresh"), icon: "refresh", onSelect: () => actions.refresh() },
    { type: "separator", id: "separator" },
    { type: "label", id: "sort", label: t("projects.sort") },
    ...sortMenuEntries(state.sortMode, { actions, t }),
    { type: "separator", id: "separator-filter" },
    {
      type: "item",
      id: "running-only",
      label: t("sessionSidebar.filterRunning"),
      role: "menuitemcheckbox",
      checked: state.runningOnly,
      onSelect: () => actions.setRunningOnly(!state.runningOnly),
    },
  ];
}
