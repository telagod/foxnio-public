"use client";

import { useEffect } from "react";

/**
 * Returns focus to `target` when the calling component unmounts, unless
 * something else took it meanwhile (for example the rename input a menu item
 * opened): only a focus that fell back to the page body is restored.
 */
export function useRestoreFocus(target: HTMLElement | null): void {
  useEffect(() => () => {
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if ((active === null || active === document.body) && target?.isConnected) target.focus({ preventScroll: true });
    });
  }, [target]);
}
