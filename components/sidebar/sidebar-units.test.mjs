import "../../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import React from "react";
import { act, cleanup, render } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";
import { createActions, group, session } from "./test-fixtures.mjs";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { createLongPressTracker, LONG_PRESS_DELAY_MS, LONG_PRESS_SLOP_PX } = await jiti.import("./long-press.ts");
const { groupMenuEntries, sessionMenuEntries, sortMenuEntries, filterMenuEntries, overflowMenuEntries } = await jiti.import("./menu-items.ts");
const { rowPropsEqual } = await jiti.import("./row-support.tsx");
const { resolveSidebarDensity } = await jiti.import("./useSidebarDensity.ts");
const { useMinuteClock } = await jiti.import("./useMinuteClock.ts");
const { sessionHref } = await jiti.import("./session-href.ts");

afterEach(() => {
  mock.timers.reset();
  cleanup();
});

const t = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
function context() {
  const { actions, calls } = createActions();
  const modes = [];
  return { calls, modes, ctx: { actions, t, ui: { beginMode: (...args) => modes.push(args) } } };
}
const labels = (entries) => entries.filter((e) => e.type === "item").map((e) => e.id);

test("long press fires once after the delay with the press origin", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const fired = [];
  const tracker = createLongPressTracker((payload, x, y) => fired.push([payload, x, y]));
  assert.equal(LONG_PRESS_DELAY_MS, 500);
  assert.equal(LONG_PRESS_SLOP_PX, 8);

  tracker.start(20, 30, "row");
  mock.timers.tick(499);
  assert.deepEqual(fired, []);
  mock.timers.tick(1);
  assert.deepEqual(fired, [["row", 20, 30]]);
  mock.timers.tick(5000);
  assert.equal(fired.length, 1);
});

test("long press: travel up to 8 px is allowed, more cancels", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const cases = [
    // dx, dy, fires
    [0, 0, true],
    [8, 0, true], // exactly the slop
    [5, 6, true], // 7.8 px
    [6, 6, false], // 8.5 px
    [-9, 0, false],
    [0, 9, false],
  ];
  for (const [dx, dy, fires] of cases) {
    const fired = [];
    const tracker = createLongPressTracker(() => fired.push(true));
    tracker.start(100, 100, null);
    tracker.move(100 + dx, 100 + dy);
    mock.timers.tick(600);
    assert.equal(fired.length, fires ? 1 : 0, `${dx},${dy}`);
  }
});

test("long press: cancel stops it, a new start restarts the clock, and the click flag is consumed once", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const fired = [];
  const tracker = createLongPressTracker((payload) => fired.push(payload));

  tracker.start(0, 0, "first");
  mock.timers.tick(300);
  tracker.cancel();
  mock.timers.tick(1000);
  assert.deepEqual(fired, []);
  assert.equal(tracker.consumeFired(), false);

  tracker.start(0, 0, "second");
  mock.timers.tick(300);
  tracker.start(0, 0, "third"); // a second finger or a new press replaces the first
  mock.timers.tick(300);
  assert.deepEqual(fired, []);
  mock.timers.tick(200);
  assert.deepEqual(fired, ["third"]);
  assert.equal(tracker.consumeFired(), true);
  assert.equal(tracker.consumeFired(), false);

  tracker.start(0, 0, "fourth");
  mock.timers.tick(500);
  tracker.start(0, 0, "fifth");
  assert.equal(tracker.consumeFired(), false, "a new press clears the flag");
});

test("session menu entries run the right actions and hide for in-memory sessions", () => {
  const { calls, modes, ctx } = context();
  const row = session("s1", { hasChildren: true });
  const entries = sessionMenuEntries(row, ctx);
  assert.deepEqual(labels(entries), ["open-new-tab", "pin", "rename", "copy-transcript", "copy-id", "archive", "delete"]);
  for (const entry of entries) if (entry.type === "item" && !entry.disabled) entry.onSelect();
  assert.deepEqual(calls, [
    ["openSession", "s1", { newTab: true }],
    ["pinSession", "s1", true],
    ["copyTranscript", "s1"],
    ["copySessionId", "s1"],
  ]);
  assert.deepEqual(modes, [[row.key, "rename"], [row.key, "confirm"]]);

  const archive = entries.find((e) => e.id === "archive");
  assert.equal(archive.disabled, true);
  assert.equal(archive.hint, "sessionSidebar.archiveLeafOnly");
  assert.equal(sessionMenuEntries(session("leaf"), ctx).find((e) => e.id === "archive").disabled, false);
  assert.deepEqual(sessionMenuEntries(session("x", { optimistic: true }), ctx), []);

  const pinned = sessionMenuEntries(session("p", { pinned: true }), ctx).find((e) => e.id === "pin");
  assert.equal(pinned.label, "sidebar.menu.unpin");
  pinned.onSelect();
  assert.deepEqual(calls.at(-1), ["pinSession", "p", false]);
});

test("group menu entries: reorder items depend on the row, labels on alias and launch config", () => {
  const { calls, modes, ctx } = context();
  const plain = groupMenuEntries(group("a"), ctx);
  assert.deepEqual(labels(plain), ["new-session", "alias", "launch-config", "pin", "remove"]);
  assert.equal(plain.find((e) => e.id === "alias").label, "projects.nameAlias");
  assert.equal(plain.find((e) => e.id === "launch-config").label, "sessionSidebar.configureLaunchConfig");

  const rich = groupMenuEntries(group("b", { alias: "B", hasLaunchConfig: true, pinned: true, canMoveUp: true, canMoveDown: false }), ctx);
  assert.deepEqual(labels(rich), ["new-session", "alias", "launch-config", "pin", "move-up", "move-down", "remove"]);
  assert.equal(rich.find((e) => e.id === "alias").label, "projects.editAlias");
  assert.equal(rich.find((e) => e.id === "move-up").disabled, false);
  assert.equal(rich.find((e) => e.id === "move-down").disabled, true);
  for (const id of ["new-session", "launch-config", "pin", "move-up"]) rich.find((e) => e.id === id).onSelect();
  rich.find((e) => e.id === "alias").onSelect();
  rich.find((e) => e.id === "remove").onSelect();
  assert.deepEqual(calls, [
    ["newSessionInWorkspace", "/work/b", "/work/b"],
    ["editLaunchConfig", "/work/b"],
    ["pinWorkspace", "/work/b", false],
    ["moveWorkspace", "/work/b", -1],
  ]);
  assert.deepEqual(modes, [["group:b", "rename"], ["group:b", "confirm"]]);
});

test("sort, filter and overflow entries reflect the current state", () => {
  const { calls, ctx } = context();
  const sort = sortMenuEntries("updated", ctx);
  assert.deepEqual(sort.map((e) => [e.id, e.checked, e.role]), [
    ["sort-none", false, "menuitemradio"],
    ["sort-alphabetical", false, "menuitemradio"],
    ["sort-updated", true, "menuitemradio"],
  ]);
  sort[1].onSelect();

  const presets = filterMenuEntries(false, 15, ctx);
  assert.deepEqual(presets.filter((e) => e.id.startsWith("limit-")).map((e) => [e.label, e.checked]), [["10", false], ["15", true], ["20", false]]);
  const custom = filterMenuEntries(true, 25, ctx);
  assert.deepEqual(custom.filter((e) => e.id.startsWith("limit-")).map((e) => [e.label, e.checked]), [["10", false], ["15", false], ["20", false], ["25", true]]);
  custom.find((e) => e.id === "running-only").onSelect();
  custom.find((e) => e.id === "limit-20").onSelect();

  const overflow = overflowMenuEntries({ sortMode: "none", runningOnly: true }, ctx);
  assert.deepEqual(labels(overflow), ["archive-browser", "import", "refresh", "sort-none", "sort-alphabetical", "sort-updated", "running-only"]);
  assert.equal(overflow.find((e) => e.id === "running-only").checked, true);
  for (const id of ["archive-browser", "import", "refresh"]) overflow.find((e) => e.id === id).onSelect();
  assert.deepEqual(calls, [
    ["setSortMode", "alphabetical"],
    ["setRunningOnly", false],
    ["setRecentRunsLimit", 20],
    ["openArchive"],
    ["importSession"],
    ["refresh"],
  ]);
});

test("rows re-render only when something they show changed", () => {
  const actions = {};
  const ui = {};
  const props = (row, extra = {}) => ({ row, index: 3, top: 96, height: 32, level: 2, posInSet: 1, setSize: 4, tabbable: false, density: "comfortable", actions, ui, mode: undefined, menuOpen: false, ...extra });

  const row = session("a");
  assert.equal(rowPropsEqual(props(row), props({ ...row })), true, "a rebuilt but equal row is skipped");
  assert.equal(rowPropsEqual(props(row), props({ ...row, status: "running" })), false);
  assert.equal(rowPropsEqual(props(row), props({ ...row, title: "other" })), false);
  assert.equal(rowPropsEqual(props(row), props(row, { top: 128 })), false, "moved");
  assert.equal(rowPropsEqual(props(row), props(row, { tabbable: true })), false);
  assert.equal(rowPropsEqual(props(row), props(row, { menuOpen: true })), false);
  assert.equal(rowPropsEqual(props(row), props(row, { mode: "rename" })), false);
  assert.equal(rowPropsEqual(props(row), props(row, { density: "touch" })), false);
  assert.equal(rowPropsEqual(props(row), props(row, { actions: {} })), false, "a new actions object re-renders everything");

  const g = group("g", { counts: { total: 3, running: 1, waiting: 0, unread: 0, exited: 0 } });
  assert.equal(rowPropsEqual(props(g), props({ ...g, counts: { ...g.counts } })), true, "nested counts compare by value");
  assert.equal(rowPropsEqual(props(g), props({ ...g, counts: { ...g.counts, running: 2 } })), false);
});

test("density: accessible and coarse pointers are touch, compact only on fine pointers", () => {
  const cases = [
    [false, "auto", "comfortable"],
    [false, "compact", "compact"],
    [false, "accessible", "touch"],
    [true, "auto", "touch"],
    [true, "compact", "touch"],
    [true, "accessible", "touch"],
  ];
  for (const [coarse, preference, expected] of cases) assert.equal(resolveSidebarDensity(coarse, preference), expected, `${coarse} ${preference}`);
});

test("the session link encodes the id", () => {
  assert.equal(sessionHref("abc"), "/?session=abc");
  assert.equal(sessionHref("a/b c&d"), "/?session=a%2Fb%20c%26d");
});

test("the minute clock is shared, floored to the minute and ticks at the wall-clock minute", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 0, 1, 12, 0, 30) });
  const seen = [];
  function Probe({ id }) {
    const now = useMinuteClock();
    seen.push([id, now]);
    return null;
  }
  render(React.createElement(React.Fragment, null, React.createElement(Probe, { id: "a" }), React.createElement(Probe, { id: "b" })));
  const start = Date.UTC(2026, 0, 1, 12, 0, 0);
  assert.deepEqual(seen.slice(-2), [["a", start], ["b", start]]);

  seen.length = 0;
  act(() => mock.timers.tick(29_000));
  assert.deepEqual(seen, [], "nothing re-renders inside the minute");
  act(() => mock.timers.tick(2_000));
  assert.deepEqual(seen.map(([, now]) => now), [start + 60_000, start + 60_000], "both subscribers update together");

  seen.length = 0;
  act(() => mock.timers.tick(60_000));
  assert.equal(seen.length, 2);
  assert.equal(seen[0][1], start + 120_000);
});

test("the minute clock stops ticking when nothing is mounted", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.UTC(2026, 0, 1, 12, 0, 0) });
  let renders = 0;
  function Probe() {
    useMinuteClock();
    renders++;
    return null;
  }
  const view = render(React.createElement(Probe));
  const before = renders;
  view.unmount();
  act(() => mock.timers.tick(10 * 60_000));
  assert.equal(renders, before);
});
