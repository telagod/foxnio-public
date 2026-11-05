"use client";

import { useEffect, useMemo } from "react";
import { useI18n } from "@/lib/i18n";
import type { SidebarRow } from "@/lib/sidebar-types";
import { BottomSheet } from "./BottomSheet";
import { filterMenuEntries, groupMenuEntries, overflowMenuEntries, sessionMenuEntries, sortMenuEntries, type MenuEntry } from "./menu-items";
import { PopoverMenu } from "./PopoverMenu";
import type { OpenMenu, RowUi, SidebarActions, WorkspaceToolbarState } from "./types";

/**
 * Renders the open menu: a popover for pointer devices, a bottom sheet on
 * touch. Entries are built when the menu opens from the live row, so a row
 * that disappears (filtered out, deleted elsewhere) closes its menu.
 */
export function SidebarMenuHost({ menu, rows, rowIndexByKey, actions, ui, filters, touch, onClose }: {
  menu: OpenMenu | null;
  rows: readonly SidebarRow[];
  rowIndexByKey: ReadonlyMap<string, number>;
  actions: SidebarActions;
  ui: RowUi;
  filters: Pick<WorkspaceToolbarState, "sortMode" | "runningOnly" | "recentRunsLimit">;
  touch: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { sortMode, runningOnly, recentRunsLimit } = filters;

  const built = useMemo((): { entries: MenuEntry[]; label: string } | null => {
    if (!menu) return null;
    const context = { actions, ui, t };
    const { target } = menu;
    if (target.type === "sort") return { entries: sortMenuEntries(sortMode, context), label: t("projects.sort") };
    if (target.type === "filter") return { entries: filterMenuEntries(runningOnly, recentRunsLimit, context), label: t("sessionSidebar.filterRunning") };
    if (target.type === "overflow") return { entries: overflowMenuEntries({ sortMode, runningOnly }, context), label: t("sidebar.menu.more") };
    const row = rows[rowIndexByKey.get(target.rowKey) ?? -1];
    if (row?.kind === "session") return { entries: sessionMenuEntries(row, context), label: row.title };
    if (row?.kind === "group") return { entries: groupMenuEntries(row, context), label: row.label };
    return null;
  }, [menu, rows, rowIndexByKey, actions, ui, t, sortMode, runningOnly, recentRunsLimit]);

  const empty = menu !== null && (built === null || built.entries.length === 0);
  useEffect(() => {
    if (empty) onClose();
  }, [empty, onClose]);

  if (!menu || !built || empty) return null;
  return touch
    ? <BottomSheet entries={built.entries} label={built.label} returnFocus={menu.returnFocus} onClose={onClose} />
    : <PopoverMenu anchor={menu.anchor} entries={built.entries} label={built.label} returnFocus={menu.returnFocus} onClose={onClose} />;
}
