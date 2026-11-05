import type { SidebarRow } from "@/lib/sidebar-types";

/**
 * Pure keyboard model of the sidebar tree. `resolveSidebarKey` maps a key on
 * the row at `index` to an intent; the list performs it (moving focus,
 * scrolling the target into the mounted window first, calling actions).
 */

export interface SidebarKeyInput {
  readonly key: string;
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
}

export type SidebarKeyIntent =
  | { readonly type: "focus"; readonly index: number }
  | { readonly type: "expand"; readonly index: number }
  | { readonly type: "collapse"; readonly index: number }
  | { readonly type: "activate"; readonly index: number; readonly newTab: boolean }
  | { readonly type: "rename"; readonly index: number }
  | { readonly type: "delete"; readonly index: number }
  | { readonly type: "pin"; readonly index: number }
  | { readonly type: "menu"; readonly index: number };

/** Placeholders (loading, errors, empty states) are skipped by arrow navigation. */
export function isNavigableRow(row: SidebarRow): boolean {
  return row.kind !== "placeholder";
}

function firstNavigable(rows: readonly SidebarRow[], from: number, step: 1 | -1): number {
  for (let index = from; index >= 0 && index < rows.length; index += step) {
    if (isNavigableRow(rows[index])) return index;
  }
  return -1;
}

/** First navigable row index, or -1. */
export function firstNavigableIndex(rows: readonly SidebarRow[]): number {
  return firstNavigable(rows, 0, 1);
}

/** Last navigable row index, or -1. */
export function lastNavigableIndex(rows: readonly SidebarRow[]): number {
  return firstNavigable(rows, rows.length - 1, -1);
}

/** Level-1 rows are the roots of the tree: section headers, workspace groups and flat search results. */
function isRoot(row: SidebarRow): boolean {
  return row.kind === "section" || row.kind === "group" || (row.kind === "session" && row.context === "search");
}

/** Index of the row that owns `rows[index]` (its group, section or fork parent), or -1 for roots. */
export function parentRowIndex(rows: readonly SidebarRow[], index: number): number {
  const row = rows[index];
  if (!row || isRoot(row) || row.kind === "placeholder") return -1;
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    const candidate = rows[cursor];
    if (row.kind === "session" && row.depth > 0 && candidate.kind === "session" && candidate.depth === row.depth - 1 && candidate.context === row.context) return cursor;
    if (candidate.kind === "section" || candidate.kind === "group") return cursor;
  }
  return -1;
}

function hasChildRows(rows: readonly SidebarRow[], index: number): boolean {
  const row = rows[index];
  const next = rows[index + 1];
  if (!row || !next) return false;
  if (row.kind === "group" || row.kind === "section") return next.kind !== "section" && next.kind !== "group" && !(next.kind === "session" && next.context === "search");
  if (row.kind === "session") return next.kind === "session" && next.context === row.context && next.depth > row.depth;
  return false;
}

function canOpenMenu(row: SidebarRow): boolean {
  return row.kind === "group" || (row.kind === "session" && !row.optimistic);
}

/**
 * Resolve a key pressed on the focused row. Returns null when the key has no
 * meaning there (the caller must then leave the event alone).
 * Typeahead is intentionally not supported.
 */
export function resolveSidebarKey(rows: readonly SidebarRow[], index: number, input: SidebarKeyInput): SidebarKeyIntent | null {
  const row = rows[index];
  if (!row || input.altKey) return null;
  const mod = Boolean(input.ctrlKey || input.metaKey);
  const { key } = input;

  if (key === "Enter") return { type: "activate", index, newTab: mod && row.kind === "session" };
  if (mod) return null;
  if (key === "F10") return input.shiftKey && canOpenMenu(row) ? { type: "menu", index } : null;
  if (input.shiftKey) return null;

  switch (key) {
    case "ArrowDown": {
      const next = firstNavigable(rows, index + 1, 1);
      return next < 0 ? null : { type: "focus", index: next };
    }
    case "ArrowUp": {
      const previous = firstNavigable(rows, index - 1, -1);
      return previous < 0 ? null : { type: "focus", index: previous };
    }
    case "Home": {
      const first = firstNavigableIndex(rows);
      return first < 0 || first === index ? null : { type: "focus", index: first };
    }
    case "End": {
      const last = lastNavigableIndex(rows);
      return last < 0 || last === index ? null : { type: "focus", index: last };
    }
    case "ArrowRight": {
      if (row.kind === "group" && !row.expanded) return { type: "expand", index };
      if (row.kind === "section" && row.collapsible && row.collapsed) return { type: "expand", index };
      if (row.kind === "session" && row.hasChildren && !row.expanded) return { type: "expand", index };
      if (hasChildRows(rows, index)) return { type: "focus", index: index + 1 };
      return null;
    }
    case "ArrowLeft": {
      if (row.kind === "group" && row.expanded) return { type: "collapse", index };
      if (row.kind === "section" && row.collapsible && !row.collapsed) return { type: "collapse", index };
      if (row.kind === "session" && row.hasChildren && row.expanded) return { type: "collapse", index };
      const parent = parentRowIndex(rows, index);
      return parent < 0 ? null : { type: "focus", index: parent };
    }
    case " ":
      return { type: "activate", index, newTab: false };
    case "F2":
      return canOpenMenu(row) ? { type: "rename", index } : null;
    case "Delete":
      return row.kind === "session" && !row.optimistic ? { type: "delete", index } : null;
    case "p":
    case "P":
      return canOpenMenu(row) ? { type: "pin", index } : null;
    case "ContextMenu":
      return canOpenMenu(row) ? { type: "menu", index } : null;
    default:
      return null;
  }
}

/** ARIA tree metrics of every row; rows are windowed, so these cannot be read from the DOM. */
export interface SidebarTreeMetrics {
  /** `aria-level`; 0 for placeholders, which are not tree items. */
  readonly level: Uint8Array;
  /** `aria-posinset` among siblings; 0 for placeholders. */
  readonly posInSet: Int32Array;
  /** `aria-setsize` among siblings; 0 for placeholders. */
  readonly setSize: Int32Array;
}

/**
 * Levels follow the visual tree: sections and groups are level 1, sessions are
 * `depth + 2` below their section/group (flat search results are level 1), and
 * "show more" rows sit at level 2. Siblings share a parent and a level.
 */
export function computeTreeMetrics(rows: readonly SidebarRow[]): SidebarTreeMetrics {
  const count = rows.length;
  const level = new Uint8Array(count);
  const posInSet = new Int32Array(count);
  const setSize = new Int32Array(count);
  const parentOf = new Int32Array(count);
  // childCounts[parent + 1]: slot 0 collects the roots.
  const childCounts = new Int32Array(count + 1);
  let lastRoot = -1;
  const lastAtDepth: number[] = [];

  for (let index = 0; index < count; index++) {
    const row = rows[index];
    if (row.kind === "placeholder") {
      parentOf[index] = -2;
      continue;
    }
    let parent = -1;
    if (isRoot(row)) {
      lastRoot = index;
      lastAtDepth.length = 0;
      level[index] = 1;
    } else if (row.kind === "session") {
      parent = row.depth > 0 && lastAtDepth[row.depth - 1] !== undefined ? lastAtDepth[row.depth - 1] : lastRoot;
      lastAtDepth[row.depth] = index;
      lastAtDepth.length = row.depth + 1;
      level[index] = row.depth + 2;
    } else {
      parent = lastRoot;
      level[index] = 2;
    }
    parentOf[index] = parent;
    posInSet[index] = ++childCounts[parent + 1];
  }
  for (let index = 0; index < count; index++) {
    const parent = parentOf[index];
    if (parent !== -2) setSize[index] = childCounts[parent + 1];
  }
  return { level, posInSet, setSize };
}
