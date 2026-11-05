"use client";

import type { ComponentPropsWithRef, MouseEvent, ReactNode, Ref } from "react";
import type { SidebarDensity, SidebarRow } from "@/lib/sidebar-types";
import type { RowUi, SidebarActions } from "./types";

/** Props every tree-item row receives. All values are primitives or stable objects, so `memo` can skip rows on scroll. */
export interface RowBaseProps<R extends SidebarRow> {
  readonly row: R;
  readonly index: number;
  /** Offset from the top of the list in px. */
  readonly top: number;
  readonly height: number;
  readonly level: number;
  readonly posInSet: number;
  readonly setSize: number;
  /** True for the single roving tab stop of the list. */
  readonly tabbable: boolean;
  readonly density: SidebarDensity;
  readonly actions: SidebarActions;
  readonly ui: RowUi;
}

function shallowEqualObjects(a: object, b: object): boolean {
  if (a === b) return true;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    const x = left[key];
    const y = right[key];
    if (Object.is(x, y)) continue;
    // `counts` of group rows is the only nested plain object.
    if (typeof x === "object" && x !== null && typeof y === "object" && y !== null && !Array.isArray(x) && shallowEqualObjects(x, y)) continue;
    return false;
  }
  return true;
}

/**
 * `memo` comparator for rows: props compare by identity, the `row` object by
 * value, so a model rebuild that yields equal rows does not render them.
 */
export function rowPropsEqual<P extends { readonly row: object }>(prev: P, next: P): boolean {
  const left = prev as Record<string, unknown>;
  const right = next as Record<string, unknown>;
  for (const key of Object.keys(left)) {
    if (key === "row") {
      if (!shallowEqualObjects(prev.row, next.row)) return false;
    } else if (!Object.is(left[key], right[key])) return false;
  }
  return Object.keys(left).length === Object.keys(right).length;
}

export interface RowFrameProps extends Omit<ComponentPropsWithRef<"div">, "role" | "style" | "tabIndex" | "children"> {
  readonly kind: SidebarRow["kind"];
  /** `SidebarRow.key`, exposed as `data-row-key` for event delegation. */
  readonly rowKey: string;
  readonly index: number;
  readonly top: number;
  readonly height: number;
  readonly level: number;
  readonly posInSet: number;
  readonly setSize: number;
  readonly tabbable: boolean;
  readonly density: SidebarDensity;
  readonly selected?: boolean;
  /** Set only on rows that can expand/collapse. */
  readonly expanded?: boolean;
  readonly children: ReactNode;
}

/**
 * The absolutely positioned `treeitem` shell of a row. ARIA position values
 * are passed in because windowed rows cannot be counted from the DOM.
 */
export function RowFrame({ kind, rowKey, index, top, height, level, posInSet, setSize, tabbable, density, selected, expanded, className, children, ...rest }: RowFrameProps) {
  return (
    <div
      {...rest}
      role="treeitem"
      className={className ? `sb-row sb-row--${kind} ${className}` : `sb-row sb-row--${kind}`}
      tabIndex={tabbable ? 0 : -1}
      data-row-index={index}
      data-row-key={rowKey}
      data-density={density}
      aria-level={level}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      aria-selected={selected}
      aria-expanded={expanded}
      style={{ height, transform: `translateY(${top}px)` }}
    >
      {children}
    </div>
  );
}

export interface IconButtonProps {
  readonly ref?: Ref<HTMLButtonElement>;
  readonly label: string;
  readonly title?: string;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  /** Makes the button a menu trigger (`aria-haspopup`, `aria-expanded`). */
  readonly expanded?: boolean;
  /** Toggle state (`aria-pressed`) for non-menu buttons. */
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  /** False inside tree rows: the row is the tab stop, buttons are reached by pointer or shortcut. */
  readonly tabbable?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}

/** Quiet square icon button; hit area grows to 44 px on touch through CSS. */
export function IconButton({ ref, label, title, onClick, expanded, pressed, disabled, tabbable = true, className, children }: IconButtonProps) {
  return (
    <button
      ref={ref}
      type="button"
      className={className ? `sb-icon-btn ${className}` : "sb-icon-btn"}
      aria-label={label}
      title={title ?? label}
      onClick={onClick}
      disabled={disabled}
      tabIndex={tabbable ? undefined : -1}
      {...(expanded === undefined ? { "aria-pressed": pressed } : { "aria-haspopup": "menu" as const, "aria-expanded": expanded })}
    >
      {children}
    </button>
  );
}

export type FrameLayout = Pick<RowFrameProps, "rowKey" | "index" | "top" | "height" | "level" | "posInSet" | "setSize" | "tabbable" | "density">;

/** The layout props a row forwards to its `RowFrame` (leaves `row`, `actions` and `ui` out of the DOM). */
export function frameLayout({ row, index, top, height, level, posInSet, setSize, tabbable, density }: RowBaseProps<SidebarRow>): FrameLayout {
  return { rowKey: row.key, index, top, height, level, posInSet, setSize, tabbable, density };
}
