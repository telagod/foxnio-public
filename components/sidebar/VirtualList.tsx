"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
  type Ref,
} from "react";
import type { SidebarDensity, SidebarRow } from "@/lib/sidebar-types";
import {
  buildRowOffsets,
  computeVisibleRange,
  mergeMountedIndexes,
  scrollTopToReveal,
  totalHeight,
  virtualRangesEqual,
} from "@/lib/virtual-rows";

/** Viewport assumed until the element is measured (server render, tests): enough rows for a first paint. */
const FALLBACK_VIEWPORT_PX = 640;

export interface VirtualListHandle {
  /** Scroll the minimum distance that makes the row fully visible. */
  scrollToIndex(index: number): void;
  /** The scroll container (the element with `role="tree"`). */
  getElement(): HTMLDivElement | null;
}

interface ScrollState {
  readonly top: number;
  readonly height: number;
}

export interface VirtualListProps<T extends { readonly key: string; readonly kind: SidebarRow["kind"] }>
  extends Omit<ComponentPropsWithoutRef<"div">, "role" | "children" | "onScroll" | "aria-label"> {
  readonly rows: readonly T[];
  readonly density: SidebarDensity;
  /** Row indexes that stay mounted outside the window: focused row, open menu, row being edited. */
  readonly keepMounted: readonly number[];
  readonly renderRow: (row: T, index: number, top: number, height: number) => ReactNode;
  /** Accessible name of the tree. */
  readonly label: string;
  /** Polite live-region text, e.g. the number of search results. */
  readonly statusMessage?: string;
  readonly ref?: Ref<VirtualListHandle>;
}

/**
 * Windowed `role="tree"`. Rows have fixed heights per kind, so positions come
 * from a prefix-sum array and the mounted window is found by binary search:
 * scrolling never does work proportional to the number of rows. The window
 * (viewport plus 240 px of overscan) re-renders only when its first or last
 * row changes. Rows are absolutely positioned by the renderer from the `top`
 * and `height` it receives.
 */
export function VirtualList<T extends { readonly key: string; readonly kind: SidebarRow["kind"] }>({
  rows,
  density,
  keepMounted,
  renderRow,
  label,
  statusMessage,
  ref,
  ...containerProps
}: VirtualListProps<T>) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const offsets = useMemo(() => buildRowOffsets(rows, density), [rows, density]);
  const offsetsRef = useRef(offsets);
  const frameRef = useRef(0);
  const [scroll, setScroll] = useState<ScrollState>({ top: 0, height: 0 });

  const viewportHeight = scroll.height > 0 ? scroll.height : FALLBACK_VIEWPORT_PX;
  const range = useMemo(() => computeVisibleRange(offsets, scroll.top, viewportHeight), [offsets, scroll.top, viewportHeight]);
  const mounted = mergeMountedIndexes(range, keepMounted, rows.length);

  /** Read the real scroll position and re-render only when the mounted window would change. */
  const measure = useCallback(() => {
    const element = scrollerRef.current;
    if (!element) return;
    const next: ScrollState = { top: element.scrollTop, height: element.clientHeight };
    setScroll((previous) => {
      if (previous.height === next.height) {
        const height = next.height > 0 ? next.height : FALLBACK_VIEWPORT_PX;
        const before = computeVisibleRange(offsetsRef.current, previous.top, height);
        const after = computeVisibleRange(offsetsRef.current, next.top, height);
        if (virtualRangesEqual(before, after)) return previous;
      }
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    offsetsRef.current = offsets;
    measure();
  }, [offsets, measure]);

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  const onScroll = useCallback(() => {
    if (frameRef.current) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = 0;
      measure();
    });
  }, [measure]);

  useImperativeHandle(ref, () => ({
    scrollToIndex(index: number) {
      const element = scrollerRef.current;
      if (!element) return;
      const target = scrollTopToReveal(offsetsRef.current, index, element.scrollTop, element.clientHeight || FALLBACK_VIEWPORT_PX);
      if (target !== element.scrollTop) element.scrollTop = target;
      measure();
    },
    getElement: () => scrollerRef.current,
  }), [measure]);

  return (
    <div className="sb-list-wrap">
      <div {...containerProps} ref={scrollerRef} className="sb-list" role="tree" aria-label={label} onScroll={onScroll}>
        <div className="sb-list-inner" style={{ height: totalHeight(offsets) }}>
          {mounted.map((index) => (
            <Fragment key={rows[index].key}>{renderRow(rows[index], index, offsets[index], offsets[index + 1] - offsets[index])}</Fragment>
          ))}
        </div>
      </div>
      <div className="sb-sr-only" role="status" aria-live="polite">{statusMessage}</div>
    </div>
  );
}
