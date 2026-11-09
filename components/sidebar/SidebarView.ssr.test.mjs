import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { createJiti } from "jiti";
import { group, more, placeholder, section, session, viewProps } from "./test-fixtures.mjs";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { SidebarView } = await jiti.import("./SidebarView.tsx");

function render(props) {
  const html = renderToStaticMarkup(React.createElement(SidebarView, viewProps(props)));
  return new JSDOM(html).window.document;
}

const items = (document) => Array.from(document.querySelectorAll('[role="treeitem"]'));

test("tree items carry level, position and set size for windowed rows", () => {
  const rows = [
    section("active", { count: 1 }),
    session("a", { context: "active", status: "waiting" }),
    section("workspaces", { collapsible: false }),
    group("one", { selected: true }),
    session("root1", { selected: true, hasChildren: true, expanded: true }),
    session("fork1", { depth: 1 }),
    session("root2"),
    more(),
    group("two", { expanded: false }),
    placeholder("empty-workspace"),
  ];
  const document = render({ rows, selectedRowIndex: 4 });
  const treeitems = items(document);
  assert.equal(treeitems.length, rows.length - 1, "placeholders are not tree items");

  const shape = treeitems.map((item) => [
    item.getAttribute("aria-level"),
    item.getAttribute("aria-posinset"),
    item.getAttribute("aria-setsize"),
    item.getAttribute("aria-expanded"),
    item.getAttribute("aria-selected"),
  ]);
  assert.deepEqual(shape, [
    ["1", "1", "4", "true", null], // active section (collapsible, open)
    ["2", "1", "1", null, "false"], // flat active session
    ["1", "2", "4", null, null], // workspaces section: not collapsible
    ["1", "3", "4", "true", "true"], // group "one"
    ["2", "1", "3", "true", "true"], // root session with open forks
    ["3", "1", "1", null, "false"], // fork
    ["2", "2", "3", null, "false"],
    ["2", "3", "3", null, null], // "show more" row
    ["1", "4", "4", "false", "false"], // group "two", folded
  ]);
  assert.equal(treeitems[3].getAttribute("data-row-index"), "3");
});

test("exactly one tree item is the roving tab stop, and it is the open session", () => {
  const rows = [group("one"), session("a"), session("b", { selected: true }), session("c")];
  const document = render({ rows, selectedRowIndex: 2 });
  const stops = items(document).filter((item) => item.tabIndex === 0);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].getAttribute("data-row-index"), "2");

  const fallback = render({ rows: [placeholder("loading"), group("one"), session("a")], selectedRowIndex: null });
  const [first] = items(fallback).filter((item) => item.tabIndex === 0);
  assert.equal(first.getAttribute("data-row-index"), "1", "first navigable row when nothing is open");
});

test("each status gets its own labelled seat; idle sessions get none", () => {
  const labels = {
    waiting: "Waiting for your input",
    running: "Agent running",
    exited: "Agent process exited unexpectedly",
    unread: "New session activity",
    completed: "Recently completed",
  };
  for (const [status, label] of Object.entries(labels)) {
    const document = render({ rows: [session(status, { status })] });
    const seats = document.querySelectorAll('[role="treeitem"] [role="img"]');
    assert.equal(seats.length, 1, status);
    assert.equal(seats[0].getAttribute("aria-label"), label, status);
  }
  const idle = render({ rows: [session("idle", { status: "idle" })] });
  assert.equal(idle.querySelectorAll('[role="treeitem"] [role="img"]').length, 0);
});

test("a saved session is a real link; an in-memory placeholder is not and has no actions", () => {
  const saved = render({ rows: [session("s 1")] });
  const link = saved.querySelector('[role="treeitem"] a');
  assert.equal(link.getAttribute("href"), "/?session=s%201");
  assert.ok(saved.querySelector('button[aria-label="Session actions"]'));

  const draft = render({ rows: [session("draft", { optimistic: true })] });
  assert.equal(draft.querySelector('[role="treeitem"] a'), null);
  assert.equal(draft.querySelector('button[aria-label="Session actions"]'), null);
  assert.ok(draft.querySelector("button[aria-current], [role=treeitem] button"), "still a button to open it");
});

test("session rows show relative time, waiting text, chips and snippet", () => {
  const document = render({
    rows: [
      session("old", { timestamp: new Date(Date.now() - 3 * 86_400_000 - 600_000).toISOString() }),
      session("ask", { status: "waiting" }),
      session("hit", { context: "search", workspaceLabel: "api", worktreeBranch: "feat/x", snippet: "…the matching text…" }),
    ],
  });
  const [old, ask, hit] = items(document);
  assert.equal(old.querySelector("time").textContent, "3d");
  assert.equal(ask.querySelector("time").textContent, "Waiting");
  assert.match(hit.textContent, /api/);
  assert.match(hit.textContent, /feat\/x/);
  assert.match(hit.textContent, /the matching text/);
  assert.equal(hit.querySelectorAll("time").length, 1);
});

test("touch density keeps the menu button visible and moves the time into the row text", () => {
  const rows = [session("a", { pinned: true })];
  const touch = render({ rows, density: "touch" });
  const row = items(touch)[0];
  assert.ok(row.querySelector('button[aria-label="Session actions"]'));
  assert.equal(row.querySelector('button[aria-label="Unpin"]'), null, "no hover-only pin button on touch");
  assert.equal(row.querySelectorAll("time").length, 1);
  assert.equal(row.getAttribute("data-density"), "touch");

  const desktop = render({ rows, density: "comfortable" });
  assert.ok(items(desktop)[0].querySelector('button[aria-label="Unpin"]'), "pin toggle on desktop");
});

test("group rows expose path, aggregate counts and state", () => {
  const document = render({
    rows: [
      group("api", { expanded: false, pinned: true, selected: true, counts: { total: 9, running: 2, waiting: 1, unread: 3, exited: 1 } }),
      group("idle"),
    ],
  });
  const [api, idle] = items(document);
  assert.equal(api.getAttribute("aria-expanded"), "false");
  assert.equal(api.querySelector("button[title]").getAttribute("title"), "/work/api");
  assert.equal(api.querySelector('[role="img"][aria-label^="1 waiting"]').getAttribute("aria-label"), "1 waiting, 2 running, 3 unread, 1 exited unexpectedly");
  assert.ok(api.querySelector('[role="img"][aria-label="Pinned"]'));
  assert.equal(idle.querySelector('[role="img"]'), null, "no chips without activity");
  assert.ok(api.querySelector('button[aria-label="New session here"]'));
  assert.ok(api.querySelector('button[aria-label="Project actions"]'));
});

test("section rows: collapsible ones toggle, the workspaces one carries the toolbar", () => {
  const document = render({
    rows: [section("pinned", { collapsed: true, count: 3 }), section("workspaces", { collapsible: false, count: 5 })],
  });
  const [pinned, workspaces] = items(document);
  assert.equal(pinned.getAttribute("aria-expanded"), "false");
  assert.ok(pinned.querySelector('button[aria-label="Expand Pinned"]'));
  assert.match(pinned.textContent, /Pinned/);
  assert.match(pinned.textContent, /3/);

  assert.equal(workspaces.getAttribute("aria-expanded"), null);
  for (const label of ["Sort workspaces", "Show running sessions only", "Add workspace"]) {
    assert.ok(workspaces.querySelector(`button[aria-label="${label}"]`), label);
  }
  assert.equal(pinned.querySelector('button[aria-label="Add workspace"]'), null);
});

test("more rows offer show more and show less independently", () => {
  const document = render({
    rows: [more({ hidden: 12, canCollapse: false }), more({ hidden: 0, canCollapse: true }), more({ hidden: 5, canCollapse: true })],
  });
  const texts = items(document).map((item) => Array.from(item.querySelectorAll("button")).map((b) => b.textContent));
  assert.deepEqual(texts, [["Show 12 more"], ["Show less"], ["Show 5 more", "Show less"]]);
});

test("placeholders render their state, with retry / stop / add where applicable", () => {
  const document = render({
    rows: [
      placeholder("loading"),
      placeholder("error", { detail: "Boom" }),
      placeholder("error"),
      placeholder("no-workspaces"),
      placeholder("empty-workspace"),
      placeholder("no-matches"),
      placeholder("searching"),
    ],
  });
  assert.equal(items(document).length, 0, "placeholders are outside the tree-item set");
  const text = document.querySelector('[role="tree"]').textContent;
  for (const expected of ["Boom", "Could not load sessions", "No workspaces yet", "No sessions in this project", "No matching sessions", "Searching transcripts…"]) {
    assert.ok(text.includes(expected), expected);
  }
  const buttons = Array.from(document.querySelectorAll('[role="tree"] button')).map((b) => b.textContent);
  assert.deepEqual(buttons, ["Retry", "Retry", "Add workspace", "Stop"]);
  assert.ok(document.querySelector('[role="tree"] [role="status"][aria-label="Loading..."]'));
});

test("search results are announced politely; the box shows Stop while searching", () => {
  const rows = [session("a", { context: "search" }), session("b", { context: "search" })];
  const done = render({ rows, search: { query: "foo", searching: false } });
  assert.equal(done.querySelector('[role="status"][aria-live="polite"]').textContent, "2 results");
  assert.equal(done.querySelector('[role="search"] button[type="button"]:not([aria-label])'), null);

  const running = render({ rows, search: { query: "foo", searching: true } });
  assert.equal(running.querySelector('[role="status"][aria-live="polite"]').textContent, "Searching transcripts…");
  assert.ok(Array.from(running.querySelectorAll('[role="search"] button')).some((b) => b.textContent.trim() === "Stop"));

  const idle = render({ rows, search: { query: "", searching: false } });
  assert.equal(idle.querySelector('[role="status"][aria-live="polite"]').textContent, "");

  const one = render({ rows: rows.slice(0, 1), search: { query: "foo", searching: false } });
  assert.equal(one.querySelector('[role="status"][aria-live="polite"]').textContent, "1 result");
});

test("search input is controlled and offers a clear button only with text", () => {
  const empty = render({});
  assert.equal(empty.querySelector('input[aria-label="Search sessions"]').value, "");
  assert.equal(empty.querySelector('button[aria-label="Clear search"]'), null);
  const filled = render({ search: { query: "needle", searching: false } });
  assert.equal(filled.querySelector('input[aria-label="Search sessions"]').value, "needle");
  assert.ok(filled.querySelector('button[aria-label="Clear search"]'));
});

test("header and footer: navigation, close, archive count, update badge", () => {
  const navigation = { canBack: false, canForward: true, onBack() {}, onForward() {}, backShortcut: "Alt+←", forwardShortcut: "Alt+→" };
  const desktop = render({ navigation, onClose() {}, archivedCount: 4, updateAvailable: true, settingsOpen: true });
  assert.equal(desktop.querySelector('button[aria-label="Navigate back"]').disabled, true);
  assert.equal(desktop.querySelector('button[aria-label="Navigate forward"]').disabled, false);
  assert.equal(desktop.querySelector('button[aria-label="Navigate back"]').title, "Navigate back (Alt+←)");
  assert.ok(desktop.querySelector('button[aria-label="Hide sidebar"]'));
  assert.ok(desktop.querySelector('button[aria-label="More actions"][aria-haspopup="menu"][aria-expanded="false"]'));
  const archive = Array.from(desktop.querySelectorAll("footer button")).find((b) => b.textContent.includes("Archived Sessions"));
  assert.match(archive.textContent, /4/);
  assert.ok(desktop.querySelector('footer [role="status"][aria-label="Update available"]'));
  assert.equal(desktop.querySelector('footer button[aria-current="page"]').title, "Settings");

  const mobile = render({ navigation, mobile: true, density: "touch" });
  assert.equal(mobile.querySelector('button[aria-label="Navigate back"]'), null, "no back/forward in the drawer header");
  assert.equal(mobile.querySelector("nav").getAttribute("data-density"), "touch");
});

test("5000 rows mount only a window of tree items but reserve the full height", () => {
  const rows = Array.from({ length: 5000 }, (_, i) => session(`s${i}`));
  const document = render({ rows });
  const mounted = items(document).length;
  assert.ok(mounted > 10 && mounted < 60, `mounted ${mounted}`);
  assert.equal(document.querySelector('[role="tree"] > div').style.height, `${5000 * 32}px`);
  assert.equal(items(document)[0].getAttribute("aria-setsize"), "5000");
  assert.equal(items(document)[0].getAttribute("aria-posinset"), "1");
});
