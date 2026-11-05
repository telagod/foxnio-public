/** Fields of a keydown event the `/` shortcut looks at. */
export interface SlashKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly isComposing?: boolean;
  readonly defaultPrevented: boolean;
  readonly target: unknown;
}

interface MaybeElement {
  readonly tagName?: unknown;
  readonly isContentEditable?: unknown;
}

/** Text entry or a native control that uses `/` itself. */
export function isEditableTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const element = target as MaybeElement;
  if (element.isContentEditable === true) return true;
  return typeof element.tagName === "string" && /^(INPUT|TEXTAREA|SELECT)$/i.test(element.tagName);
}

/** `/` focuses the search box, unless the user is typing somewhere or the key belongs to a shortcut. */
export function shouldFocusSearch(event: SlashKeyEvent): boolean {
  return event.key === "/"
    && !event.ctrlKey && !event.metaKey && !event.altKey
    && !event.isComposing
    && !event.defaultPrevented
    && !isEditableTarget(event.target);
}
