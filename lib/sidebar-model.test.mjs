import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  LIVE_PLACEHOLDER_TIMESTAMP,
  SECTION_BASE_ROWS,
  WATERMARK_SCAN_ROOTS,
  WORKSPACE_BASE_ROWS,
  buildSidebarModel,
} = await jiti.import("./sidebar-model.ts");
const { createDefaultSidebarUiState, markStickyOpen, openProject, sectionExtraRowsKey, setOrderFrozen, setRunningOnly, setSortMode, showMore, toggleFork, toggleProject, toggleSection } =
  await jiti.import("./sidebar-ui-state.ts");

const APP = "/work/app";
const API = "/work/api";

/** Minutes after 2026-01-01: a larger index is a more recent session. */
function minute(index) {
  return new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
}

function session(id, overrides = {}) {
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd: APP,
    created: minute(0),
    modified: minute(0),
    messageCount: 1,
    firstMessage: `message ${id}`,
    projectRoot: APP,
    projectKey: APP,
    ...overrides,
  };
}

/** `count` sessions s1..sN in `root`; sN is the most recent. */
function workspaceSessions(root, count, prefix = "s", offset = 0) {
  return Array.from({ length: count }, (_, i) => session(`${prefix}${i + 1}`, { cwd: root, projectRoot: root, projectKey: root, modified: minute(offset + i + 1) }));
}

function input(overrides = {}) {
  return {
    sessions: [],
    projects: [{ path: APP }],
    sessionsStatus: "ready",
    sessionsError: undefined,
    running: new Set(),
    waiting: new Set(),
    exited: new Map(),
    unread: new Set(),
    recentlyCompleted: new Set(),
    pinnedSessionIds: [],
    selectedSessionId: null,
    selectedProjectKey: APP,
    optimisticSession: null,
    ui: createDefaultSidebarUiState(),
    search: null,
    ...overrides,
  };
}

const keys = (model) => model.rows.map((row) => row.key);
const sessionRows = (model, context) => model.rows.filter((row) => row.kind === "session" && (!context || row.context === context));
const treeIds = (model) => sessionRows(model, "tree").map((row) => row.sessionId);
const row = (model, key) => model.rows.find((r) => r.key === key);

function exited(id, cwd = APP) {
  return { id, cwd, at: 1, code: 1, signal: null, detail: "boom" };
}

// ---- Empty and load states ----------------------------------------------------

test("loading with nothing to show renders a loading placeholder only", () => {
  const model = buildSidebarModel(input({ sessionsStatus: "loading", projects: [] }));
  assert.deepEqual(keys(model), ["placeholder:loading"]);
});

test("loading keeps showing data that is already there", () => {
  const model = buildSidebarModel(input({ sessionsStatus: "loading", sessions: workspaceSessions(APP, 2) }));
  assert.equal(model.rows.some((r) => r.kind === "placeholder"), false);
  assert.deepEqual(treeIds(model), ["s2", "s1"]);
});

test("an error with no workspaces shows only the error with its detail", () => {
  const model = buildSidebarModel(input({ sessionsStatus: "error", sessionsError: "HTTP 500", projects: [] }));
  assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0].kind, "placeholder");
  assert.equal(model.rows[0].variant, "error");
  assert.equal(model.rows[0].detail, "HTTP 500");
});

test("an error above stale data keeps the list", () => {
  const model = buildSidebarModel(input({ sessionsStatus: "error", sessionsError: "offline", sessions: workspaceSessions(APP, 1) }));
  assert.equal(model.rows[0].variant, "error");
  assert.deepEqual(treeIds(model), ["s1"]);
});

test("no registered workspaces and no sessions renders the no-workspaces placeholder", () => {
  const model = buildSidebarModel(input({ projects: [] }));
  assert.deepEqual(keys(model), ["placeholder:no-workspaces"]);
  assert.equal(model.sessionRowIndex.size, 0);
  assert.equal(model.groupRowIndex.size, 0);
});

test("an expanded workspace without sessions shows an empty-workspace placeholder under its group", () => {
  const model = buildSidebarModel(input());
  assert.deepEqual(model.rows.map((r) => r.kind), ["section", "group", "placeholder"]);
  assert.equal(model.rows[2].variant, "empty-workspace");
  assert.equal(model.rows[2].projectKey, APP);
});

test("a folded workspace without sessions has no placeholder", () => {
  const model = buildSidebarModel(input({ selectedProjectKey: null }));
  assert.deepEqual(model.rows.map((r) => r.kind), ["section", "group"]);
});

// ---- Workspace expansion ------------------------------------------------------

function twoWorkspaces(overrides = {}) {
  return input({
    projects: [{ path: APP, sortOrder: 0 }, { path: API, sortOrder: 1 }],
    sessions: [...workspaceSessions(APP, 2, "a"), ...workspaceSessions(API, 2, "b", 10)],
    ...overrides,
  });
}

test("by default only the selected workspace is expanded", () => {
  const model = buildSidebarModel(twoWorkspaces());
  assert.deepEqual(treeIds(model), ["a2", "a1"]);
  assert.equal(row(model, `group:${APP}`).expanded, true);
  assert.equal(row(model, `group:${APP}`).selected, true);
  assert.equal(row(model, `group:${API}`).expanded, false);
  assert.equal(row(model, `group:${API}`).selected, false);
});

test("expandedProjects opens other workspaces", () => {
  const ui = toggleProject(createDefaultSidebarUiState(), API, false);
  assert.deepEqual(treeIds(buildSidebarModel(twoWorkspaces({ ui }))), ["a2", "a1", "b2", "b1"]);
});

test("an explicit collapse wins over the selected workspace's auto-open, and selecting reopens it", () => {
  const collapsed = toggleProject(createDefaultSidebarUiState(), APP, true);
  const model = buildSidebarModel(twoWorkspaces({ ui: collapsed }));
  assert.equal(row(model, `group:${APP}`).expanded, false);
  assert.deepEqual(treeIds(model), []);
  assert.equal(row(buildSidebarModel(twoWorkspaces({ ui: openProject(collapsed, APP) })), `group:${APP}`).expanded, true);
});

test("a sticky workspace stays open even after an explicit collapse record", () => {
  let ui = toggleProject(createDefaultSidebarUiState(), API, true);
  ui = markStickyOpen(ui, API);
  const model = buildSidebarModel(twoWorkspaces({ ui, selectedProjectKey: APP }));
  assert.equal(row(model, `group:${API}`).expanded, true);
  assert.deepEqual(treeIds(model), ["a2", "a1", "b2", "b1"]);
});

test("collapsing a sticky workspace through the reducer closes it", () => {
  let ui = markStickyOpen(createDefaultSidebarUiState(), API);
  ui = toggleProject(ui, API, true);
  assert.equal(row(buildSidebarModel(twoWorkspaces({ ui })), `group:${API}`).expanded, false);
});

test("folded workspaces still aggregate counts over all their sessions", () => {
  const sessions = [...workspaceSessions(API, 8, "b")];
  const model = buildSidebarModel(
    input({
      projects: [{ path: APP }, { path: API }],
      sessions: [...workspaceSessions(APP, 1, "a"), ...sessions],
      running: new Set(["b1", "b2"]),
      waiting: new Set(["b3", "b1"]),
      unread: new Set(["b4", "b5", "b2"]),
      exited: new Map([["b6", exited("b6", API)]]),
    }),
  );
  const group = row(model, `group:${API}`);
  assert.equal(group.expanded, false);
  // Statuses are exclusive: b1 is waiting (not also running), b2 is running (not also unread).
  assert.deepEqual(group.counts, { total: 8, running: 1, waiting: 2, unread: 2, exited: 1 });
});

test("group rows expose alias, label fallbacks, launch config and aria positions", () => {
  const model = buildSidebarModel(
    input({
      projects: [
        { path: APP, alias: "Main", launchConfig: { advisor: true }, sortOrder: 0 },
        { path: "/", sortOrder: 1 },
        { path: "C:\\Work\\Win\\", sortOrder: 2 },
      ],
      selectedProjectKey: null,
    }),
  );
  const groups = model.rows.filter((r) => r.kind === "group");
  assert.deepEqual(groups.map((g) => g.label), ["Main", "/", "Win"]);
  assert.equal(groups[0].alias, "Main");
  assert.equal(groups[0].hasLaunchConfig, true);
  assert.equal(groups[1].hasLaunchConfig, false);
  assert.deepEqual(groups.map((g) => [g.index, g.setSize]), [[0, 3], [1, 3], [2, 3]]);
  assert.equal(groups[0].path, APP);
});

// ---- Ordering, pins, freeze ---------------------------------------------------

function ordered(overrides = {}) {
  return input({
    projects: [
      { path: "/w/zeta", sortOrder: 0 },
      { path: "/w/alpha", sortOrder: 1 },
      { path: "/w/mid", sortOrder: 2, pinOrder: 1 },
      { path: "/w/beta", sortOrder: 3, pinOrder: 0 },
    ],
    selectedProjectKey: null,
    ...overrides,
  });
}
const groupOrder = (model) => model.rows.filter((r) => r.kind === "group").map((r) => r.label);

test("sort none keeps the manual order and ignores pins", () => {
  const model = buildSidebarModel(ordered());
  assert.deepEqual(groupOrder(model), ["zeta", "alpha", "mid", "beta"]);
  assert.equal(model.rows.filter((r) => r.kind === "group").some((g) => g.pinned), false);
  const groups = model.rows.filter((r) => r.kind === "group");
  assert.deepEqual(groups.map((g) => [g.canMoveUp, g.canMoveDown]), [[false, true], [true, true], [true, true], [true, false]]);
});

test("alphabetical sort puts pinned workspaces first in pin order; only pinned rows reorder", () => {
  const model = buildSidebarModel(ordered({ ui: setSortMode(createDefaultSidebarUiState(), "alphabetical") }));
  assert.deepEqual(groupOrder(model), ["beta", "mid", "alpha", "zeta"]);
  const groups = model.rows.filter((r) => r.kind === "group");
  assert.deepEqual(groups.map((g) => g.pinned), [true, true, false, false]);
  assert.deepEqual(groups.map((g) => [g.canMoveUp, g.canMoveDown]), [[false, true], [true, false], [false, false], [false, false]]);
});

test("updated sort follows the newest session per workspace", () => {
  const model = buildSidebarModel(
    ordered({
      projects: [{ path: "/w/a" }, { path: "/w/b" }, { path: "/w/c" }],
      sessions: [
        session("a1", { projectRoot: "/w/a", projectKey: "/w/a", modified: minute(5) }),
        session("b1", { projectRoot: "/w/b", projectKey: "/w/b", modified: minute(9), lastMessageAt: minute(2) }),
        session("c1", { projectRoot: "/w/c", projectKey: "/w/c", modified: minute(7) }),
      ],
      ui: setSortMode(createDefaultSidebarUiState(), "updated"),
    }),
  );
  assert.deepEqual(groupOrder(model), ["c", "a", "b"]);
});

test("a frozen order keeps the previous workspace order and appends new workspaces", () => {
  const base = ordered({
    projects: [{ path: "/w/a" }, { path: "/w/b" }],
    sessions: [
      session("a1", { projectRoot: "/w/a", projectKey: "/w/a", modified: minute(1) }),
      session("b1", { projectRoot: "/w/b", projectKey: "/w/b", modified: minute(2) }),
    ],
    ui: setSortMode(createDefaultSidebarUiState(), "updated"),
  });
  const before = buildSidebarModel(base);
  assert.deepEqual(before.projectOrder, ["/w/b", "/w/a"]);

  const bumped = base.sessions.map((s) => (s.id === "a1" ? { ...s, modified: minute(50) } : s));
  const withNew = {
    ...base,
    sessions: bumped,
    optimisticSession: session("new1", { path: "", cwd: "/w/fresh", projectRoot: "/w/fresh", projectKey: undefined, modified: minute(60) }),
  };
  const live = buildSidebarModel(withNew);
  assert.deepEqual(live.projectOrder.slice(0, 2), ["/w/fresh", "/w/a"], "unfrozen ordering follows activity");

  const frozen = buildSidebarModel({ ...withNew, ui: setOrderFrozen(base.ui, true) }, { frozenOrder: before.projectOrder });
  assert.deepEqual(frozen.projectOrder, ["/w/b", "/w/a", "/w/fresh"]);
  assert.deepEqual(groupOrder(frozen), ["b", "a", "fresh"]);

  const flagWithoutOrder = buildSidebarModel({ ...withNew, ui: setOrderFrozen(base.ui, true) });
  assert.deepEqual(flagWithoutOrder.projectOrder, live.projectOrder);
});

test("duplicate workspaces that differ only by Windows path spelling collapse into one group", () => {
  const model = buildSidebarModel(input({ projects: [{ path: "C:\\Work\\App" }, { path: "c:/work/app/" }], selectedProjectKey: null }));
  assert.equal(model.rows.filter((r) => r.kind === "group").length, 1);
});

// ---- Windows paths --------------------------------------------------------------

test("sessions group under a Windows workspace through case-folded keys", () => {
  const model = buildSidebarModel(
    input({
      projects: [{ path: "C:\\Work\\App" }],
      sessions: [
        session("w1", { cwd: "C:\\Work\\App", projectRoot: "C:\\Work\\App", projectKey: "c:/work/app", modified: minute(1) }),
        session("w2", { cwd: "c:\\work\\app", projectRoot: undefined, projectKey: undefined, modified: minute(2) }),
      ],
      selectedProjectKey: "C:\\Work\\App",
    }),
  );
  const group = row(model, "group:c:/work/app");
  assert.ok(group);
  assert.equal(group.selected, true);
  assert.equal(group.path, "C:\\Work\\App");
  assert.deepEqual(treeIds(model), ["w2", "w1"]);
  assert.equal(group.counts.total, 2);
});

// ---- Watermark ------------------------------------------------------------------

test("an open workspace shows its first rows and a more row with the hidden count", () => {
  const model = buildSidebarModel(input({ sessions: workspaceSessions(APP, 12) }));
  assert.deepEqual(treeIds(model), ["s12", "s11", "s10", "s9", "s8"]);
  assert.equal(WORKSPACE_BASE_ROWS, 5);
  const more = row(model, `more:${APP}`);
  assert.deepEqual([more.kind, more.projectKey, more.hidden, more.canCollapse], ["more", APP, 7, false]);
  assert.equal(model.rows.at(-1), more);
});

test("small workspaces have no more row", () => {
  const model = buildSidebarModel(input({ sessions: workspaceSessions(APP, WORKSPACE_BASE_ROWS) }));
  assert.equal(model.rows.some((r) => r.kind === "more"), false);
});

test("running, waiting, unread, exited and selected sessions raise the cut line", () => {
  const cases = [
    ["running", { running: new Set(["s4"]) }],
    ["waiting", { waiting: new Set(["s4"]) }],
    ["unread", { unread: new Set(["s4"]) }],
    ["exited", { exited: new Map([["s4", exited("s4")]]) }],
    ["selected", { selectedSessionId: "s4" }],
  ];
  for (const [name, overrides] of cases) {
    // s4 is the 9th most recent of 12: raising the cut shows 9 rows and hides 3.
    const model = buildSidebarModel(input({ sessions: workspaceSessions(APP, 12), ...overrides }));
    assert.equal(treeIds(model).length, 9, name);
    assert.equal(treeIds(model).at(-1), "s4", name);
    assert.equal(row(model, `more:${APP}`).hidden, 3, name);
  }
});

test("completed and idle sessions never raise the cut line", () => {
  const model = buildSidebarModel(input({ sessions: workspaceSessions(APP, 12), recentlyCompleted: new Set(["s1", "s2"]) }));
  assert.equal(treeIds(model).length, 5);
});

test("only sessions among the first roots can raise the cut line", () => {
  const count = WATERMARK_SCAN_ROOTS + 20;
  const sessions = workspaceSessions(APP, count);
  const inside = `s${count - (WATERMARK_SCAN_ROOTS - 1)}`; // the 50th most recent
  const outside = `s${count - WATERMARK_SCAN_ROOTS}`; // the 51st
  assert.equal(treeIds(buildSidebarModel(input({ sessions, running: new Set([outside]) }))).length, 5);
  const raised = buildSidebarModel(input({ sessions, running: new Set([inside]) }));
  assert.equal(treeIds(raised).length, WATERMARK_SCAN_ROOTS);
  assert.equal(row(raised, `more:${APP}`).hidden, 20);
});

test("the farthest flagged session decides the cut line", () => {
  const model = buildSidebarModel(input({ sessions: workspaceSessions(APP, 20), running: new Set(["s19", "s11"]) }));
  assert.equal(treeIds(model).length, 10);
});

test("show more adds rows on top of the raised cut line, show less is offered, then everything fits", () => {
  const sessions = workspaceSessions(APP, 40);
  const once = buildSidebarModel(input({ sessions, ui: showMore(createDefaultSidebarUiState(), APP) }));
  assert.equal(treeIds(once).length, 25);
  const more = row(once, `more:${APP}`);
  assert.deepEqual([more.hidden, more.canCollapse], [15, true]);

  const twice = buildSidebarModel(input({ sessions, ui: showMore(showMore(createDefaultSidebarUiState(), APP), APP) }));
  assert.equal(treeIds(twice).length, 40);
  const last = row(twice, `more:${APP}`);
  assert.deepEqual([last.hidden, last.canCollapse], [0, true]);

  const raised = buildSidebarModel(input({ sessions, running: new Set(["s30"]), ui: showMore(createDefaultSidebarUiState(), APP) }));
  assert.equal(treeIds(raised).length, 31, "raised cut (11) plus 20 extra rows");
});

test("stale extra rows on a workspace that already fits produce no more row", () => {
  const model = buildSidebarModel(input({ sessions: workspaceSessions(APP, 4), ui: showMore(createDefaultSidebarUiState(), APP) }));
  assert.equal(model.rows.some((r) => r.kind === "more"), false);
});

test("the running-only filter lifts the cap", () => {
  const sessions = workspaceSessions(APP, 30);
  const model = buildSidebarModel(
    input({ sessions, running: new Set(sessions.map((s) => s.id)), ui: setRunningOnly(createDefaultSidebarUiState(), true) }),
  );
  assert.equal(treeIds(model).length, 30);
  assert.equal(model.rows.some((r) => r.kind === "more" && r.projectKey === APP), false);
});

// ---- Forks ----------------------------------------------------------------------

function forkFixture() {
  return [
    session("root", { modified: minute(10) }),
    session("fork", { parentSessionId: "root", modified: minute(11) }),
    session("grand", { parentSessionId: "fork", modified: minute(12) }),
    session("other", { modified: minute(5) }),
  ];
}

test("fork children render below their parent with depth and fold state", () => {
  const model = buildSidebarModel(input({ sessions: forkFixture() }));
  const rows = sessionRows(model, "tree");
  assert.deepEqual(rows.map((r) => [r.sessionId, r.depth, r.hasChildren, r.expanded]), [
    ["root", 0, true, true],
    ["fork", 1, true, true],
    ["grand", 2, false, false],
    ["other", 0, false, false],
  ]);
});

test("folding a fork hides its children and keeps the parent", () => {
  const model = buildSidebarModel(input({ sessions: forkFixture(), ui: toggleFork(createDefaultSidebarUiState(), "root") }));
  const rows = sessionRows(model, "tree");
  assert.deepEqual(rows.map((r) => r.sessionId), ["root", "other"]);
  assert.deepEqual([rows[0].hasChildren, rows[0].expanded], [true, false]);
});

test("fork children count toward the cut line like roots", () => {
  const sessions = [
    session("root", { modified: minute(50) }),
    ...Array.from({ length: 8 }, (_, i) => session(`f${i}`, { parentSessionId: "root", modified: minute(40 - i) })),
    session("later", { modified: minute(1) }),
  ];
  const model = buildSidebarModel(input({ sessions }));
  assert.equal(treeIds(model).length, 5);
  assert.equal(row(model, `more:${APP}`).hidden, 5);
});

test("a flagged fork child keeps its ancestors visible", () => {
  const sessions = [
    ...Array.from({ length: 10 }, (_, i) => session(`r${i}`, { modified: minute(100 - i) })),
    session("child", { parentSessionId: "r9", modified: minute(1) }),
  ];
  const model = buildSidebarModel(input({ sessions, running: new Set(["child"]) }));
  assert.deepEqual(treeIds(model).slice(-2), ["r9", "child"]);
});

// ---- Active and pinned sections ------------------------------------------------

test("the Active section lists attention sessions newest first, across workspaces, ahead of the workspaces", () => {
  const model = buildSidebarModel(
    twoWorkspaces({
      running: new Set(["a1"]),
      waiting: new Set(["b1"]),
      unread: new Set(["b2"]),
      exited: new Map([["a2", exited("a2")]]),
      recentlyCompleted: new Set(["b1"]),
    }),
  );
  assert.equal(model.rows[0].kind, "section");
  assert.deepEqual(model.rows[0], { kind: "section", key: "section:active", section: "active", count: 4, collapsed: false, collapsible: true });
  const active = sessionRows(model, "active");
  assert.deepEqual(active.map((r) => r.sessionId), ["b2", "b1", "a2", "a1"]);
  assert.deepEqual(active.map((r) => r.status), ["unread", "waiting", "exited", "running"]);
  assert.deepEqual(active.map((r) => r.workspaceLabel), ["api", "api", "app", "app"]);
  assert.ok(active.every((r) => r.depth === 0 && r.snippet === undefined));
  assert.equal(model.rows.findIndex((r) => r.key === "section:workspaces") > 4, true);
});

test("Active and Pinned are omitted when empty; idle or merely completed sessions do not qualify", () => {
  const model = buildSidebarModel(twoWorkspaces({ recentlyCompleted: new Set(["a1"]) }));
  assert.equal(model.rows.some((r) => r.kind === "section" && r.section !== "workspaces"), false);
});

test("a session in Active and in its workspace gets distinct keys; the index prefers the workspace row", () => {
  const model = buildSidebarModel(input({ sessions: workspaceSessions(APP, 3), running: new Set(["s2"]) }));
  const all = sessionRows(model).filter((r) => r.sessionId === "s2");
  assert.deepEqual(all.map((r) => r.key), ["active:s2", `ws:${APP}:s2`]);
  assert.equal(new Set(keys(model)).size, model.rows.length);
  assert.equal(model.rows[model.sessionRowIndex.get("s2")].key, `ws:${APP}:s2`);
});

test("the index points at the flat row when the session is not in an open workspace", () => {
  const model = buildSidebarModel(twoWorkspaces({ running: new Set(["b1"]) }));
  assert.equal(model.rows[model.sessionRowIndex.get("b1")].key, "active:b1");
  assert.equal(model.rows[model.groupRowIndex.get(API)].key, `group:${API}`);
});

test("Active caps at the default size with a more row and grows with show more", () => {
  const sessions = workspaceSessions(APP, 10);
  const running = new Set(sessions.map((s) => s.id));
  const model = buildSidebarModel(input({ sessions, running }));
  assert.equal(sessionRows(model, "active").length, SECTION_BASE_ROWS);
  assert.equal(SECTION_BASE_ROWS, 6);
  const more = row(model, `more:${sectionExtraRowsKey("active")}`);
  assert.deepEqual([more.projectKey, more.hidden, more.canCollapse], ["section:active", 4, false]);
  assert.equal(row(model, "section:active").count, 10);

  const opened = buildSidebarModel(input({ sessions, running, ui: showMore(createDefaultSidebarUiState(), "section:active") }));
  assert.equal(sessionRows(opened, "active").length, 10);
  const collapsible = row(opened, "more:section:active");
  assert.deepEqual([collapsible.hidden, collapsible.canCollapse], [0, true]);
});

test("a collapsed section keeps only its header", () => {
  const model = buildSidebarModel(input({ sessions: workspaceSessions(APP, 3), running: new Set(["s1"]), ui: toggleSection(createDefaultSidebarUiState(), "active") }));
  assert.deepEqual(row(model, "section:active"), { kind: "section", key: "section:active", section: "active", count: 1, collapsed: true, collapsible: true });
  assert.equal(sessionRows(model, "active").length, 0);
});

test("Pinned follows pinnedSessionIds order, skips unknown and duplicate ids and flags pinned rows everywhere", () => {
  const model = buildSidebarModel(
    twoWorkspaces({ pinnedSessionIds: ["b1", "ghost", "a2", "b1"] }),
  );
  const pinned = sessionRows(model, "pinned");
  assert.deepEqual(pinned.map((r) => r.sessionId), ["b1", "a2"]);
  assert.equal(row(model, "section:pinned").count, 2);
  assert.ok(pinned.every((r) => r.pinned));
  assert.equal(row(model, `ws:${APP}:a2`).pinned, true);
  assert.equal(row(model, `ws:${APP}:a1`).pinned, false);
});

test("Pinned sections are not affected by the running-only filter or by folded workspaces", () => {
  const model = buildSidebarModel(
    twoWorkspaces({ pinnedSessionIds: ["b1"], ui: setRunningOnly(createDefaultSidebarUiState(), true) }),
  );
  assert.deepEqual(sessionRows(model, "pinned").map((r) => r.sessionId), ["b1"]);
});

// ---- Row content ------------------------------------------------------------------

test("session rows carry status precedence, title, timestamp, branch and selection", () => {
  const sessions = [
    session("w", { name: "Named run", modified: minute(1), lastMessageAt: minute(9), worktreeBranch: "feat/x" }),
    session("r", { modified: minute(2) }),
    session("e", { modified: minute(3) }),
    session("u", { modified: minute(4) }),
    session("c", { modified: minute(5) }),
    session("i", { modified: minute(6), name: undefined, firstMessage: "(no messages)" }),
  ];
  const model = buildSidebarModel(
    input({
      sessions,
      waiting: new Set(["w", "r"]),
      running: new Set(["r", "w", "e"]),
      exited: new Map([["e", exited("e")], ["u", exited("u")]]),
      unread: new Set(["u", "c"]),
      recentlyCompleted: new Set(["c", "i"]),
      selectedSessionId: "c",
    }),
  );
  const byId = Object.fromEntries(sessionRows(model, "tree").map((r) => [r.sessionId, r]));
  assert.deepEqual(Object.fromEntries(Object.entries(byId).map(([id, r]) => [id, r.status])), {
    w: "waiting",
    r: "waiting",
    e: "running",
    u: "exited",
    c: "unread",
    i: "completed",
  });
  assert.equal(byId.w.title, "Named run");
  assert.equal(byId.w.timestamp, minute(9), "lastMessageAt wins over modified");
  assert.equal(byId.r.timestamp, minute(2));
  assert.equal(byId.w.worktreeBranch, "feat/x");
  assert.equal(byId.i.title, "i");
  assert.equal(byId.c.selected, true);
  assert.equal(byId.u.selected, false);
  assert.equal(byId.w.context, "tree");
  assert.equal(byId.w.workspaceLabel, undefined);
  assert.equal(byId.w.optimistic, false);
});

test("idle sessions have the idle status", () => {
  const model = buildSidebarModel(input({ sessions: workspaceSessions(APP, 1) }));
  assert.equal(sessionRows(model, "tree")[0].status, "idle");
});

// ---- Running-only filter ---------------------------------------------------------------

test("running-only keeps running sessions plus the most recent completed ones, and drops empty workspaces", () => {
  const ui = { ...setRunningOnly(createDefaultSidebarUiState(), true), recentRunsLimit: 2 };
  const model = buildSidebarModel(
    twoWorkspaces({
      sessions: [...workspaceSessions(APP, 4, "a"), ...workspaceSessions(API, 3, "b")],
      running: new Set(["a1"]),
      ui,
      selectedProjectKey: APP,
    }),
  );
  // Newest non-running by modified: a4 (minute 4), then a3 and b3 tie at minute 3 and the earlier listed wins.
  assert.deepEqual(treeIds(model), ["a4", "a3", "a1"]);
  assert.equal(row(model, `group:${API}`), undefined, "no session of this workspace matches");
  assert.equal(row(model, "section:workspaces").count, 1);
});

test("running-only never counts running sessions against the recent limit and skips empty sessions", () => {
  const sessions = [
    session("run", { modified: minute(9) }),
    session("empty", { modified: minute(8), firstMessage: "(no messages)", messageCount: 0, name: undefined }),
    session("old", { modified: minute(1) }),
    session("seen", { modified: minute(2), firstMessage: "(no messages)", messageCount: 0, name: undefined }),
  ];
  const ui = { ...setRunningOnly(createDefaultSidebarUiState(), true), recentRunsLimit: 2 };
  const model = buildSidebarModel(input({ sessions, running: new Set(["run"]), recentlyCompleted: new Set(["seen"]), ui }));
  assert.deepEqual(treeIds(model), ["run", "seen", "old"]);
});

test("running-only with nothing matching shows no-matches under the workspaces header", () => {
  const model = buildSidebarModel(input({ sessions: [], ui: setRunningOnly(createDefaultSidebarUiState(), true) }));
  assert.deepEqual(keys(model), ["section:workspaces", "placeholder:no-matches"]);
});

// ---- Search mode --------------------------------------------------------------------------

test("search mode replaces sections and groups by a flat ranked list", () => {
  const model = buildSidebarModel(
    twoWorkspaces({
      running: new Set(["a1"]),
      pinnedSessionIds: ["b1"],
      search: {
        query: "x",
        searching: false,
        hits: [
          { sessionId: "b2", score: 9, snippet: "…match…" },
          { sessionId: "a1", score: 5, snippet: undefined },
          { sessionId: "ghost", score: 4, snippet: undefined },
          { sessionId: "b2", score: 3, snippet: "dup" },
        ],
      },
    }),
  );
  assert.deepEqual(keys(model), ["search:b2", "search:a1"]);
  const [first, second] = model.rows;
  assert.deepEqual([first.context, first.workspaceLabel, first.snippet, first.depth], ["search", "api", "…match…", 0]);
  assert.deepEqual([second.status, second.snippet], ["running", undefined]);
  assert.equal(model.groupRowIndex.size, 0);
  assert.equal(model.sessionRowIndex.get("a1"), 1);
});

test("search mode shows no-matches when nothing matched and searching while the stream runs", () => {
  const none = buildSidebarModel(twoWorkspaces({ search: { query: "zzz", hits: [], searching: false } }));
  assert.deepEqual(keys(none), ["placeholder:no-matches"]);

  const streaming = buildSidebarModel(twoWorkspaces({ search: { query: "zzz", hits: [], searching: true } }));
  assert.deepEqual(keys(streaming), ["placeholder:searching"]);

  const partial = buildSidebarModel(twoWorkspaces({ search: { query: "a", hits: [{ sessionId: "a1", score: 1, snippet: undefined }], searching: true } }));
  assert.deepEqual(keys(partial), ["search:a1", "placeholder:searching"]);
});

test("search results ignore the running-only filter and the expansion state", () => {
  const model = buildSidebarModel(
    twoWorkspaces({
      ui: setRunningOnly(createDefaultSidebarUiState(), true),
      search: { query: "b", hits: [{ sessionId: "b1", score: 1, snippet: undefined }], searching: false },
    }),
  );
  assert.deepEqual(keys(model), ["search:b1"]);
});

// ---- Optimistic and live sessions ----------------------------------------------------------

test("the optimistic session appears in its registered workspace flagged optimistic", () => {
  const optimistic = session("new", { path: "", cwd: APP, projectRoot: undefined, projectKey: undefined, modified: minute(99), firstMessage: "" });
  const model = buildSidebarModel(input({ sessions: workspaceSessions(APP, 2), optimisticSession: optimistic, running: new Set(["new"]) }));
  const rows = sessionRows(model, "tree");
  assert.equal(rows[0].sessionId, "new");
  assert.equal(rows[0].optimistic, true);
  assert.equal(rows[0].projectKey, APP);
  assert.equal(rows[0].title, "new");
  assert.ok(sessionRows(model, "active").some((r) => r.sessionId === "new" && r.optimistic));
  assert.equal(rows.filter((r) => !r.optimistic).length, 2);
});

test("an optimistic session in an unregistered directory creates its workspace", () => {
  const optimistic = session("new", { path: "", cwd: "/elsewhere/proj", projectRoot: undefined, projectKey: undefined });
  const model = buildSidebarModel(input({ optimisticSession: optimistic, selectedProjectKey: "/elsewhere/proj" }));
  const group = row(model, "group:/elsewhere/proj");
  assert.ok(group);
  assert.equal(group.label, "proj");
  assert.equal(group.counts.total, 1);
  assert.deepEqual(treeIds(model), ["new"]);
});

test("an optimistic session on a Windows cwd lands in the registered workspace with its casing", () => {
  const optimistic = session("new", { path: "", cwd: "c:\\WORK\\app", projectRoot: undefined, projectKey: undefined });
  const model = buildSidebarModel(input({ projects: [{ path: "C:\\Work\\App" }], optimisticSession: optimistic, selectedProjectKey: "C:\\Work\\App" }));
  assert.equal(model.rows.filter((r) => r.kind === "group").length, 1);
  assert.equal(row(model, "group:c:/work/app").path, "C:\\Work\\App");
  assert.deepEqual(treeIds(model), ["new"]);
});

test("the optimistic session is dropped once the server lists the same id", () => {
  const listed = session("new", { modified: minute(3) });
  const optimistic = session("new", { path: "", firstMessage: "" });
  const model = buildSidebarModel(input({ sessions: [listed], optimisticSession: optimistic }));
  const rows = sessionRows(model, "tree");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].optimistic, false);
});

test("a running session without a JSONL still shows, using its hint, the selected workspace as fallback, or nothing without a place", () => {
  const withHint = buildSidebarModel(
    twoWorkspaces({ running: new Set(["live"]), selectedProjectKey: APP }),
    { liveHints: new Map([["live", { cwd: API, since: minute(77) }]]) },
  );
  const live = row(withHint, `ws:${API}:live`) ?? row(withHint, "active:live");
  assert.ok(live);
  assert.equal(live.projectKey, API);
  assert.equal(live.status, "running");
  assert.equal(live.optimistic, true);
  assert.equal(live.timestamp, minute(77));
  assert.equal(row(withHint, `group:${API}`).counts.total, 3);

  const fallback = buildSidebarModel(twoWorkspaces({ running: new Set(["live"]), selectedProjectKey: API }));
  assert.equal(row(fallback, "active:live").projectKey, API);
  assert.equal(row(fallback, "active:live").timestamp, LIVE_PLACEHOLDER_TIMESTAMP);
  assert.equal(fallback.rows.findIndex((r) => r.key === "active:live"), 1, "live placeholders sort first");

  const homeless = buildSidebarModel(twoWorkspaces({ running: new Set(["live"]), selectedProjectKey: null }));
  assert.equal(row(homeless, "active:live"), undefined);
});

test("an exited session without a JSONL is placed by the cwd of its exit record", () => {
  const model = buildSidebarModel(twoWorkspaces({ exited: new Map([["dead", exited("dead", API)]]) }));
  const dead = row(model, "active:dead");
  assert.equal(dead.status, "exited");
  assert.equal(dead.projectKey, API);
  assert.equal(row(model, `group:${API}`).counts.exited, 1);
});

test("a live session in an unregistered directory adds its workspace", () => {
  const model = buildSidebarModel(input({ running: new Set(["live"]) }), { liveHints: new Map([["live", { cwd: "/tmp/scratch" }]]) });
  assert.ok(row(model, "group:/tmp/scratch"));
  assert.equal(row(model, "active:live").projectKey, "/tmp/scratch");
});

// ---- Invariants ------------------------------------------------------------------------------

test("every row key is unique and the indexes point at matching rows", () => {
  const model = buildSidebarModel(
    twoWorkspaces({
      sessions: [...forkFixture(), ...workspaceSessions(API, 30, "b")],
      projects: [{ path: APP }, { path: API }],
      running: new Set(["fork", "b3"]),
      unread: new Set(["other"]),
      pinnedSessionIds: ["root", "b3"],
      ui: toggleProject(createDefaultSidebarUiState(), API, false),
      selectedSessionId: "grand",
    }),
  );
  assert.equal(new Set(keys(model)).size, model.rows.length);
  for (const [id, index] of model.sessionRowIndex) {
    const target = model.rows[index];
    assert.equal(target.kind, "session");
    assert.equal(target.sessionId, id);
  }
  for (const [projectKey, index] of model.groupRowIndex) {
    const target = model.rows[index];
    assert.equal(target.kind, "group");
    assert.equal(target.projectKey, projectKey);
  }
  assert.equal(model.rows[model.sessionRowIndex.get("root")].context, "tree");
});

test("the model does not mutate or retain its inputs", () => {
  const sessions = Object.freeze(workspaceSessions(APP, 8).map((s) => Object.freeze(s)));
  const projects = Object.freeze([Object.freeze({ path: APP })]);
  const optimistic = Object.freeze(session("new", { path: "", projectRoot: undefined, projectKey: undefined }));
  const args = input({
    sessions,
    projects,
    optimisticSession: optimistic,
    running: new Set(["s2", "live"]),
    pinnedSessionIds: Object.freeze(["s3"]),
    ui: createDefaultSidebarUiState(),
  });
  const snapshot = JSON.stringify(sessions);
  assert.doesNotThrow(() => buildSidebarModel(args, { liveHints: new Map([["live", { cwd: APP }]]) }));
  assert.equal(JSON.stringify(sessions), snapshot);
  assert.equal(projects.length, 1);
  assert.equal(args.sessions, sessions);
});

test("the same input produces the same rows", () => {
  const args = twoWorkspaces({ running: new Set(["a1", "b2"]), unread: new Set(["a2"]) });
  assert.deepEqual(buildSidebarModel(args).rows, buildSidebarModel(args).rows);
});

// ---- Performance --------------------------------------------------------------------------------

test("5000 sessions across 100 workspaces build in a few milliseconds", () => {
  const projects = [];
  const sessions = [];
  const running = new Set();
  const unread = new Set();
  for (let w = 0; w < 100; w++) {
    const root = `/work/project-${String(w).padStart(3, "0")}`;
    projects.push({ path: root, sortOrder: w });
    for (let i = 0; i < 50; i++) {
      const id = `w${w}-s${i}`;
      sessions.push(session(id, { cwd: root, projectRoot: root, projectKey: root, modified: minute(w * 50 + i), parentSessionId: i % 7 === 3 ? `w${w}-s${i - 1}` : undefined }));
      if (i === 10 && w % 5 === 0) running.add(id);
      if (i === 20 && w % 9 === 0) unread.add(id);
    }
  }
  const ui = toggleProject(toggleProject(createDefaultSidebarUiState(), "/work/project-001", false), "/work/project-002", false);
  const build = () => buildSidebarModel(input({ sessions, projects, running, unread, selectedProjectKey: "/work/project-000", ui }));
  build();
  let best = Infinity;
  for (let run = 0; run < 5; run++) {
    const start = performance.now();
    const model = build();
    best = Math.min(best, performance.now() - start);
    assert.ok(model.rows.length < 400);
  }
  assert.ok(best < 150, `build took ${best.toFixed(1)} ms`);
});

test("one workspace with thousands of sessions only emits the watermark rows", () => {
  const sessions = workspaceSessions(APP, 5000);
  const start = performance.now();
  const model = buildSidebarModel(input({ sessions, running: new Set(["s4990"]) }));
  const elapsed = performance.now() - start;
  assert.equal(treeIds(model).length, 11);
  assert.equal(row(model, `more:${APP}`).hidden, 4989);
  assert.ok(elapsed < 150, `build took ${elapsed.toFixed(1)} ms`);
});
