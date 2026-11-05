"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { computeTreeMetrics, firstNavigableIndex, isNavigableRow, resolveSidebarKey, type SidebarKeyIntent } from "@/lib/sidebar-keyboard";
import type { SidebarDensity, SidebarRow } from "@/lib/sidebar-types";
import { GroupRow } from "./GroupRow";
import { createLongPressTracker } from "./long-press";
import { MoreRow } from "./MoreRow";
import { PlaceholderRow } from "./PlaceholderRow";
import type { RowBaseProps } from "./row-support";
import { SectionRow } from "./SectionRow";
import { SessionRow } from "./SessionRow";
import type { RowMode, RowUi, SidebarActions, WorkspaceToolbarState } from "./types";
import { VirtualList, type VirtualListHandle } from "./VirtualList";

export interface SidebarListHandle {
  /** Scroll the row into view and move keyboard focus to it. */
  focusRow(index: number): void;
  scrollToIndex(index: number): void;
}

export interface SidebarListProps {
  readonly rows: readonly SidebarRow[];
  /** Row key to index, built once per `rows`. */
  readonly rowIndexByKey: ReadonlyMap<string, number>;
  readonly density: SidebarDensity;
  readonly actions: SidebarActions;
  readonly ui: RowUi;
  /** Row of the open session; the list scrolls to it when the selection changes. */
  readonly selectedRowIndex: number | null;
  /** The row that is being renamed / confirmed, if any. */
  readonly editing: { readonly rowKey: string; readonly mode: RowMode } | null;
  /** Row whose menu is open, if any. */
  readonly menuRowKey: string | null;
  readonly toolbar: WorkspaceToolbarState;
  readonly label: string;
  readonly statusMessage?: string;
  /** Touch input: long press opens the row menu. */
  readonly touch: boolean;
  readonly ref?: Ref<SidebarListHandle>;
}

interface RowTarget {
  readonly index: number;
  readonly element: HTMLElement;
}

function rowTarget(target: EventTarget): RowTarget | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>("[data-row-index]");
  return element ? { index: Number(element.dataset.rowIndex), element } : null;
}

function isTextField(target: EventTarget): boolean {
  return target instanceof Element && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
}

/** Rows that offer a menu (right click, long press, menu key). */
function hasMenu(row: SidebarRow | undefined): boolean {
  return row?.kind === "group" || (row?.kind === "session" && !row.optimistic);
}

/**
 * The virtualized tree: renders rows, owns the roving tab stop, the keyboard
 * model and the context-menu / long-press gestures (delegated from the
 * container, so rows carry no per-row handlers).
 */
export function SidebarList({
  rows,
  rowIndexByKey,
  density,
  actions,
  ui,
  selectedRowIndex,
  editing,
  menuRowKey,
  toolbar,
  label,
  statusMessage,
  touch,
  ref,
}: SidebarListProps) {
  const listRef = useRef<VirtualListHandle | null>(null);
  const pendingFocus = useRef<number | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const metrics = useMemo(() => computeTreeMetrics(rows), [rows]);

  // Roving tab stop: the focused row, else the open session, else the first row.
  const focusedIndex = focusedKey === null ? undefined : rowIndexByKey.get(focusedKey);
  let tabbableIndex = firstNavigableIndex(rows);
  if (focusedIndex !== undefined && isNavigableRow(rows[focusedIndex])) tabbableIndex = focusedIndex;
  else if (selectedRowIndex !== null && rows[selectedRowIndex] && isNavigableRow(rows[selectedRowIndex])) tabbableIndex = selectedRowIndex;

  const editingIndex = editing ? rowIndexByKey.get(editing.rowKey) : undefined;
  const menuIndex = menuRowKey === null ? undefined : rowIndexByKey.get(menuRowKey);
  const keepMounted = [tabbableIndex, editingIndex, menuIndex].filter((index): index is number => index !== undefined && index >= 0);

  const selectedKey = selectedRowIndex === null ? undefined : rows[selectedRowIndex]?.key;
  useEffect(() => {
    if (selectedKey === undefined) return;
    const index = rowIndexByKey.get(selectedKey);
    if (index !== undefined) listRef.current?.scrollToIndex(index);
    // Only a change of the open session scrolls; index shifts caused by folding other groups must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey]);

  const focusRow = useCallback((index: number) => {
    const row = rows[index];
    if (!row) return;
    listRef.current?.scrollToIndex(index);
    const mounted = listRef.current?.getElement()?.querySelector<HTMLElement>(`[data-row-index="${index}"]`);
    if (mounted) mounted.focus({ preventScroll: true });
    else pendingFocus.current = index;
    setFocusedKey(row.key);
  }, [rows]);

  // A row that was not mounted when focus was requested exists after this render.
  useLayoutEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    pendingFocus.current = null;
    listRef.current?.getElement()?.querySelector<HTMLElement>(`[data-row-index="${index}"]`)?.focus({ preventScroll: true });
  });

  useImperativeHandle(ref, () => ({ focusRow, scrollToIndex: (index: number) => listRef.current?.scrollToIndex(index) }), [focusRow]);

  /** Fold/unfold a group, section or fork parent; "show more/less" on a more row. */
  const toggleRow = (row: SidebarRow) => {
    if (row.kind === "group") actions.toggleGroup(row.projectKey);
    else if (row.kind === "section" && row.collapsible) actions.toggleSection(row.section);
    else if (row.kind === "session") actions.toggleFork(row.sessionId);
    else if (row.kind === "more") {
      if (row.hidden > 0) actions.showMore(row.projectKey);
      else actions.showLess(row.projectKey);
    }
  };

  const perform = (intent: SidebarKeyIntent, element: HTMLElement) => {
    const row = rows[intent.index];
    switch (intent.type) {
      case "focus":
        focusRow(intent.index);
        return;
      case "rename":
        ui.beginMode(row.key, "rename");
        return;
      case "delete":
        ui.beginMode(row.key, "confirm");
        return;
      case "menu":
        ui.openRowMenu(row.key, { element });
        return;
      case "pin":
        if (row.kind === "session") actions.pinSession(row.sessionId, !row.pinned);
        else if (row.kind === "group") actions.pinWorkspace(row.projectKey, !row.pinned);
        return;
      case "activate":
        if (row.kind === "session") actions.openSession(row.sessionId, intent.newTab ? { newTab: true } : undefined);
        else toggleRow(row);
        return;
      case "expand":
      case "collapse":
        toggleRow(row);
        return;
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const found = rowTarget(event.target);
    if (!found || isTextField(event.target)) return;
    // Enter and Space on a link or button inside the row are theirs; only the row itself activates.
    if ((event.key === "Enter" || event.key === " ") && event.target !== found.element) return;
    const intent = resolveSidebarKey(rows, found.index, event);
    if (!intent) return;
    event.preventDefault();
    perform(intent, found.element);
  };

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const found = rowTarget(event.target);
    const row = found ? rows[found.index] : undefined;
    if (row && isNavigableRow(row)) setFocusedKey(row.key);
  };

  const longPress = useMemo(
    () => createLongPressTracker<RowTarget>(({ index, element }, x, y) => {
      const key = element.dataset.rowKey;
      if (key !== undefined && element.isConnected && index >= 0) ui.openRowMenu(key, { element, point: { x, y } });
    }),
    [ui],
  );
  useEffect(() => () => longPress.cancel(), [longPress]);

  // The long press opens the menu under the finger, so the click some browsers send when the finger lifts
  // lands on the sheet's backdrop (or the row) and must neither dismiss the sheet nor open the session.
  // Any later press means no such click is coming.
  useEffect(() => {
    const swallowClick = (event: Event) => {
      if (!longPress.consumeFired()) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const newPress = () => { longPress.consumeFired(); };
    window.addEventListener("click", swallowClick, true);
    window.addEventListener("pointerdown", newPress, true);
    return () => {
      window.removeEventListener("click", swallowClick, true);
      window.removeEventListener("pointerdown", newPress, true);
    };
  }, [longPress]);

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const found = rowTarget(event.target);
    const row = found ? rows[found.index] : undefined;
    if (!found || !row || isTextField(event.target) || !hasMenu(row)) return;
    event.preventDefault();
    // Android also reports a long press as a context menu; the long-press timer already opened this one.
    if (touch && menuRowKey === row.key) return;
    ui.openRowMenu(row.key, { element: found.element, point: { x: event.clientX, y: event.clientY } });
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!touch || event.pointerType === "mouse" || isTextField(event.target)) return;
    const found = rowTarget(event.target);
    if (found && hasMenu(rows[found.index])) longPress.start(event.clientX, event.clientY, found);
  };

  const renderRow = (row: SidebarRow, index: number, top: number, height: number): ReactNode => {
    const base = {
      index,
      top,
      height,
      level: metrics.level[index],
      posInSet: metrics.posInSet[index],
      setSize: metrics.setSize[index],
      tabbable: index === tabbableIndex,
      density,
      actions,
      ui,
    } satisfies Omit<RowBaseProps<SidebarRow>, "row">;
    const mode = editing?.rowKey === row.key ? editing.mode : undefined;
    const menuOpen = menuRowKey === row.key;
    switch (row.kind) {
      case "section":
        return <SectionRow {...base} row={row} toolbar={row.section === "workspaces" ? toolbar : undefined} />;
      case "group":
        return <GroupRow {...base} row={row} mode={mode} menuOpen={menuOpen} />;
      case "session":
        return <SessionRow {...base} row={row} mode={mode} menuOpen={menuOpen} />;
      case "more":
        return <MoreRow {...base} row={row} />;
      case "placeholder":
        return <PlaceholderRow {...base} row={row} />;
    }
  };

  return (
    <VirtualList
      ref={listRef}
      rows={rows}
      density={density}
      keepMounted={keepMounted}
      renderRow={renderRow}
      label={label}
      statusMessage={statusMessage}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      onPointerMove={(event) => longPress.move(event.clientX, event.clientY)}
      onPointerUp={() => longPress.cancel()}
      onPointerCancel={() => longPress.cancel()}
    />
  );
}
