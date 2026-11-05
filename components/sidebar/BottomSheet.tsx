"use client";

import { useCallback, useRef } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { firstMenuItem, MenuList, type MenuItemEntry } from "./MenuList";
import type { MenuEntry } from "./menu-items";
import { useRestoreFocus } from "./useRestoreFocus";

/**
 * Touch menu: a sheet that slides up from the bottom edge with a backdrop,
 * 48 px items and the safe-area inset as bottom padding. base-ui provides the
 * portal, the focus trap, Escape and backdrop dismissal; focus returns to the
 * opener through `useRestoreFocus` so an item that starts inline editing keeps
 * the focus it asked for.
 */
export function BottomSheet({ entries, label, returnFocus, onClose }: {
  entries: readonly MenuEntry[];
  label: string;
  returnFocus: HTMLElement | null;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  useRestoreFocus(returnFocus);

  const pick = useCallback((entry: MenuItemEntry) => {
    entry.onSelect();
    onClose();
  }, [onClose]);

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="sb-sheet-backdrop" />
        <Dialog.Popup
          className="sb-sheet"
          aria-label={label}
          initialFocus={() => firstMenuItem(menuRef.current)}
          finalFocus={false}
        >
          <div className="sb-sheet-handle" aria-hidden="true" />
          <MenuList ref={menuRef} entries={entries} label={label} onPick={pick} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
