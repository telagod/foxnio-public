"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { firstMenuItem, MenuList, type MenuItemEntry } from "./MenuList";
import type { MenuEntry } from "./menu-items";
import type { MenuAnchor } from "./types";
import { useRestoreFocus } from "./useRestoreFocus";

const MENU_MARGIN = 5;
const MENU_VIEWPORT_PAD = 8;
const MENU_MIN_WIDTH = 160;

interface Position {
  readonly top: number;
  readonly left: number;
}

/** Reads `--ui-scale` (interface zoom); getBoundingClientRect() is scaled by it, offsetWidth is not. */
function interfaceScale(): number {
  const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale"));
  return Number.isFinite(value) && value > 0 ? value : 1;
}

/** Menu position in unscaled CSS px: below the anchor, flipped above when there is no room, kept inside the viewport. */
function computePosition(anchor: MenuAnchor, menu: HTMLElement): Position {
  const scale = interfaceScale();
  const rect = anchor.point
    ? { top: anchor.point.y, bottom: anchor.point.y, left: anchor.point.x, right: anchor.point.x }
    : anchor.element.getBoundingClientRect();
  const top = rect.top / scale;
  const bottom = rect.bottom / scale;
  const left = rect.left / scale;
  const right = rect.right / scale;
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const viewportWidth = window.innerWidth / scale;
  const viewportHeight = window.innerHeight / scale;

  let y = bottom + MENU_MARGIN;
  if (y + height > viewportHeight - MENU_VIEWPORT_PAD) y = top - height - MENU_MARGIN;
  y = Math.max(MENU_VIEWPORT_PAD, y);
  // Buttons right-align to their edge, pointer and row anchors start at it.
  const alignEnd = anchor.element.tagName === "BUTTON" && !anchor.point;
  const x = alignEnd ? right - width : left;
  return { top: y, left: Math.max(MENU_VIEWPORT_PAD, Math.min(x, viewportWidth - width - MENU_VIEWPORT_PAD)) };
}

/**
 * Pointer-device menu rendered through a portal so it floats above the
 * virtualized list. It flips above the anchor when below does not fit, keeps
 * a viewport padding, closes on outside press, Escape, Tab, resize and on
 * scroll of anything that contains the anchor, and returns focus to the
 * element that opened it.
 */
export function PopoverMenu({ anchor, entries, label, returnFocus, onClose }: {
  anchor: MenuAnchor;
  entries: readonly MenuEntry[];
  label: string;
  returnFocus: HTMLElement | null;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<Position | null>(null);
  useRestoreFocus(returnFocus);

  // Measure before paint: the portal is mounted during commit, so the menu's own size is known here.
  useLayoutEffect(() => {
    if (menuRef.current) setPosition(computePosition(anchor, menuRef.current));
  }, [anchor]);

  const positioned = position !== null;
  useEffect(() => {
    if (positioned) firstMenuItem(menuRef.current)?.focus({ preventScroll: true });
  }, [positioned]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || menuRef.current?.contains(target)) return;
      // A button anchor toggles its own menu from its click handler.
      if (anchor.element.tagName === "BUTTON" && anchor.element.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (event.key === "Tab") {
        onClose();
      }
    };
    const onScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      if (target === document || (target instanceof Node && target.contains(anchor.element))) onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);

  const pick = useCallback((entry: MenuItemEntry) => {
    entry.onSelect();
    onClose();
  }, [onClose]);

  return createPortal(
    <div
      className="sb-popover"
      style={{
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        visibility: position ? "visible" : "hidden",
        minWidth: MENU_MIN_WIDTH,
        // Viewport units are not zoomed, so divide by the interface scale.
        maxWidth: `calc(100vw / var(--ui-scale, 1) - ${2 * MENU_VIEWPORT_PAD}px)`,
      }}
    >
      <MenuList ref={menuRef} entries={entries} label={label} onPick={pick} />
    </div>,
    document.body,
  );
}
