/**
 * Sent user messages render as a short preview until the reader expands them,
 * so one long prompt does not push the rest of the conversation off screen.
 */
export const USER_MESSAGE_PREVIEW_LINES = 3;

/** Lines that carry text; blank separators are margins, not rendered lines. */
export function countContentLines(content: string): number {
  let count = 0;
  for (const line of content.split(/\r\n|\r|\n/)) {
    if (line.trim() !== "") count += 1;
  }
  return count;
}

/**
 * How many source lines the collapsed preview hides. Zero for a message that
 * fits the preview by line count; a single long paragraph can still overflow
 * once wrapped, so callers decide whether to collapse from measured overflow
 * and use this only to word the toggle.
 */
export function hiddenPreviewLines(content: string, previewLines: number = USER_MESSAGE_PREVIEW_LINES): number {
  return Math.max(0, countContentLines(content) - previewLines);
}

/**
 * CSS max-height holding `lines` rendered lines of the user bubble: the line
 * box is font size times the line-height ratio, plus the bubble's vertical
 * padding (8px top and bottom).
 */
export function userMessagePreviewMaxHeight(lines: number = USER_MESSAGE_PREVIEW_LINES): string {
  return `calc(${lines} * var(--chat-user-font-size) * var(--chat-line-height) + 16px)`;
}
