import "../../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";
import { createActions, group, more, section, session, viewProps } from "./test-fixtures.mjs";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { SidebarView } = await jiti.import("./SidebarView.tsx");

afterEach(() => {
  mock.timers.reset();
  cleanup();
});

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function mount(overrides = {}) {
  const { actions, calls } = createActions();
  const result = render(React.createElement(SidebarView, viewProps({ actions, ...overrides })));
  return { calls, ...result };
}

const treeitems = () => screen.getAllByRole("treeitem");
const itemNames = () => Array.from(screen.getByRole("menu").querySelectorAll('[role^="menuitem"]'), (item) => item.textContent);

test("right click opens the session menu with its actions in order", () => {
  mount({ rows: [session("a")] });
  fireEvent.contextMenu(treeitems()[0], { clientX: 30, clientY: 40 });
  assert.deepEqual(itemNames(), ["Open in new tab", "Pin", "Rename", "Copy transcript", "Copy session ID", "Archive", "Delete"]);
  assert.equal(screen.getByRole("menu").getAttribute("aria-label"), "Title a");
});

test("menu items call their action, close the menu and return focus to the row", async () => {
  const { calls } = mount({ rows: [session("a", { pinned: true })] });
  const row = treeitems()[0];
  act(() => row.focus());
  fireEvent.contextMenu(row, { clientX: 5, clientY: 5 });
  const menu = screen.getByRole("menu");

  const cases = [
    ["Open in new tab", ["openSession", "a", { newTab: true }]],
    ["Unpin", ["pinSession", "a", false]],
    ["Copy transcript", ["copyTranscript", "a"]],
    ["Copy session ID", ["copySessionId", "a"]],
    ["Archive", ["archiveSession", "a"]],
  ];
  for (const [index, [name, expected]] of cases.entries()) {
    if (index > 0) fireEvent.contextMenu(treeitems()[0], { clientX: 5, clientY: 5 });
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name }));
    assert.deepEqual(calls.at(-1), expected, name);
    assert.equal(screen.queryByRole("menu"), null, `${name} closes the menu`);
  }
  assert.equal(calls.length, cases.length);
  await act(nextFrame);
  assert.ok(document.activeElement === treeitems()[0], "focus returned to the row");
  assert.ok(menu.isConnected === false);
});

test("Archive is disabled for a session with forks", () => {
  const { calls } = mount({ rows: [session("a", { hasChildren: true, expanded: true })] });
  fireEvent.contextMenu(treeitems()[0]);
  const archive = screen.getByRole("menuitem", { name: "Archive" });
  assert.equal(archive.disabled, true);
  assert.equal(archive.title, "Archive child sessions first");
  fireEvent.click(archive);
  assert.deepEqual(calls, []);
});

test("the ... button toggles the menu and reports aria-expanded", () => {
  mount({ rows: [session("a")] });
  const button = screen.getByRole("button", { name: "Session actions" });
  assert.equal(button.getAttribute("aria-expanded"), "false");
  fireEvent.click(button);
  assert.ok(screen.getByRole("menu"));
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(treeitems()[0].getAttribute("data-menu-open"), "true");
  fireEvent.pointerDown(button);
  fireEvent.click(button);
  assert.equal(screen.queryByRole("menu"), null);
  assert.equal(button.getAttribute("aria-expanded"), "false");
});

test("the menu opens on its first item; arrows wrap, Home and End jump", () => {
  mount({ rows: [session("a")] });
  fireEvent.contextMenu(treeitems()[0]);
  const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
  assert.ok(document.activeElement === items[0]);
  fireEvent.keyDown(items[0], { key: "ArrowUp" });
  assert.ok(document.activeElement === items.at(-1), "wraps to the last item");
  fireEvent.keyDown(document.activeElement, { key: "ArrowDown" });
  assert.ok(document.activeElement === items[0]);
  fireEvent.keyDown(document.activeElement, { key: "End" });
  assert.ok(document.activeElement === items.at(-1));
  fireEvent.keyDown(document.activeElement, { key: "Home" });
  assert.ok(document.activeElement === items[0]);
});

test("Escape, an outside press and Tab close the menu; Escape returns focus to the opener", async () => {
  mount({ rows: [session("a")] });
  const button = screen.getByRole("button", { name: "Session actions" });
  for (const close of [
    () => fireEvent.keyDown(document.activeElement, { key: "Escape" }),
    () => fireEvent.pointerDown(document.body),
    () => fireEvent.keyDown(document.activeElement, { key: "Tab" }),
  ]) {
    act(() => button.focus());
    fireEvent.click(button);
    assert.ok(screen.getByRole("menu"));
    close();
    assert.equal(screen.queryByRole("menu"), null);
  }
  act(() => button.focus());
  fireEvent.click(button);
  fireEvent.keyDown(document.activeElement, { key: "Escape" });
  await act(nextFrame);
  assert.ok(document.activeElement === button, "focus is back on the ... button");
});

test("scrolling the list or resizing the window closes the menu; unrelated scrolling does not", () => {
  mount({ rows: [session("a")] });
  fireEvent.contextMenu(treeitems()[0], { clientX: 5, clientY: 5 });
  const elsewhere = document.createElement("div");
  document.body.append(elsewhere);
  fireEvent.scroll(elsewhere);
  assert.ok(screen.getByRole("menu"), "a sibling scroller is not our business");
  fireEvent.scroll(screen.getByRole("tree"));
  assert.equal(screen.queryByRole("menu"), null);

  fireEvent.contextMenu(treeitems()[0], { clientX: 5, clientY: 5 });
  assert.ok(screen.getByRole("menu"));
  fireEvent(window, new window.Event("resize"));
  assert.equal(screen.queryByRole("menu"), null);
  elsewhere.remove();
});

test("the menu key and Shift+F10 open the menu from the keyboard", () => {
  mount({ rows: [session("a"), section("pinned")] });
  const [row, header] = treeitems();
  act(() => row.focus());
  fireEvent.keyDown(row, { key: "ContextMenu" });
  assert.ok(screen.getByRole("menu"));
  fireEvent.keyDown(document.activeElement, { key: "Escape" });
  fireEvent.keyDown(row, { key: "F10", shiftKey: true });
  assert.ok(screen.getByRole("menu"));
  fireEvent.keyDown(document.activeElement, { key: "Escape" });
  fireEvent.keyDown(header, { key: "ContextMenu" });
  assert.equal(screen.queryByRole("menu"), null, "section headers have no menu");
});

test("Rename from the menu focuses the inline input and keeps it", async () => {
  const { calls } = mount({ rows: [session("a", { title: "Old" })] });
  fireEvent.contextMenu(treeitems()[0]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
  const input = screen.getByRole("textbox", { name: "Rename" });
  await act(nextFrame);
  assert.ok(document.activeElement === input, "the menu's focus return must not steal focus from the input");
  fireEvent.change(input, { target: { value: "Fresh" } });
  fireEvent.keyDown(input, { key: "Enter" });
  assert.deepEqual(calls, [["renameSession", "a", "Fresh"]]);
});

test("Delete from the menu asks inline before deleting", () => {
  const { calls } = mount({ rows: [session("a")] });
  fireEvent.contextMenu(treeitems()[0]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
  assert.deepEqual(calls, []);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  assert.deepEqual(calls, [["deleteSession", "a"]]);
});

test("workspace menu: new session, alias, launch config, pin, move, remove", () => {
  const { calls } = mount({
    rows: [group("api", { projectKey: "/w/api", path: "/w/api", canMoveUp: false, canMoveDown: true })],
  });
  const open = () => fireEvent.contextMenu(treeitems()[0], { clientX: 1, clientY: 1 });
  open();
  assert.deepEqual(itemNames(), [
    "New session here",
    "Name workspace",
    "Configure OMP launch arguments",
    "Pin workspace",
    "Move up",
    "Move down",
    "Remove workspace",
  ]);
  assert.equal(screen.getByRole("menuitem", { name: "Move up" }).disabled, true);
  fireEvent.click(screen.getByRole("menuitem", { name: "New session here" }));
  open();
  fireEvent.click(screen.getByRole("menuitem", { name: "Configure OMP launch arguments" }));
  open();
  fireEvent.click(screen.getByRole("menuitem", { name: "Pin workspace" }));
  open();
  fireEvent.click(screen.getByRole("menuitem", { name: "Move down" }));
  assert.deepEqual(calls, [
    ["newSessionInWorkspace", "/w/api", "/w/api"],
    ["editLaunchConfig", "/w/api"],
    ["pinWorkspace", "/w/api", true],
    ["moveWorkspace", "/w/api", 1],
  ]);
});

test("a workspace that cannot be reordered hides the move items", () => {
  mount({ rows: [group("api", { alias: "Backend", hasLaunchConfig: true, pinned: true })] });
  fireEvent.contextMenu(treeitems()[0]);
  assert.deepEqual(itemNames(), ["New session here", "Edit workspace name", "Edit OMP launch arguments", "Unpin workspace", "Remove workspace"]);
});

test("sort menu: radio items, the current one checked", () => {
  const { calls } = mount({
    rows: [section("workspaces", { collapsible: false })],
    filters: { sortMode: "alphabetical", runningOnly: false, recentRunsLimit: 10 },
  });
  const trigger = screen.getByRole("button", { name: "Sort workspaces" });
  fireEvent.click(trigger);
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  const radios = within(screen.getByRole("menu")).getAllByRole("menuitemradio");
  assert.deepEqual(radios.map((r) => [r.textContent, r.getAttribute("aria-checked")]), [["None", "false"], ["Alphabetical", "true"], ["Last updated", "false"]]);
  fireEvent.click(radios[2]);
  assert.deepEqual(calls, [["setSortMode", "updated"]]);
});

test("filter menu: running-only checkbox and recent-run limits, including a custom one", () => {
  const { calls } = mount({
    rows: [section("workspaces", { collapsible: false })],
    filters: { sortMode: "none", runningOnly: true, recentRunsLimit: 7 },
  });
  fireEvent.click(screen.getByRole("button", { name: "Show running sessions only" }));
  const checkbox = screen.getByRole("menuitemcheckbox");
  assert.equal(checkbox.getAttribute("aria-checked"), "true");
  const limits = within(screen.getByRole("menu")).getAllByRole("menuitemradio");
  assert.deepEqual(limits.map((r) => [r.textContent, r.getAttribute("aria-checked")]), [["7", "true"], ["10", "false"], ["15", "false"], ["20", "false"]]);
  fireEvent.click(limits[2]);
  fireEvent.click(screen.getByRole("button", { name: "Show running sessions only" }));
  fireEvent.click(screen.getByRole("menuitemcheckbox"));
  assert.deepEqual(calls, [["setRecentRunsLimit", 15], ["setRunningOnly", false]]);
});

test("overflow menu: archive browser, import, refresh, sort and filter shortcuts", () => {
  const { calls } = mount({});
  const trigger = screen.getByRole("button", { name: "More actions" });
  fireEvent.click(trigger);
  assert.deepEqual(itemNames(), ["Archived Sessions", "Import session", "Refresh", "None", "Alphabetical", "Last updated", "Show running sessions only"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Import session" }));
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("menuitem", { name: "Refresh" }));
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole("menuitem", { name: "Archived Sessions" }));
  fireEvent.click(screen.getByRole("button", { name: /Archived Sessions/ }));
  assert.deepEqual(calls, [["importSession"], ["refresh"], ["openArchive"], ["openArchive"]]);
});

test("a menu whose row disappears closes itself", () => {
  const rows = [session("a"), session("b")];
  const { actions } = createActions();
  const { rerender } = render(React.createElement(SidebarView, viewProps({ actions, rows })));
  fireEvent.contextMenu(treeitems()[1]);
  assert.ok(screen.getByRole("menu"));
  rerender(React.createElement(SidebarView, viewProps({ actions, rows: rows.slice(0, 1) })));
  assert.equal(screen.queryByRole("menu"), null);
});

test("touch: the menu is a bottom sheet with focus inside, Escape closes it", async () => {
  const { calls } = mount({ rows: [session("a")], density: "touch" });
  const button = screen.getByRole("button", { name: "Session actions" });
  act(() => button.focus());
  fireEvent.click(button);
  const sheet = await screen.findByRole("dialog");
  assert.ok(within(sheet).getByRole("menu"));
  assert.deepEqual(within(sheet).getAllByRole("menuitem").map((i) => i.textContent).slice(0, 2), ["Open in new tab", "Pin"]);
  await act(nextFrame);
  assert.ok(sheet.contains(document.activeElement), "focus moved into the sheet");

  fireEvent.click(within(sheet).getByRole("menuitem", { name: "Copy session ID" }));
  assert.deepEqual(calls, [["copySessionId", "a"]]);
  assert.equal(screen.queryByRole("dialog"), null);
  await act(nextFrame);
  assert.ok(document.activeElement === button, "focus returns to the opener");

  fireEvent.click(button);
  const second = await screen.findByRole("dialog");
  fireEvent.keyDown(second, { key: "Escape" });
  await act(nextFrame);
  assert.equal(screen.queryByRole("dialog"), null);
});

/** Mount a touch sidebar with fake timers; they must be on before mounting so every timer is a fake one. */
function mountTouch(rows = [session("a")]) {
  mock.timers.enable({ apis: ["setTimeout"] });
  const result = mount({ rows, density: "touch" });
  return { ...result, link: screen.queryByRole("link") };
}

const tick = (ms) => act(() => mock.timers.tick(ms));

test("touch: a long press (500 ms) opens the sheet and swallows the click that ends it", () => {
  const { link } = mountTouch();
  const row = treeitems()[0];

  fireEvent.pointerDown(link, { pointerType: "touch", clientX: 100, clientY: 100 });
  tick(499);
  assert.equal(screen.queryByRole("dialog"), null, "not before 500 ms");
  tick(1);
  assert.ok(screen.getByRole("dialog"));
  assert.equal(row.getAttribute("data-menu-open"), "true");

  fireEvent.pointerUp(link, { pointerType: "touch" });
  assert.equal(fireEvent.click(link), false, "the click is cancelled instead of opening the session");
});

test("touch: the click that ends a long press lands on the sheet backdrop and does not dismiss it", async () => {
  const { link } = mountTouch();
  fireEvent.pointerDown(link, { pointerType: "touch", clientX: 100, clientY: 100 });
  tick(500);
  const backdrop = screen.getByRole("dialog").parentElement.querySelector(':scope > [role="presentation"]');
  assert.ok(backdrop, "the sheet has a backdrop");

  // The sheet opened under the finger, so the click some browsers send on lift hits the backdrop.
  fireEvent.pointerUp(link, { pointerType: "touch" });
  fireEvent.click(backdrop);
  await act(nextFrame);
  assert.ok(screen.queryByRole("dialog"), "the lift does not close the sheet");

  // The next deliberate tap outside still dismisses it.
  fireEvent.pointerDown(backdrop, { pointerType: "touch" });
  fireEvent.pointerUp(backdrop, { pointerType: "touch" });
  fireEvent.click(backdrop);
  await act(nextFrame);
  assert.ok(!screen.queryByRole("dialog"), "the next tap outside dismisses it");
});

test("touch: after a long press the next press is never swallowed, even when no click followed the lift", async () => {
  const { link, calls } = mountTouch([session("a"), more()]);
  fireEvent.pointerDown(link, { pointerType: "touch", clientX: 100, clientY: 100 });
  tick(500);
  const backdrop = screen.getByRole("dialog").parentElement.querySelector(':scope > [role="presentation"]');
  fireEvent.pointerUp(link, { pointerType: "touch" }); // some browsers send no click after a long press

  fireEvent.pointerDown(backdrop, { pointerType: "touch" });
  fireEvent.pointerUp(backdrop, { pointerType: "touch" });
  fireEvent.click(backdrop);
  await act(nextFrame);
  assert.ok(!screen.queryByRole("dialog"), "a tap outside dismisses the sheet");

  // "Show N more" has no menu, so no row press starts a new long press for it.
  const showMore = screen.getByRole("button", { name: /show 7 more/i });
  fireEvent.pointerDown(showMore, { pointerType: "touch" });
  fireEvent.pointerUp(showMore, { pointerType: "touch" });
  assert.equal(fireEvent.click(showMore), true, "the click is not cancelled");
  assert.deepEqual(calls.filter(([name]) => name === "showMore"), [["showMore", "/work/app"]]);
});

test("touch: a press that moves less than 8 px still counts as a long press", () => {
  const { link } = mountTouch();
  fireEvent.pointerDown(link, { pointerType: "touch", clientX: 10, clientY: 10 });
  fireEvent.pointerMove(link, { pointerType: "touch", clientX: 14, clientY: 14 });
  tick(600);
  assert.ok(screen.getByRole("dialog"), "5.7 px of travel is inside the slop");
});

test("touch: moving more than 8 px, lifting early or a browser cancel never opens the menu", () => {
  const { link, calls } = mountTouch();
  const attempts = [
    ["moved 20 px", () => fireEvent.pointerMove(link, { pointerType: "touch", clientX: 30, clientY: 10 })],
    ["lifted at 300 ms", () => { tick(300); fireEvent.pointerUp(link, { pointerType: "touch" }); }],
    ["cancelled by the browser", () => fireEvent.pointerCancel(link, { pointerType: "touch" })],
  ];
  for (const [name, interrupt] of attempts) {
    fireEvent.pointerDown(link, { pointerType: "touch", clientX: 10, clientY: 10 });
    interrupt();
    tick(600);
    assert.equal(screen.queryByRole("dialog"), null, name);
  }
  fireEvent.click(link);
  assert.deepEqual(calls, [["openSession", "a"]], "a click after an aborted press still opens the session");
});

test("touch: mouse presses and placeholder sessions do not long-press", () => {
  const { link } = mountTouch();
  fireEvent.pointerDown(link, { pointerType: "mouse", clientX: 10, clientY: 10 });
  tick(600);
  assert.equal(screen.queryByRole("dialog"), null);
  cleanup();
  mock.timers.reset();

  mountTouch([session("draft", { optimistic: true })]);
  fireEvent.pointerDown(treeitems()[0], { pointerType: "touch", clientX: 10, clientY: 10 });
  tick(600);
  assert.equal(screen.queryByRole("dialog"), null);
});
