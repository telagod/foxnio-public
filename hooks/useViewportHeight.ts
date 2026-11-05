"use client";

import { useEffect } from "react";

/** The keyboard counts as open when the visible height lost more than this against the unobstructed baseline. */
export const KEYBOARD_MIN_DELTA_PX = 120;
/** Delays after a focus/resize trigger at which the viewport is read again while the keyboard animates. */
export const SETTLE_DELAYS_MS = [48, 120, 240, 420, 720] as const;
export const VIEWPORT_HEIGHT_PROPERTY = "--app-viewport-height";
export const KEYBOARD_OPEN_ATTRIBUTE = "data-keyboard-open";

const NON_TEXT_INPUT_TYPES: Record<string, true> = {
  button: true,
  checkbox: true,
  color: true,
  file: true,
  image: true,
  radio: true,
  range: true,
  reset: true,
  submit: true,
};

export type ViewportReading = {
  /** Height of the viewport with no keyboard, measured while nothing editable had focus. */
  baselineHeight: number;
  /** `visualViewport.height` now. */
  visibleHeight: number;
  editableFocused: boolean;
};

/**
 * `height` is the value for `--app-viewport-height`, or null to fall back to
 * the CSS default (`100dvh`). The override only exists while the keyboard is
 * open for a focused editable element: otherwise browser chrome showing and
 * hiding would make the shell jump.
 */
export function computeViewport({ baselineHeight, visibleHeight, editableFocused }: ViewportReading): { keyboardOpen: boolean; height: number | null } {
  const keyboardOpen = editableFocused && baselineHeight - visibleHeight > KEYBOARD_MIN_DELTA_PX;
  return { keyboardOpen, height: keyboardOpen ? Math.round(visibleHeight) : null };
}

/** Text-entry elements raise the soft keyboard; buttons, checkboxes and the like do not. */
export function isTextEntry(tagName: string, inputType: string | null, contentEditable: boolean, readOnly = false): boolean {
  if (readOnly) return false;
  const tag = tagName.toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "input") return !Object.hasOwn(NON_TEXT_INPUT_TYPES, (inputType ?? "text").toLowerCase());
  return contentEditable;
}

function focusedEditable(): boolean {
  const element = document.activeElement;
  if (!(element instanceof HTMLElement)) return false;
  const readOnly = "readOnly" in element && element.readOnly === true;
  const inputType = element.tagName === "INPUT" ? (element as HTMLInputElement).type : null;
  return isTextEntry(element.tagName, inputType, element.isContentEditable === true, readOnly);
}

/**
 * Keeps the app shell above the on-screen keyboard where the browser does not
 * resize the layout viewport (iOS Safari, installed iOS PWAs): while an editable
 * element is focused and the keyboard is open, `--app-viewport-height` follows
 * `visualViewport.height` and `html[data-keyboard-open]` is set.
 */
export function useViewportHeight() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    let baselineHeight = Math.max(window.innerHeight, viewport.height + viewport.offsetTop);
    let baselineWidth = window.innerWidth;
    let applied: number | null = null;
    let keyboardOpen = false;
    let timers: number[] = [];

    const read = () => {
      const editableFocused = focusedEditable();
      // A rotation changes the unobstructed height; a keyboard that is up never raises it.
      if (window.innerWidth !== baselineWidth) {
        baselineWidth = window.innerWidth;
        baselineHeight = viewport.height + viewport.offsetTop;
      } else if (!editableFocused) {
        baselineHeight = Math.max(window.innerHeight, viewport.height + viewport.offsetTop);
      }
      const next = computeViewport({ baselineHeight, visibleHeight: viewport.height, editableFocused });
      if (next.height !== applied) {
        applied = next.height;
        if (next.height === null) root.style.removeProperty(VIEWPORT_HEIGHT_PROPERTY);
        else root.style.setProperty(VIEWPORT_HEIGHT_PROPERTY, `${next.height}px`);
      }
      if (next.keyboardOpen !== keyboardOpen) {
        keyboardOpen = next.keyboardOpen;
        root.toggleAttribute(KEYBOARD_OPEN_ATTRIBUTE, keyboardOpen);
      }
      // iOS scrolls the visual viewport to reveal the field; pin the shell back to the top.
      if (keyboardOpen && viewport.offsetTop > 0) window.scrollTo(0, 0);
    };

    const settle = () => {
      for (const timer of timers) window.clearTimeout(timer);
      read();
      timers = SETTLE_DELAYS_MS.map((delay) => window.setTimeout(read, delay));
    };

    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => { frame = 0; read(); });
    };

    viewport.addEventListener("resize", settle);
    viewport.addEventListener("scroll", onScroll);
    window.addEventListener("orientationchange", settle);
    document.addEventListener("focusin", settle);
    document.addEventListener("focusout", settle);
    return () => {
      viewport.removeEventListener("resize", settle);
      viewport.removeEventListener("scroll", onScroll);
      window.removeEventListener("orientationchange", settle);
      document.removeEventListener("focusin", settle);
      document.removeEventListener("focusout", settle);
      for (const timer of timers) window.clearTimeout(timer);
      if (frame) window.cancelAnimationFrame(frame);
      root.style.removeProperty(VIEWPORT_HEIGHT_PROPERTY);
      root.removeAttribute(KEYBOARD_OPEN_ATTRIBUTE);
    };
  }, []);
}
