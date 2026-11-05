"use client";

import { useCallback, useMemo, useState } from "react";
import type { MenuAnchor, MenuTarget, OpenMenu, RowMode, RowUi } from "./types";

export interface SidebarInteractions {
  readonly menu: OpenMenu | null;
  readonly editing: { readonly rowKey: string; readonly mode: RowMode } | null;
  readonly ui: RowUi;
  readonly closeMenu: () => void;
}

function sameTarget(a: MenuTarget, b: MenuTarget): boolean {
  return a.type === b.type && (a.type !== "row" || (b.type === "row" && a.rowKey === b.rowKey));
}

/**
 * View state of the list that is not data: which menu is open and which row
 * is being renamed or confirmed. `ui` is stable, so memoized rows never
 * re-render because of it.
 */
export function useSidebarInteractions(): SidebarInteractions {
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const [editing, setEditing] = useState<SidebarInteractions["editing"]>(null);

  const open = useCallback((target: MenuTarget, anchor: MenuAnchor) => {
    setMenu((current) => {
      // A button anchor toggles its own menu; pointer and keyboard anchors always (re)open.
      if (!anchor.point && current && sameTarget(current.target, target)) return null;
      return { target, anchor, returnFocus: anchor.element };
    });
  }, []);

  const ui = useMemo<RowUi>(() => ({
    openRowMenu: (rowKey, anchor) => open({ type: "row", rowKey }, anchor),
    openToolbarMenu: (kind, anchor) => open({ type: kind }, anchor),
    beginMode: (rowKey, mode) => setEditing({ rowKey, mode }),
    endMode: () => setEditing(null),
  }), [open]);

  const closeMenu = useCallback(() => setMenu(null), []);

  return { menu, editing, ui, closeMenu };
}
