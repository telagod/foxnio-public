import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  VIRTUAL_OVERSCAN_PX,
  buildRowOffsets,
  computeVisibleRange,
  findRowIndexAt,
  mergeMountedIndexes,
  scrollTopToReveal,
  totalHeight,
} = await jiti.import("./virtual-rows.ts");
const { SIDEBAR_ROW_HEIGHTS } = await jiti.import("./sidebar-types.ts");

const rowsOf = (...kinds) => kinds.map((kind) => ({ kind }));
/** n rows of the same kind: uniform 32 px rows in `comfortable`. */
const sessions = (n) => rowsOf(...Array.from({ length: n }, () => "session"));

test("offsets are prefix sums of the per-kind heights of the density", () => {
  const rows = rowsOf("section", "group", "session", "more", "placeholder");
  for (const density of ["compact", "comfortable", "touch"]) {
    const h = SIDEBAR_ROW_HEIGHTS[density];
    const offsets = buildRowOffsets(rows, density);
    assert.deepEqual(
      Array.from(offsets),
      [0, h.section, h.section + h.group, h.section + h.group + h.session, h.section + h.group + h.session + h.more,
        h.section + h.group + h.session + h.more + h.placeholder],
      density,
    );
    assert.equal(totalHeight(offsets), offsets.at(-1));
  }
});

test("an empty list has a single zero offset and no rows", () => {
  const offsets = buildRowOffsets([], "comfortable");
  assert.deepEqual(Array.from(offsets), [0]);
  assert.equal(findRowIndexAt(offsets, 10), -1);
  assert.deepEqual(computeVisibleRange(offsets, 0, 600), { start: 0, end: 0 });
});

test("findRowIndexAt maps positions to the containing row and clamps", () => {
  const offsets = buildRowOffsets(sessions(4), "comfortable"); // 0,32,64,96,128
  const cases = [[-50, 0], [0, 0], [31.9, 0], [32, 1], [95, 2], [96, 3], [127.9, 3], [128, 3], [9999, 3]];
  for (const [y, expected] of cases) assert.equal(findRowIndexAt(offsets, y), expected, `y=${y}`);
});

test("visible range includes the overscan on both sides and is half-open", () => {
  const offsets = buildRowOffsets(sessions(100), "comfortable"); // 32 px rows
  assert.equal(VIRTUAL_OVERSCAN_PX, 240);
  // Window [0, 560): rows whose top is below 560 -> 0..17.
  assert.deepEqual(computeVisibleRange(offsets, 0, 320), { start: 0, end: 18 });
  const scrolled = computeVisibleRange(offsets, 1000, 320);
  assert.equal(scrolled.start, Math.floor((1000 - 240) / 32));
  assert.equal(scrolled.end, Math.ceil((1000 + 320 + 240) / 32));
  // A row ending exactly at the top edge of the window is excluded, one starting exactly at the bottom edge too.
  const exact = computeVisibleRange(offsets, 320, 320, 0); // window [320, 640)
  assert.deepEqual(exact, { start: 10, end: 20 });
});

test("range clamps at both ends of the content", () => {
  const offsets = buildRowOffsets(sessions(10), "comfortable"); // total 320
  assert.deepEqual(computeVisibleRange(offsets, 0, 100, 0), { start: 0, end: 4 });
  assert.deepEqual(computeVisibleRange(offsets, 5000, 100, 0), { start: 9, end: 10 });
  assert.deepEqual(computeVisibleRange(offsets, -40, 100, 0), { start: 0, end: 4 });
  assert.deepEqual(computeVisibleRange(offsets, 0, 100_000), { start: 0, end: 10 });
});

test("an unmeasured viewport renders nothing", () => {
  const offsets = buildRowOffsets(sessions(10), "comfortable");
  for (const height of [0, -1, Number.NaN]) assert.deepEqual(computeVisibleRange(offsets, 0, height), { start: 0, end: 0 });
});

test("mixed heights keep ranges consistent with the offsets", () => {
  const kinds = [];
  for (let i = 0; i < 300; i++) kinds.push(i % 7 === 0 ? "group" : i % 11 === 0 ? "more" : "session");
  const rows = rowsOf(...kinds);
  const offsets = buildRowOffsets(rows, "touch");
  for (const scrollTop of [0, 137, 2048, 6001]) {
    const { start, end } = computeVisibleRange(offsets, scrollTop, 500, 0);
    assert.ok(offsets[start] <= scrollTop && offsets[start + 1] > scrollTop, `start contains scrollTop ${scrollTop}`);
    assert.ok(offsets[end - 1] < scrollTop + 500 && (end === rows.length || offsets[end] >= scrollTop + 500), `end covers ${scrollTop}`);
  }
});

test("5000+ rows: the window stays small and the lookup is independent of the total", () => {
  const rows = sessions(6000);
  const offsets = buildRowOffsets(rows, "comfortable");
  assert.equal(totalHeight(offsets), 6000 * 32);
  const range = computeVisibleRange(offsets, 90_000, 700);
  assert.ok(range.end - range.start <= Math.ceil((700 + 2 * VIRTUAL_OVERSCAN_PX) / 32) + 1);
  assert.ok(range.start > 2000 && range.end < 3500);
  const started = performance.now();
  for (let i = 0; i < 20_000; i++) computeVisibleRange(offsets, (i * 97) % 190_000, 700);
  assert.ok(performance.now() - started < 500, "20k range lookups over 6000 rows are cheap");
});

test("mounted indexes merge the window with kept rows, sorted and unique", () => {
  const cases = [
    [{ start: 10, end: 13 }, [], 100, [10, 11, 12]],
    [{ start: 10, end: 13 }, [50, 2, 11, 2, 99], 100, [2, 10, 11, 12, 50, 99]],
    [{ start: 10, end: 13 }, [13, 9], 100, [9, 10, 11, 12, 13]],
    [{ start: 10, end: 13 }, [-1, 100, 4.5, 500], 100, [10, 11, 12]],
    [{ start: 0, end: 0 }, [7, 3], 10, [3, 7]],
    [{ start: 8, end: 20 }, [], 10, [8, 9]],
  ];
  for (const [range, keep, count, expected] of cases) {
    assert.deepEqual(mergeMountedIndexes(range, keep, count), expected, JSON.stringify({ range, keep, count }));
  }
});

test("scrollTopToReveal moves the least distance", () => {
  const offsets = buildRowOffsets(sessions(100), "comfortable"); // total 3200
  const viewport = 200;
  const cases = [
    // index, scrollTop, expected
    [10, 300, 300], // 320..352 inside 300..500
    [5, 300, 160], // above: align to the top edge
    [20, 300, 472], // 640..672 below: bottom edge at 672
    [99, 0, 3000], // clamped to the maximum scroll
    [0, 500, 0],
    [-1, 123, 123],
    [100, 123, 123],
    [1.5, 123, 123],
  ];
  for (const [index, scrollTop, expected] of cases) {
    assert.equal(scrollTopToReveal(offsets, index, scrollTop, viewport), expected, `index=${index} scrollTop=${scrollTop}`);
  }
  assert.equal(scrollTopToReveal(offsets, 3, 0, 0), 0, "unmeasured viewport leaves the position alone");
});

test("a row taller than the viewport aligns to its top", () => {
  const offsets = buildRowOffsets(rowsOf("session", "placeholder", "session"), "touch"); // 44, 56, 44
  assert.equal(scrollTopToReveal(offsets, 1, 0, 30), 44);
});
