import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { computeTreeMetrics, firstNavigableIndex, lastNavigableIndex, parentRowIndex, resolveSidebarKey } = await jiti.import("./sidebar-keyboard.ts");

let seq = 0;
const section = (id, o = {}) => ({ kind: "section", key: `s:${id}:${seq++}`, section: id, count: 1, collapsed: false, collapsible: id !== "workspaces", ...o });
const group = (name, o = {}) => ({
  kind: "group", key: `g:${name}`, projectKey: name, path: `/w/${name}`, label: name, alias: undefined, expanded: true, selected: false,
  pinned: false, hasLaunchConfig: false, counts: { total: 1, running: 0, waiting: 0, unread: 0, exited: 0 }, canMoveUp: false, canMoveDown: false,
  index: 0, setSize: 1, ...o,
});
const session = (id, o = {}) => ({
  kind: "session", key: `${o.context ?? "tree"}:${id}`, sessionId: id, projectKey: "a", depth: 0, status: "idle", title: id, timestamp: "2026-01-01T00:00:00Z",
  worktreeBranch: undefined, selected: false, pinned: false, hasChildren: false, expanded: false, context: "tree", workspaceLabel: undefined, snippet: undefined,
  optimistic: false, ...o,
});
const more = (o = {}) => ({ kind: "more", key: `m:${seq++}`, projectKey: "a", hidden: 3, canCollapse: false, ...o });
const placeholder = (variant = "loading") => ({ kind: "placeholder", key: `p:${seq++}`, variant, projectKey: undefined, detail: undefined });

const key = (k, extra = {}) => ({ key: k, ...extra });

test("Up/Down move to the neighbouring navigable row and stop at the ends", () => {
  const rows = [section("workspaces"), group("a"), placeholder(), session("x"), more()];
  const cases = [
    [0, "ArrowDown", 1],
    [1, "ArrowDown", 3], // placeholder skipped
    [3, "ArrowUp", 1],
    [4, "ArrowDown", null],
    [0, "ArrowUp", null],
    [4, "ArrowUp", 3],
  ];
  for (const [index, k, expected] of cases) {
    const intent = resolveSidebarKey(rows, index, key(k));
    assert.deepEqual(intent, expected === null ? null : { type: "focus", index: expected }, `${k} from ${index}`);
  }
});

test("Home/End jump to the first and last navigable row", () => {
  const rows = [placeholder(), group("a"), session("x"), session("y"), placeholder()];
  assert.equal(firstNavigableIndex(rows), 1);
  assert.equal(lastNavigableIndex(rows), 3);
  assert.deepEqual(resolveSidebarKey(rows, 2, key("Home")), { type: "focus", index: 1 });
  assert.deepEqual(resolveSidebarKey(rows, 2, key("End")), { type: "focus", index: 3 });
  assert.equal(resolveSidebarKey(rows, 1, key("Home")), null);
  assert.equal(resolveSidebarKey(rows, 3, key("End")), null);
  assert.equal(firstNavigableIndex([placeholder()]), -1);
  assert.equal(lastNavigableIndex([]), -1);
});

test("Right expands a folded row, otherwise enters its first child", () => {
  const rows = [
    group("closed", { expanded: false }), // 0
    group("open"), // 1
    session("child"), // 2
    group("empty"), // 3
    section("active", { collapsed: true }), // 4
    session("fork-parent", { hasChildren: true, expanded: false, context: "active" }), // 5
    section("pinned"), // 6
    session("p", { hasChildren: true, expanded: true, context: "pinned" }), // 7
    session("fork", { depth: 1, context: "pinned" }), // 8
    session("leaf", { context: "pinned" }), // 9
  ];
  assert.deepEqual(resolveSidebarKey(rows, 0, key("ArrowRight")), { type: "expand", index: 0 });
  assert.deepEqual(resolveSidebarKey(rows, 1, key("ArrowRight")), { type: "focus", index: 2 });
  assert.equal(resolveSidebarKey(rows, 3, key("ArrowRight")), null, "group followed by another group has no child");
  assert.deepEqual(resolveSidebarKey(rows, 4, key("ArrowRight")), { type: "expand", index: 4 });
  assert.deepEqual(resolveSidebarKey(rows, 5, key("ArrowRight")), { type: "expand", index: 5 });
  assert.deepEqual(resolveSidebarKey(rows, 6, key("ArrowRight")), { type: "focus", index: 7 });
  assert.deepEqual(resolveSidebarKey(rows, 7, key("ArrowRight")), { type: "focus", index: 8 });
  assert.equal(resolveSidebarKey(rows, 9, key("ArrowRight")), null);
});

test("Left collapses an open row, otherwise moves to the parent", () => {
  const rows = [
    group("a"), // 0
    session("root", { hasChildren: true, expanded: true }), // 1
    session("fork", { depth: 1, hasChildren: true, expanded: false }), // 2
    session("grandchild", { depth: 2 }), // 3
    session("sibling"), // 4
    more(), // 5
    group("b", { expanded: false }), // 6
    section("active", { collapsible: true }), // 7
    session("flat", { context: "active" }), // 8
    session("hit", { context: "search" }), // 9
  ];
  const cases = [
    [0, { type: "collapse", index: 0 }],
    [1, { type: "collapse", index: 1 }],
    [2, { type: "focus", index: 1 }], // folded fork -> its parent
    [3, { type: "focus", index: 2 }],
    [4, { type: "focus", index: 0 }],
    [5, { type: "focus", index: 0 }],
    [6, null],
    [7, { type: "collapse", index: 7 }],
    [8, { type: "focus", index: 7 }],
    [9, null],
  ];
  for (const [index, expected] of cases) assert.deepEqual(resolveSidebarKey(rows, index, key("ArrowLeft")), expected, `row ${index}`);
});

test("parentRowIndex does not cross into other contexts", () => {
  const rows = [section("active"), session("a", { context: "active" }), section("pinned"), session("b", { context: "pinned" }), session("c", { context: "pinned", depth: 1 })];
  assert.equal(parentRowIndex(rows, 1), 0);
  assert.equal(parentRowIndex(rows, 3), 2);
  assert.equal(parentRowIndex(rows, 4), 3);
  assert.equal(parentRowIndex(rows, 0), -1);
});

test("Enter and Space activate; Ctrl/Meta+Enter on a session asks for a new tab", () => {
  const rows = [group("a"), session("x"), placeholder()];
  assert.deepEqual(resolveSidebarKey(rows, 1, key("Enter")), { type: "activate", index: 1, newTab: false });
  assert.deepEqual(resolveSidebarKey(rows, 1, key("Enter", { ctrlKey: true })), { type: "activate", index: 1, newTab: true });
  assert.deepEqual(resolveSidebarKey(rows, 1, key("Enter", { metaKey: true })), { type: "activate", index: 1, newTab: true });
  assert.deepEqual(resolveSidebarKey(rows, 0, key("Enter", { ctrlKey: true })), { type: "activate", index: 0, newTab: false });
  assert.deepEqual(resolveSidebarKey(rows, 1, key(" ")), { type: "activate", index: 1, newTab: false });
});

test("row shortcuts: F2, Delete, p and the context-menu keys", () => {
  const rows = [section("active"), group("a"), session("x"), session("ghost", { optimistic: true }), more()];
  const cases = [
    [2, key("F2"), { type: "rename", index: 2 }],
    [1, key("F2"), { type: "rename", index: 1 }],
    [0, key("F2"), null],
    [3, key("F2"), null],
    [2, key("Delete"), { type: "delete", index: 2 }],
    [1, key("Delete"), null],
    [3, key("Delete"), null],
    [2, key("p"), { type: "pin", index: 2 }],
    [1, key("P"), { type: "pin", index: 1 }],
    [4, key("p"), null],
    [2, key("ContextMenu"), { type: "menu", index: 2 }],
    [1, key("F10", { shiftKey: true }), { type: "menu", index: 1 }],
    [1, key("F10"), null],
    [3, key("ContextMenu"), null],
    [0, key("ContextMenu"), null],
  ];
  for (const [index, input, expected] of cases) assert.deepEqual(resolveSidebarKey(rows, index, input), expected, `${JSON.stringify(input)} on ${index}`);
});

test("modified or unknown keys are ignored", () => {
  const rows = [group("a"), session("x")];
  const ignored = [
    key("ArrowDown", { altKey: true }),
    key("ArrowDown", { ctrlKey: true }),
    key("ArrowDown", { shiftKey: true }),
    key("p", { metaKey: true }),
    key("a"),
    key("Escape"),
    key("Tab"),
  ];
  for (const input of ignored) assert.equal(resolveSidebarKey(rows, 0, input), null, JSON.stringify(input));
  assert.equal(resolveSidebarKey(rows, 7, key("ArrowDown")), null, "unknown row index");
  assert.equal(resolveSidebarKey([], 0, key("Enter")), null);
});

test("tree metrics: levels, positions and sizes per sibling set", () => {
  const rows = [
    section("active"), // 0 level 1
    session("a", { context: "active" }), // 1 level 2
    session("b", { context: "active" }), // 2 level 2
    more({ projectKey: "" }), // 3 level 2 (third child of the section)
    section("workspaces", { collapsible: false }), // 4 level 1
    group("g1"), // 5 level 1
    session("r1"), // 6 level 2
    session("f1", { depth: 1 }), // 7 level 3
    session("f2", { depth: 1 }), // 8 level 3
    session("r2"), // 9 level 2
    more(), // 10 level 2
    group("g2", { expanded: false }), // 11 level 1
    placeholder("empty-workspace"), // 12 skipped
  ];
  const { level, posInSet, setSize } = computeTreeMetrics(rows);
  assert.deepEqual(Array.from(level), [1, 2, 2, 2, 1, 1, 2, 3, 3, 2, 2, 1, 0]);
  assert.deepEqual(Array.from(posInSet), [1, 1, 2, 3, 2, 3, 1, 1, 2, 2, 3, 4, 0]);
  assert.deepEqual(Array.from(setSize), [4, 3, 3, 3, 4, 4, 3, 2, 2, 3, 3, 4, 0]);
});

test("tree metrics: search results are flat level-1 items", () => {
  const rows = [session("a", { context: "search" }), session("b", { context: "search" }), placeholder("searching")];
  const { level, posInSet, setSize } = computeTreeMetrics(rows);
  assert.deepEqual(Array.from(level), [1, 1, 0]);
  assert.deepEqual(Array.from(posInSet), [1, 2, 0]);
  assert.deepEqual(Array.from(setSize), [2, 2, 0]);
});

test("tree metrics scale to thousands of rows", () => {
  const rows = [];
  for (let g = 0; g < 80; g++) {
    rows.push(group(`g${g}`));
    for (let s = 0; s < 60; s++) rows.push(session(`s${g}-${s}`, { projectKey: `g${g}` }));
  }
  const { posInSet, setSize } = computeTreeMetrics(rows);
  assert.equal(rows.length, 4880);
  assert.equal(setSize[0], 80);
  assert.equal(posInSet[61], 2);
  assert.equal(setSize[1], 60);
  assert.equal(posInSet[60], 60);
});
