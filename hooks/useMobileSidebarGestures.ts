"use client";

import { useEffect, useRef } from "react";
import {
  classifyMove,
  dragFraction,
  isTap,
  openingVelocity,
  pointerVelocity,
  shouldBeOpen,
  type DrawerGestureMode,
  type DrawerSide,
  type PointerSample,
} from "@/lib/drawer-gesture";

/**
 * DOM contract shared with AppShell and globals.css.
 * - `[data-drawer-edge]` strips sit on the screen edge while a drawer is closed
 *   (`left`, `right`) or over the open file panel (`right-close`). They carry
 *   `touch-action: pan-y`, which is what keeps the browser from turning a
 *   horizontal drag into a pan (and a `pointercancel`) before we can follow it.
 * - `[data-drawer-backdrop="left"]` dims the page behind the left drawer.
 * - A drawer follows the finger through the `--drawer-progress` custom property
 *   (0 closed, 1 open) and `data-dragging`, which switches its transition off.
 */
export const LEFT_DRAWER_ID = "workspace-sidebar";
export const RIGHT_DRAWER_ID = "workspace-file-panel";
const PROGRESS_PROPERTY = "--drawer-progress";
/** Longest wait for a settling animation before the inline progress is dropped. */
const SETTLE_FALLBACK_MS = 450;

type Options = {
  enabled: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
  onLeftOpenChange: (open: boolean) => void;
  onRightOpenChange: (open: boolean) => void;
  /** Called when a right-panel pull is claimed, so a not yet mounted panel can mount while the finger moves. */
  onRightPrepare?: () => void;
};

type Drag = {
  pointerId: number;
  side: DrawerSide;
  mode: DrawerGestureMode;
  startX: number;
  startY: number;
  startTime: number;
  target: Element;
  strip: HTMLElement | null;
  claimed: boolean;
  startOpen: boolean;
  width: number;
  samples: PointerSample[];
  latestX: number;
  fraction: number;
};

const BLOCKING_OVERLAYS = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], dialog[open], [data-top-panel], [data-branch-panel]';
const GESTURE_IGNORED_TARGETS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), .shell-topbar-overflow[open], [data-top-panel], [data-swipe-dismiss]';

function drawerElement(side: DrawerSide): HTMLElement | null {
  return document.getElementById(side === "left" ? LEFT_DRAWER_ID : RIGHT_DRAWER_ID);
}

function backdropElement(side: DrawerSide): HTMLElement | null {
  return side === "left" ? document.querySelector<HTMLElement>('[data-drawer-backdrop="left"]') : null;
}

/** A visible modal, menu or sheet other than the drawer being dragged. */
export function hasBlockingOverlay(ownerId: string | null): boolean {
  const owner = ownerId ? document.getElementById(ownerId) : null;
  for (const overlay of document.querySelectorAll<HTMLElement>(BLOCKING_OVERLAYS)) {
    // A toast is a non-modal role="dialog"; it must not freeze drawer swipes while shown.
    if (overlay.id === ownerId || overlay.closest('[inert], [hidden], [aria-hidden="true"], [data-swipe-dismiss]')) continue;
    if (overlay.getAttribute("role") === "listbox" && owner?.contains(overlay)) continue;
    const style = getComputedStyle(overlay);
    if (style.display !== "none" && style.visibility !== "hidden") return true;
  }
  return false;
}

function inHorizontalScroller(target: Element, boundary: Element | null): boolean {
  for (let element: Element | null = target; element && element !== boundary?.parentElement; element = element.parentElement) {
    if (element.scrollWidth <= element.clientWidth + 1) continue;
    const overflow = getComputedStyle(element).overflowX;
    if (overflow === "auto" || overflow === "scroll") return true;
  }
  return false;
}

/** Re-targets a tap that landed on an edge strip to whatever sits underneath it. */
function forwardTap(strip: HTMLElement, x: number, y: number) {
  strip.style.pointerEvents = "none";
  const under = document.elementFromPoint(x, y);
  strip.style.pointerEvents = "";
  if (!(under instanceof HTMLElement) || under.closest("[data-drawer-edge]")) return;
  under.focus({ preventScroll: true });
  under.click();
}

/**
 * Left and right drawer gestures for phones: a drag from the screen edge pulls a
 * drawer in under the finger, and a drag on an open drawer (or the dimmed page
 * behind it) pushes it out. Release snaps by position or velocity.
 */
export function useMobileSidebarGestures(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const { enabled } = options;

  useEffect(() => {
    if (!enabled) return;
    let drag: Drag | null = null;
    let frame = 0;
    const settling = new Map<DrawerSide, { timer: number; element: HTMLElement | null; cleanup: () => void }>();

    const elementsFor = (side: DrawerSide) => [drawerElement(side), backdropElement(side)].filter((el): el is HTMLElement => el !== null);

    const paint = (current: Drag) => {
      frame = 0;
      for (const element of elementsFor(current.side)) {
        element.setAttribute("data-dragging", "");
        element.style.setProperty(PROGRESS_PROPERTY, String(current.fraction));
      }
    };

    const update = (current: Drag) => {
      const drawer = drawerElement(current.side);
      if (drawer) current.width = drawer.getBoundingClientRect().width || current.width;
      current.fraction = dragFraction(current.startOpen, current.latestX - current.startX, current.width, current.side);
    };

    const cancelSettling = (side: DrawerSide) => {
      const pending = settling.get(side);
      if (!pending) return;
      window.clearTimeout(pending.timer);
      pending.element?.removeEventListener("transitionend", pending.cleanup);
      settling.delete(side);
    };

    const clearDragStyles = (side: DrawerSide) => {
      for (const element of elementsFor(side)) {
        element.removeAttribute("data-dragging");
        element.style.removeProperty(PROGRESS_PROPERTY);
      }
    };

    const finishSettling = (side: DrawerSide) => {
      if (!settling.has(side)) return;
      cancelSettling(side);
      clearDragStyles(side);
    };

    // Keeps the released position on the element while the transition runs, and
    // hands control back to the CSS state classes once it finishes.
    const settle = (side: DrawerSide, open: boolean) => {
      cancelSettling(side);
      const drawer = drawerElement(side);
      for (const element of elementsFor(side)) {
        element.removeAttribute("data-dragging");
        element.style.setProperty(PROGRESS_PROPERTY, open ? "1" : "0");
      }
      const cleanup = () => finishSettling(side);
      const timer = window.setTimeout(cleanup, SETTLE_FALLBACK_MS);
      drawer?.addEventListener("transitionend", cleanup, { once: true });
      settling.set(side, { timer, element: drawer, cleanup });
    };

    const detach = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      drag = null;
    };

    const release = (current: Drag, speed: number) => {
      const open = shouldBeOpen(current.startOpen, current.fraction, openingVelocity(speed, current.side));
      settle(current.side, open);
      if (open === current.startOpen) return;
      const { onLeftOpenChange, onRightOpenChange } = latest.current;
      (current.side === "left" ? onLeftOpenChange : onRightOpenChange)(open);
    };

    function onMove(event: PointerEvent) {
      const current = drag;
      if (!current || event.pointerId !== current.pointerId) return;
      current.latestX = event.clientX;
      current.samples.push({ t: event.timeStamp, x: event.clientX });
      if (current.samples.length > 12) current.samples.shift();
      if (!current.claimed) {
        const verdict = classifyMove(event.clientX - current.startX, event.clientY - current.startY, current.side, current.mode);
        if (verdict === "pending") return;
        const owner = current.mode === "close" ? (current.side === "left" ? LEFT_DRAWER_ID : RIGHT_DRAWER_ID) : null;
        if (verdict === "reject"
          || window.getSelection()?.isCollapsed === false
          || (current.mode === "close" && inHorizontalScroller(current.target, drawerElement(current.side)))
          || hasBlockingOverlay(owner)) {
          detach();
          return;
        }
        current.claimed = true;
        // Catching a drawer mid-settle: keep its inline position, only stop the pending cleanup.
        cancelSettling(current.side);
        if (current.side === "right") latest.current.onRightPrepare?.();
        update(current);
        paint(current);
        return;
      }
      update(current);
      if (!frame) frame = window.requestAnimationFrame(() => paint(current));
    }

    function onUp(event: PointerEvent) {
      const current = drag;
      if (!current || event.pointerId !== current.pointerId) return;
      detach();
      if (!current.claimed) {
        if (current.strip && isTap(event.clientX - current.startX, event.clientY - current.startY, event.timeStamp - current.startTime)) {
          forwardTap(current.strip, event.clientX, event.clientY);
        }
        return;
      }
      current.latestX = event.clientX;
      update(current);
      paint(current);
      release(current, pointerVelocity(current.samples));
    }

    function onCancel(event: PointerEvent) {
      const current = drag;
      if (!current || event.pointerId !== current.pointerId) return;
      detach();
      if (current.claimed) release(current, 0);
    }

    const onDown = (event: PointerEvent) => {
      if (drag) detach();
      if ((event.pointerType !== "touch" && event.pointerType !== "pen") || !event.isPrimary || !(event.target instanceof Element)) return;
      const { leftOpen, rightOpen } = latest.current;
      const target = event.target;
      const strip = target.closest<HTMLElement>("[data-drawer-edge]");
      let side: DrawerSide;
      let mode: DrawerGestureMode;
      if (strip) {
        const kind = strip.getAttribute("data-drawer-edge");
        side = kind === "left" ? "left" : "right";
        mode = kind === "right-close" ? "close" : "open";
      } else if (rightOpen) {
        if (!target.closest(`#${RIGHT_DRAWER_ID}`)) return;
        side = "right";
        mode = "close";
      } else if (leftOpen) {
        if (!target.closest(`#${LEFT_DRAWER_ID}, [data-drawer-backdrop="left"]`)) return;
        side = "left";
        mode = "close";
      } else {
        return;
      }
      if (mode === "close" && target.closest(GESTURE_IGNORED_TARGETS)) return;
      if (window.getSelection()?.isCollapsed === false) return;
      const owner = mode === "close" ? (side === "left" ? LEFT_DRAWER_ID : RIGHT_DRAWER_ID) : (rightOpen ? RIGHT_DRAWER_ID : leftOpen ? LEFT_DRAWER_ID : null);
      if (hasBlockingOverlay(owner)) return;
      const drawer = drawerElement(side);
      drag = {
        pointerId: event.pointerId,
        side,
        mode,
        startX: event.clientX,
        startY: event.clientY,
        startTime: event.timeStamp,
        target,
        strip,
        claimed: false,
        startOpen: mode === "close",
        width: drawer?.getBoundingClientRect().width || window.innerWidth,
        samples: [{ t: event.timeStamp, x: event.clientX }],
        latestX: event.clientX,
        fraction: mode === "close" ? 1 : 0,
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    };

    window.addEventListener("pointerdown", onDown, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      const current = drag;
      detach();
      if (current?.claimed) clearDragStyles(current.side);
      for (const side of [...settling.keys()]) finishSettling(side);
    };
  }, [enabled]);
}
