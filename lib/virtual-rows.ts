import { SIDEBAR_ROW_HEIGHTS, type SidebarDensity, type SidebarRow } from "@/lib/sidebar-types";

/**
 * Pure windowing math for the sidebar list. Rows have a fixed height per kind,
 * so positions are a prefix-sum array and every lookup is a binary search: the
 * work per scroll frame depends on the number of rows in view, never on the
 * total number of rows.
 */

/** Extra pixels rendered above and below the viewport. */
export const VIRTUAL_OVERSCAN_PX = 240;

/** Half-open range of row indexes: `start` inclusive, `end` exclusive. */
export interface VirtualRange {
  readonly start: number;
  readonly end: number;
}

export const EMPTY_VIRTUAL_RANGE: VirtualRange = { start: 0, end: 0 };

/**
 * Prefix sums of the row heights: `offsets[i]` is the top of row `i` and
 * `offsets[rows.length]` is the total content height.
 */
export function buildRowOffsets(rows: ArrayLike<{ readonly kind: SidebarRow["kind"] }>, density: SidebarDensity): Float64Array {
  const heights = SIDEBAR_ROW_HEIGHTS[density];
  const offsets = new Float64Array(rows.length + 1);
  let top = 0;
  for (let index = 0; index < rows.length; index++) {
    offsets[index] = top;
    top += heights[rows[index].kind];
  }
  offsets[rows.length] = top;
  return offsets;
}

export function rowCount(offsets: Float64Array): number {
  return Math.max(0, offsets.length - 1);
}

export function totalHeight(offsets: Float64Array): number {
  return offsets.length === 0 ? 0 : offsets[offsets.length - 1];
}

/** First index in `offsets` whose value is strictly greater than `value` (`offsets.length` when none). */
function upperBound(offsets: Float64Array, value: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (offsets[mid] > value) high = mid;
    else low = mid + 1;
  }
  return low;
}

/** First index in `offsets` whose value is greater than or equal to `value` (`offsets.length` when none). */
function lowerBound(offsets: Float64Array, value: number): number {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (offsets[mid] >= value) high = mid;
    else low = mid + 1;
  }
  return low;
}

/** Index of the row containing the content position `y`, clamped to the first/last row; -1 when there are no rows. */
export function findRowIndexAt(offsets: Float64Array, y: number): number {
  const count = rowCount(offsets);
  if (count === 0) return -1;
  return Math.min(count - 1, Math.max(0, upperBound(offsets, y) - 1));
}

/**
 * Rows that intersect `[scrollTop - overscan, scrollTop + viewportHeight + overscan)`.
 * An unmeasured viewport (<= 0) yields an empty range.
 */
export function computeVisibleRange(
  offsets: Float64Array,
  scrollTop: number,
  viewportHeight: number,
  overscan: number = VIRTUAL_OVERSCAN_PX,
): VirtualRange {
  const count = rowCount(offsets);
  if (count === 0 || !(viewportHeight > 0)) return EMPTY_VIRTUAL_RANGE;
  const top = Math.max(0, scrollTop) - overscan;
  const bottom = Math.max(0, scrollTop) + viewportHeight + overscan;
  const start = findRowIndexAt(offsets, top);
  const end = Math.min(count, lowerBound(offsets, bottom));
  return { start, end };
}

export function virtualRangesEqual(a: VirtualRange, b: VirtualRange): boolean {
  return a.start === b.start && a.end === b.end;
}

/**
 * Indexes to mount: the range plus every `keep` index outside it (focused row,
 * open menu, row being edited), ascending and unique. Out-of-bounds entries are
 * dropped.
 */
export function mergeMountedIndexes(range: VirtualRange, keep: readonly number[], count: number): number[] {
  const start = Math.min(range.start, count);
  const end = Math.min(range.end, count);
  const before: number[] = [];
  const after: number[] = [];
  for (const index of keep) {
    if (!Number.isInteger(index) || index < 0 || index >= count) continue;
    if (index < start) before.push(index);
    else if (index >= end) after.push(index);
  }
  before.sort((a, b) => a - b);
  after.sort((a, b) => a - b);
  const mounted: number[] = [];
  for (const index of before) if (mounted[mounted.length - 1] !== index) mounted.push(index);
  for (let index = start; index < end; index++) mounted.push(index);
  for (const index of after) if (mounted[mounted.length - 1] !== index) mounted.push(index);
  return mounted;
}

/**
 * The scroll position that makes row `index` fully visible with the least
 * movement ("nearest"). Rows taller than the viewport align to their top.
 * Returns `scrollTop` unchanged when the row is already visible or the index is
 * invalid.
 */
export function scrollTopToReveal(offsets: Float64Array, index: number, scrollTop: number, viewportHeight: number): number {
  const count = rowCount(offsets);
  if (!Number.isInteger(index) || index < 0 || index >= count || !(viewportHeight > 0)) return scrollTop;
  const rowTop = offsets[index];
  const rowBottom = offsets[index + 1];
  let next = scrollTop;
  if (rowTop < scrollTop) next = rowTop;
  else if (rowBottom > scrollTop + viewportHeight) next = rowBottom - viewportHeight > rowTop ? rowTop : rowBottom - viewportHeight;
  const max = Math.max(0, totalHeight(offsets) - viewportHeight);
  return Math.min(max, Math.max(0, next));
}
