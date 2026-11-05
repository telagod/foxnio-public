"use client";

import type { KeyboardEvent, Ref } from "react";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  ExternalLink,
  FileUp,
  Fingerprint,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import type { MenuEntry, MenuIcon } from "./menu-items";

const ICONS: Record<MenuIcon, LucideIcon> = {
  external: ExternalLink,
  pin: Pin,
  "pin-off": PinOff,
  rename: Pencil,
  copy: Copy,
  id: Fingerprint,
  archive: Archive,
  trash: Trash2,
  plus: Plus,
  launch: Settings2,
  up: ArrowUp,
  down: ArrowDown,
  import: FileUp,
  refresh: RefreshCw,
};

const ENABLED_ITEMS = "button:not(:disabled)";

/** The item a menu opens on: the checked radio/checkbox, else the first enabled item. */
export function firstMenuItem(menu: HTMLElement | null): HTMLElement | null {
  return menu?.querySelector<HTMLElement>('button[aria-checked="true"]:not(:disabled)') ?? menu?.querySelector<HTMLElement>(ENABLED_ITEMS) ?? null;
}

function moveMenuFocus(event: KeyboardEvent<HTMLElement>): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Home" && event.key !== "End") return;
  event.preventDefault();
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(ENABLED_ITEMS));
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  else if (event.key === "ArrowDown") next = (current + 1) % items.length;
  else next = (current - 1 + items.length) % items.length;
  items[next].focus();
}

export type MenuItemEntry = Extract<MenuEntry, { type: "item" }>;

/**
 * The items of a menu, shared by the pointer popover and the touch bottom
 * sheet. Items are `button`s with the matching `menuitem*` role; arrow keys,
 * Home and End move focus; `onPick` runs the entry and closes the menu.
 */
export function MenuList({ entries, label, onPick, ref }: {
  entries: readonly MenuEntry[];
  label: string;
  onPick: (entry: MenuItemEntry) => void;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div ref={ref} role="menu" aria-label={label} className="sb-menu" onKeyDown={moveMenuFocus}>
      {entries.map((entry) => {
        if (entry.type === "separator") return <div key={entry.id} role="separator" className="sb-menu-separator" />;
        if (entry.type === "label") return <div key={entry.id} role="presentation" className="sb-menu-label">{entry.label}</div>;
        const Icon = entry.icon ? ICONS[entry.icon] : null;
        const role = entry.role ?? "menuitem";
        return (
          <button
            key={entry.id}
            type="button"
            role={role}
            aria-checked={role === "menuitem" ? undefined : Boolean(entry.checked)}
            className="sb-menu-item"
            data-danger={entry.danger}
            tabIndex={-1}
            disabled={entry.disabled}
            title={entry.hint}
            onClick={() => onPick(entry)}
          >
            <span className="sb-menu-icon" aria-hidden="true">
              {role === "menuitem" ? Icon && <Icon size={14} strokeWidth={1.9} /> : entry.checked && <Check size={13} strokeWidth={2.2} />}
            </span>
            <span className="sb-menu-text">{entry.label}</span>
          </button>
        );
      })}
    </div>
  );
}
