/** What a plain or modified Enter keypress does in the composer textarea. */
export type ComposerEnterAction = "send" | "newline";

/**
 * Enter semantics for the composer.
 *
 * Compact composer: Enter sends on desktop, inserts a newline on the mobile
 * breakpoint (soft keyboards rarely offer Shift+Enter); Shift+Enter is always a
 * newline.
 *
 * Expanded editor: it exists for long, multi-paragraph drafts, so a bare Enter
 * (including on desktop) inserts a newline and only Ctrl/Cmd+Enter sends.
 * Sending clears the draft, which also collapses the editor.
 */
export function composerEnterAction(params: {
  expanded: boolean;
  isMobile: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): ComposerEnterAction {
  if (params.shiftKey) return "newline";
  if (params.expanded) return params.ctrlKey || params.metaKey ? "send" : "newline";
  return params.isMobile ? "newline" : "send";
}

/** Distance (px) from the bottom of the editor to the slash / @ / history menus: just above the toolbar. */
export const EXPANDED_MENU_BOTTOM_PX = 72;

/**
 * Height (px) of those menus in the expanded editor: at most 360px, and at most
 * half the viewport. The compact composer measures the room around its anchor
 * instead, but the expanded anchor spans the whole dialog, so that measurement
 * would leave no room at all.
 */
export function expandedMenuMaxHeight(viewportHeight: number): number {
  return Math.max(0, Math.min(360, Math.round(viewportHeight / 2)));
}
