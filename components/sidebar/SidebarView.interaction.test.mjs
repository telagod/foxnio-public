import "../../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";
import { createActions, group, more, placeholder, section, session, viewProps } from "./test-fixtures.mjs";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { SidebarView } = await jiti.import("./SidebarView.tsx");

afterEach(cleanup);

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function mount(overrides = {}) {
  const { actions, calls } = createActions();
  const result = render(React.createElement(SidebarView, viewProps({ actions, ...overrides })));
  return { calls, ...result };
}

const treeitems = () => screen.getAllByRole("treeitem");
const rowOf = (text) => treeitems().find((item) => item.textContent.includes(text));

/** Records whether an unhandled click would have navigated, and stops jsdom from trying. */
function watchNavigation() {
  const seen = [];
  const listener = (event) => {
    seen.push(event.defaultPrevented);
    event.preventDefault();
  };
  document.addEventListener("click", listener);
  return { seen, stop: () => document.removeEventListener("click", listener) };
}

test("a plain click opens the session in place; modified clicks are left to the browser", () => {
  const { calls } = mount({ rows: [session("a")] });
  const link = screen.getByRole("link", { name: /Title a/ });
  const navigation = watchNavigation();
  try {
    fireEvent.click(link);
    assert.deepEqual(calls, [["openSession", "a"]]);
    assert.equal(navigation.seen.at(-1), true, "the plain click is handled, not followed");

    for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
      fireEvent.click(link, modifier);
      assert.equal(navigation.seen.at(-1), false, `${JSON.stringify(modifier)} stays with the browser`);
    }
    assert.equal(calls.length, 1);
  } finally {
    navigation.stop();
  }
});

test("clicks on rows call the matching action with the right arguments", () => {
  const { calls } = mount({
    rows: [
      section("pinned", { count: 1 }),
      section("workspaces", { collapsible: false }),
      group("api", { projectKey: "/w/api", path: "/w/api" }),
      session("root", { hasChildren: true, expanded: true }),
      more({ projectKey: "/w/api", hidden: 4, canCollapse: true }),
    ],
  });
  fireEvent.click(screen.getByRole("button", { name: "Collapse Pinned" }).closest("button") ?? screen.getByRole("button", { name: /Pinned/ }));
  fireEvent.click(screen.getByRole("button", { name: "Collapse api" }));
  fireEvent.click(screen.getByRole("button", { name: "New session here" }));
  fireEvent.click(screen.getByRole("button", { name: "Collapse forks" }));
  fireEvent.click(screen.getByRole("button", { name: "Show 4 more" }));
  fireEvent.click(screen.getByRole("button", { name: "Show less" }));
  fireEvent.click(screen.getByRole("button", { name: "Add workspace" }));
  assert.deepEqual(calls, [
    ["toggleSection", "pinned"],
    ["toggleGroup", "/w/api"],
    ["newSessionInWorkspace", "/w/api", "/w/api"],
    ["toggleFork", "root"],
    ["showMore", "/w/api"],
    ["showLess", "/w/api"],
    ["addWorkspace"],
  ]);
});

test("pin button toggles from the row's current state", () => {
  const { calls } = mount({ rows: [session("a"), session("b", { pinned: true })] });
  fireEvent.click(within(rowOf("Title a")).getByRole("button", { name: "Pin" }));
  fireEvent.click(within(rowOf("Title b")).getByRole("button", { name: "Unpin" }));
  assert.deepEqual(calls, [["pinSession", "a", true], ["pinSession", "b", false]]);
});

test("arrow keys move the roving focus; Home/End jump; there is always one tab stop", () => {
  mount({ rows: [section("active"), session("a", { context: "active" }), group("g"), session("b"), session("c")], selectedRowIndex: 1 });
  const stops = () => treeitems().filter((item) => item.tabIndex === 0);
  assert.equal(stops().length, 1);
  assert.match(stops()[0].textContent, /Title a/);

  act(() => stops()[0].focus());
  fireEvent.keyDown(document.activeElement, { key: "ArrowDown" });
  assert.match(document.activeElement.textContent, /^g$|g/);
  assert.equal(document.activeElement.getAttribute("data-row-index"), "2");
  assert.equal(stops().length, 1);
  assert.ok(stops()[0] === document.activeElement, "the tab stop follows focus");

  fireEvent.keyDown(document.activeElement, { key: "End" });
  assert.equal(document.activeElement.getAttribute("data-row-index"), "4");
  fireEvent.keyDown(document.activeElement, { key: "ArrowDown" });
  assert.equal(document.activeElement.getAttribute("data-row-index"), "4", "stops at the last row");
  fireEvent.keyDown(document.activeElement, { key: "Home" });
  assert.equal(document.activeElement.getAttribute("data-row-index"), "0");
  fireEvent.keyDown(document.activeElement, { key: "ArrowUp" });
  assert.equal(document.activeElement.getAttribute("data-row-index"), "0");
});

test("Left/Right fold and unfold, and walk between a row and its parent", () => {
  const { calls } = mount({
    rows: [group("open", { projectKey: "/o" }), session("child"), group("shut", { projectKey: "/s", expanded: false })],
  });
  const [open, child, shut] = treeitems();
  act(() => open.focus());
  fireEvent.keyDown(open, { key: "ArrowRight" });
  assert.ok(document.activeElement === child, "Right on an open group enters it");
  fireEvent.keyDown(child, { key: "ArrowLeft" });
  assert.ok(document.activeElement === open, "Left on a child goes to its group");
  fireEvent.keyDown(open, { key: "ArrowLeft" });
  fireEvent.keyDown(shut, { key: "ArrowRight" });
  assert.deepEqual(calls, [["toggleGroup", "/o"], ["toggleGroup", "/s"]]);
});

test("Enter, Ctrl+Enter, Space and p act on the focused row", () => {
  const { calls } = mount({ rows: [group("g", { projectKey: "/g" }), session("a"), more({ projectKey: "/g", hidden: 3 })] });
  const [groupItem, sessionItem, moreItem] = treeitems();
  fireEvent.keyDown(sessionItem, { key: "Enter" });
  fireEvent.keyDown(sessionItem, { key: "Enter", ctrlKey: true });
  fireEvent.keyDown(sessionItem, { key: "p" });
  fireEvent.keyDown(groupItem, { key: " " });
  fireEvent.keyDown(groupItem, { key: "p" });
  fireEvent.keyDown(moreItem, { key: "Enter" });
  assert.deepEqual(calls, [
    ["openSession", "a", undefined],
    ["openSession", "a", { newTab: true }],
    ["pinSession", "a", true],
    ["toggleGroup", "/g"],
    ["pinWorkspace", "/g", true],
    ["showMore", "/g"],
  ]);
});

test("Enter on a button inside a row is left to the button", () => {
  const { calls } = mount({ rows: [group("g", { projectKey: "/g" })] });
  const button = screen.getByRole("button", { name: "New session here" });
  fireEvent.keyDown(button, { key: "Enter" });
  assert.deepEqual(calls, []);
});

test("F2 renames inline: Enter commits the trimmed title, Escape cancels, focus returns to the row", async () => {
  const { calls } = mount({ rows: [session("a", { title: "Old title" })] });
  const row = treeitems()[0];
  act(() => row.focus());
  fireEvent.keyDown(row, { key: "F2" });
  const input = screen.getByRole("textbox", { name: "Rename" });
  assert.equal(input.value, "Old title");
  assert.ok(document.activeElement === input);

  fireEvent.change(input, { target: { value: "  New title  " } });
  fireEvent.keyDown(input, { key: "Enter" });
  assert.deepEqual(calls, [["renameSession", "a", "New title"]]);
  assert.equal(screen.queryByRole("textbox", { name: "Rename" }), null);
  await act(nextFrame);
  assert.ok(document.activeElement === treeitems()[0], "focus is back on the row");

  fireEvent.keyDown(treeitems()[0], { key: "F2" });
  const second = screen.getByRole("textbox", { name: "Rename" });
  fireEvent.change(second, { target: { value: "Discarded" } });
  fireEvent.keyDown(second, { key: "Escape" });
  assert.equal(screen.queryByRole("textbox", { name: "Rename" }), null);
  assert.equal(calls.length, 1, "Escape does not commit, and the blur that follows does not either");
});

test("renaming to the same or an empty title calls nothing; typing in the field does not navigate rows", () => {
  const { calls } = mount({ rows: [session("a", { title: "Same" }), session("b")] });
  act(() => treeitems()[0].focus());
  fireEvent.keyDown(treeitems()[0], { key: "F2" });
  const input = screen.getByRole("textbox", { name: "Rename" });
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "p" });
  assert.ok(document.activeElement === input);
  fireEvent.keyDown(input, { key: "Enter" });

  fireEvent.keyDown(treeitems()[0], { key: "F2" });
  const again = screen.getByRole("textbox", { name: "Rename" });
  fireEvent.change(again, { target: { value: "   " } });
  fireEvent.keyDown(again, { key: "Enter" });
  assert.deepEqual(calls, []);
});

test("blur commits a rename without pulling focus back", async () => {
  const { calls } = mount({ rows: [session("a", { title: "Before" })] });
  act(() => treeitems()[0].focus());
  fireEvent.keyDown(treeitems()[0], { key: "F2" });
  const input = screen.getByRole("textbox", { name: "Rename" });
  fireEvent.change(input, { target: { value: "After" } });
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  act(() => elsewhere.focus());
  await act(nextFrame);
  assert.deepEqual(calls, [["renameSession", "a", "After"]]);
  assert.ok(document.activeElement === elsewhere);
  elsewhere.remove();
});

test("Delete asks inline first; Cancel is focused by default and Escape backs out", async () => {
  const { calls } = mount({ rows: [session("a", { title: "Doomed" })] });
  const row = treeitems()[0];
  act(() => row.focus());
  fireEvent.keyDown(row, { key: "Delete" });
  const confirmation = screen.getByRole("group", { name: "Delete “Doomed”?" });
  assert.ok(document.activeElement === within(confirmation).getByRole("button", { name: "Cancel" }));
  assert.deepEqual(calls, []);

  fireEvent.keyDown(document.activeElement, { key: "Escape" });
  assert.equal(screen.queryByRole("group"), null);
  await act(nextFrame);
  assert.ok(document.activeElement === treeitems()[0]);

  fireEvent.keyDown(treeitems()[0], { key: "Delete" });
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  assert.deepEqual(calls, [["deleteSession", "a"]]);
});

test("placeholder sessions ignore Delete, F2, p and the menu keys", () => {
  const { calls } = mount({ rows: [session("draft", { optimistic: true })] });
  const row = treeitems()[0];
  for (const key of ["Delete", "F2", "p", "ContextMenu"]) fireEvent.keyDown(row, { key });
  fireEvent.contextMenu(row);
  assert.equal(screen.queryByRole("textbox", { name: "Rename" }), null);
  assert.equal(screen.queryByRole("group"), null);
  assert.equal(screen.queryByRole("menu"), null);
  assert.deepEqual(calls, []);
});

test("group alias is edited inline and an empty value clears it", () => {
  const { calls } = mount({ rows: [group("api", { projectKey: "/w/api", alias: "Backend" })] });
  const row = treeitems()[0];
  act(() => row.focus());
  fireEvent.keyDown(row, { key: "F2" });
  const input = screen.getByRole("textbox", { name: "Workspace display name" });
  assert.equal(input.value, "Backend");
  fireEvent.change(input, { target: { value: "" } });
  fireEvent.keyDown(input, { key: "Enter" });
  assert.deepEqual(calls, [["setWorkspaceAlias", "/w/api", ""]]);
});

test("removing a workspace needs an inline confirmation", () => {
  const { calls } = mount({ rows: [group("api", { projectKey: "/w/api" })] });
  const row = treeitems()[0];
  fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
  fireEvent.click(screen.getByRole("menuitem", { name: "Remove workspace" }));
  assert.deepEqual(calls, []);
  const confirmation = screen.getByRole("group", { name: "Remove project api" });
  fireEvent.click(within(confirmation).getByRole("button", { name: "Remove" }));
  assert.deepEqual(calls, [["removeWorkspace", "/w/api"]]);
});

test("search box: typing, Escape, clear and Stop call the search actions", () => {
  const { calls } = mount({ search: { query: "abc", searching: true } });
  const input = screen.getByRole("textbox", { name: "Search sessions" });
  fireEvent.change(input, { target: { value: "abcd" } });
  fireEvent.keyDown(input, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  fireEvent.click(within(screen.getByRole("search")).getByRole("button", { name: "Stop" }));
  assert.deepEqual(calls, [["changeSearch", "abcd"], ["changeSearch", ""], ["changeSearch", ""], ["stopSearch"]]);
});

test("Escape in an empty search box is not swallowed", () => {
  mount({});
  const input = screen.getByRole("textbox", { name: "Search sessions" });
  const seen = [];
  const listener = (event) => seen.push(event.key);
  document.addEventListener("keydown", listener);
  fireEvent.keyDown(input, { key: "Escape" });
  document.removeEventListener("keydown", listener);
  assert.deepEqual(seen, ["Escape"]);
});

test("placeholder buttons call retry, add workspace and stop", () => {
  const { calls } = mount({ rows: [placeholder("error"), placeholder("no-workspaces"), placeholder("searching")] });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  fireEvent.click(within(screen.getByRole("tree")).getByRole("button", { name: "Add workspace" }));
  fireEvent.click(within(screen.getByRole("tree")).getByRole("button", { name: "Stop" }));
  assert.deepEqual(calls, [["retry"], ["addWorkspace"], ["stopSearch"]]);
});

test("header and footer callbacks", () => {
  const events = [];
  mount({
    navigation: { canBack: true, canForward: true, onBack: () => events.push("back"), onForward: () => events.push("forward"), backShortcut: "", forwardShortcut: "" },
    onClose: () => events.push("close"),
    onOpenSettings: () => events.push("settings"),
    archivedCount: 2,
  });
  fireEvent.click(screen.getByRole("button", { name: "Navigate back" }));
  fireEvent.click(screen.getByRole("button", { name: "Navigate forward" }));
  fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
  assert.deepEqual(events, ["back", "forward", "close", "settings"]);
});

test("a long list stays windowed and keyboard focus reaches rows that were not mounted", () => {
  const rows = [group("g"), ...Array.from({ length: 4999 }, (_, i) => session(`s${i}`))];
  mount({ rows });
  assert.ok(treeitems().length < 60, `mounted ${treeitems().length}`);
  assert.equal(treeitems().filter((item) => item.tabIndex === 0).length, 1);

  act(() => treeitems()[0].focus());
  fireEvent.keyDown(document.activeElement, { key: "End" });
  assert.match(document.activeElement.textContent, /Title s4998/);
  assert.equal(document.activeElement.getAttribute("aria-posinset"), "4999");
  assert.ok(treeitems().length < 70, "the window did not grow to cover the jump");
  assert.equal(treeitems().filter((item) => item.tabIndex === 0).length, 1);

  fireEvent.keyDown(document.activeElement, { key: "ArrowUp" });
  assert.match(document.activeElement.textContent, /Title s4997/);
});
