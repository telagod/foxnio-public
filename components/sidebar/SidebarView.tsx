"use client";

import { useEffect, useMemo, type ReactNode, type Ref } from "react";
import { useI18n } from "@/lib/i18n";
import type { ProjectSortMode } from "@/lib/project-ordering";
import type { SidebarDensity, SidebarRow } from "@/lib/sidebar-types";
import { SidebarFooter } from "./SidebarFooter";
import { FoxCard } from "./FoxCard";
import { SidebarHeader } from "./SidebarHeader";
import { SidebarList, type SidebarListHandle } from "./SidebarList";
import { SidebarMenuHost } from "./SidebarMenuHost";
import { SidebarSearchBox } from "./SidebarSearchBox";
import type { SidebarActions, SidebarNavigation, WorkspaceToolbarState } from "./types";
import { useSidebarInteractions } from "./useSidebarInteractions";

export interface SidebarViewProps {
  readonly rows: readonly SidebarRow[];
  readonly density: SidebarDensity;
  /** One stable object implementing every sidebar action. */
  readonly actions: SidebarActions;
  /** Row of the open session (`SidebarModel.sessionRowIndex`), or null. */
  readonly selectedRowIndex: number | null;
  /** Drawer layout: no back/forward in the header, touch interaction. */
  readonly mobile?: boolean;

  readonly search: { readonly query: string; readonly searching: boolean };
  /** Receives the search field, so the container can focus it on `/`. */
  readonly searchInputRef?: Ref<HTMLInputElement>;
  /** Handle of the list, for focusing a row from outside. */
  readonly listRef?: Ref<SidebarListHandle>;
  readonly filters: { readonly sortMode: ProjectSortMode; readonly runningOnly: boolean; readonly recentRunsLimit: number };

  readonly navigation?: SidebarNavigation;
  /** Collapse (desktop) or close (drawer) control in the header. */
  readonly onClose?: () => void;

  /** FOX workspace is the active main view. */
  readonly foxOpen?: boolean;
  /** Opens the FOX workspace; the card lives above the workspace tree. */
  readonly onOpenFox?: () => void;

  readonly archivedCount?: number;
  /** Rendered between the archive row and settings, e.g. `<ProviderUsageBar />`. */
  readonly usage?: ReactNode;
  readonly settingsOpen?: boolean;
  readonly updateAvailable?: boolean;
  readonly onOpenSettings: () => void;
}

/**
 * The whole sidebar for one set of props: header, primary action, search,
 * virtualized list and footer. It reads nothing from stores or the network;
 * the container derives every prop from the model and implements `actions`.
 */
export function SidebarView({
  rows,
  density,
  actions,
  selectedRowIndex,
  mobile = false,
  search,
  searchInputRef,
  listRef,
  filters,
  navigation,
  onClose,
  foxOpen = false,
  onOpenFox,
  archivedCount,
  usage,
  settingsOpen = false,
  updateAvailable = false,
  onOpenSettings,
}: SidebarViewProps) {
  const { t, tn } = useI18n();
  const { menu, editing, ui, closeMenu } = useSidebarInteractions();
  const touch = mobile || density === "touch";

  const rowIndexByKey = useMemo(() => {
    const index = new Map<string, number>();
    rows.forEach((row, position) => index.set(row.key, position));
    return index;
  }, [rows]);

  // A row that vanished (filtered out, deleted elsewhere) cannot stay in edit mode.
  const editingGone = editing !== null && !rowIndexByKey.has(editing.rowKey);
  useEffect(() => {
    if (editingGone) ui.endMode();
  }, [editingGone, ui]);

  const openToolbarMenu = menu && menu.target.type !== "row" ? menu.target.type : null;
  const { sortMode, runningOnly, recentRunsLimit } = filters;
  const toolbar = useMemo<WorkspaceToolbarState>(
    () => ({ sortMode, runningOnly, recentRunsLimit, openMenu: openToolbarMenu }),
    [sortMode, runningOnly, recentRunsLimit, openToolbarMenu],
  );

  const querying = search.query.trim() !== "";
  const resultCount = useMemo(() => (querying ? rows.filter((row) => row.kind === "session").length : 0), [querying, rows]);
  let statusMessage: string | undefined;
  if (querying) statusMessage = search.searching ? t("sidebar.searching") : tn("sidebar.resultCount", resultCount);

  return (
    <nav className="sb-root" aria-label={t("sidebar.label")} data-density={density} data-mobile={mobile}>
      <SidebarHeader
        navigation={mobile ? undefined : navigation}
        onClose={onClose}
        overflowOpen={openToolbarMenu === "overflow"}
        onOpenOverflow={(anchor) => ui.openToolbarMenu("overflow", anchor)}
      />
      {onOpenFox && <FoxCard active={foxOpen} onOpen={onOpenFox} />}
      <SidebarSearchBox
        value={search.query}
        searching={search.searching}
        shortcutHint={touch ? undefined : "/"}
        inputRef={searchInputRef}
        onChange={(query) => actions.changeSearch(query)}
        onStop={() => actions.stopSearch()}
      />
      <SidebarList
        ref={listRef}
        rows={rows}
        rowIndexByKey={rowIndexByKey}
        density={density}
        actions={actions}
        ui={ui}
        selectedRowIndex={selectedRowIndex}
        editing={editing}
        menuRowKey={menu?.target.type === "row" ? menu.target.rowKey : null}
        toolbar={toolbar}
        label={t("sidebar.label")}
        statusMessage={statusMessage}
        touch={touch}
      />
      <SidebarFooter
        archivedCount={archivedCount}
        usage={usage}
        settingsOpen={settingsOpen}
        updateAvailable={updateAvailable}
        onOpenArchive={() => actions.openArchive()}
        onOpenSettings={onOpenSettings}
      />
      <SidebarMenuHost
        menu={menu}
        rows={rows}
        rowIndexByKey={rowIndexByKey}
        actions={actions}
        ui={ui}
        filters={filters}
        touch={touch}
        onClose={closeMenu}
      />
    </nav>
  );
}
