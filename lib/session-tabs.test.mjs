import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./session-tabs.ts");
}

const tab = (id, title = id, cwd = "/repo") => ({ id, title, cwd });
const ids = (tabs) => tabs.map((item) => item.id);

test("sessionTabTitle prefers the name, then the first message, sanitized and bounded", async () => {
  const { sessionTabTitle } = await loadSubject();
  assert.equal(sessionTabTitle({ name: "  Fix login  ", firstMessage: "ignored" }), "Fix login");
  assert.equal(sessionTabTitle({ firstMessage: "line one\nline two" }), "line one");
  assert.equal(sessionTabTitle({ firstMessage: "a\tb\u0007 c" }), "a b c");
  assert.equal(sessionTabTitle({ firstMessage: "(no messages)" }), "");
  assert.equal(sessionTabTitle({}), "");
  const long = sessionTabTitle({ name: "x".repeat(200) });
  assert.equal(Array.from(long).length, 81);
  assert.ok(long.endsWith("…"));
});

test("upsertSessionTab appends new tabs and keeps position when refreshing", async () => {
  const { upsertSessionTab } = await loadSubject();
  const base = [tab("a"), tab("b")];
  assert.deepEqual(ids(upsertSessionTab(base, tab("c"))), ["a", "b", "c"]);
  const renamed = upsertSessionTab(base, tab("a", "Renamed"));
  assert.deepEqual(ids(renamed), ["a", "b"]);
  assert.equal(renamed[0].title, "Renamed");
});

test("upsertSessionTab returns the same array when nothing changes and never erases a title", async () => {
  const { upsertSessionTab } = await loadSubject();
  const base = [tab("a", "Known", "/repo")];
  assert.equal(upsertSessionTab(base, tab("a", "Known", "/repo")), base);
  assert.equal(upsertSessionTab(base, tab("a", "", "")), base);
});

test("upsertSessionTab drops the oldest tab past the cap", async () => {
  const { upsertSessionTab, MAX_SESSION_TABS } = await loadSubject();
  let tabs = [];
  for (let i = 0; i < MAX_SESSION_TABS + 3; i++) tabs = upsertSessionTab(tabs, tab(`s${i}`));
  assert.equal(tabs.length, MAX_SESSION_TABS);
  assert.equal(tabs[0].id, "s3");
  assert.equal(tabs.at(-1).id, `s${MAX_SESSION_TABS + 2}`);
});

test("closing the active tab picks the right neighbour, else the left, else nothing", async () => {
  const { closeSessionTab } = await loadSubject();
  const tabs = [tab("a"), tab("b"), tab("c")];
  const middle = closeSessionTab(tabs, "b", "b");
  assert.deepEqual(ids(middle.tabs), ["a", "c"]);
  assert.equal(middle.next?.id, "c");
  assert.equal(closeSessionTab(tabs, "c", "c").next?.id, "b");
  const only = closeSessionTab([tab("a")], "a", "a");
  assert.deepEqual(only.tabs, []);
  assert.equal(only.next, null);
});

test("closing a background tab leaves the view alone", async () => {
  const { closeSessionTab } = await loadSubject();
  const result = closeSessionTab([tab("a"), tab("b")], "a", "b");
  assert.deepEqual(ids(result.tabs), ["b"]);
  assert.equal(result.next, null);
});

test("closing an unknown tab is a no-op", async () => {
  const { closeSessionTab } = await loadSubject();
  const tabs = [tab("a")];
  const result = closeSessionTab(tabs, "zzz", "a");
  assert.equal(result.tabs, tabs);
  assert.equal(result.next, null);
});

test("removeSessionTab keeps identity when the tab is absent", async () => {
  const { removeSessionTab } = await loadSubject();
  const tabs = [tab("a"), tab("b")];
  assert.equal(removeSessionTab(tabs, "x"), tabs);
  assert.deepEqual(ids(removeSessionTab(tabs, "a")), ["b"]);
});

test("renameSessionTabId follows a moved session in place and collapses duplicates", async () => {
  const { renameSessionTabId } = await loadSubject();
  const tabs = [tab("a"), tab("old"), tab("c")];
  assert.deepEqual(ids(renameSessionTabId(tabs, "old", "new")), ["a", "new", "c"]);
  assert.equal(renameSessionTabId(tabs, "missing", "new"), tabs);
  assert.deepEqual(ids(renameSessionTabId([tab("old"), tab("a"), tab("new")], "old", "new")), ["new", "a"]);
});

test("moveSessionTab and shiftSessionTab reorder and clamp", async () => {
  const { moveSessionTab, shiftSessionTab } = await loadSubject();
  const tabs = [tab("a"), tab("b"), tab("c")];
  assert.deepEqual(ids(moveSessionTab(tabs, "a", 2)), ["b", "c", "a"]);
  assert.deepEqual(ids(moveSessionTab(tabs, "c", 0)), ["c", "a", "b"]);
  assert.deepEqual(ids(moveSessionTab(tabs, "a", 99)), ["b", "c", "a"]);
  assert.equal(moveSessionTab(tabs, "b", 1), tabs);
  assert.equal(moveSessionTab(tabs, "nope", 0), tabs);
  assert.deepEqual(ids(shiftSessionTab(tabs, "b", -1)), ["b", "a", "c"]);
  assert.equal(shiftSessionTab(tabs, "a", -1), tabs);
  assert.equal(shiftSessionTab(tabs, "c", 1), tabs);
});

test("reconcileSessionTabs refreshes titles, drops vanished sessions, keeps protected ones", async () => {
  const { reconcileSessionTabs } = await loadSubject();
  const tabs = [tab("a", "Old"), tab("gone"), tab("fresh"), tab("b", "Same", "/repo")];
  const sessions = [
    { id: "a", cwd: "/repo", name: "New name", firstMessage: "x" },
    { id: "b", cwd: "/repo", name: "Same", firstMessage: "x" },
  ];
  const next = reconcileSessionTabs(tabs, sessions, new Set(["fresh"]));
  assert.deepEqual(ids(next), ["a", "fresh", "b"]);
  assert.equal(next[0].title, "New name");
});

test("reconcileSessionTabs keeps identity when nothing changes and keeps a title the session lacks", async () => {
  const { reconcileSessionTabs } = await loadSubject();
  const tabs = [tab("a", "Title", "/repo")];
  assert.equal(reconcileSessionTabs(tabs, [{ id: "a", cwd: "/repo", name: "Title" }], new Set()), tabs);
  const untitled = reconcileSessionTabs(tabs, [{ id: "a", cwd: "/repo", firstMessage: "(no messages)" }], new Set());
  assert.equal(untitled, tabs);
});

test("mergeStoredSessionTabs puts stored order first and appends tabs opened earlier", async () => {
  const { mergeStoredSessionTabs } = await loadSubject();
  const merged = mergeStoredSessionTabs([tab("a"), tab("b")], [tab("c"), tab("a", "Fresh")]);
  assert.deepEqual(ids(merged), ["a", "b", "c"]);
  assert.equal(merged[0].title, "Fresh");
});

test("parseSessionTabs round-trips and rejects malformed storage", async () => {
  const { parseSessionTabs, serializeSessionTabs } = await loadSubject();
  const tabs = [tab("a", "One", "/x"), tab("b", "Two", "/y")];
  assert.deepEqual(parseSessionTabs(serializeSessionTabs(tabs)), tabs);
  assert.deepEqual(parseSessionTabs(null), []);
  assert.deepEqual(parseSessionTabs("not json"), []);
  assert.deepEqual(parseSessionTabs('{"id":"a"}'), []);
});

test("parseSessionTabs skips bad entries, dedupes ids, tolerates missing fields", async () => {
  const { parseSessionTabs } = await loadSubject();
  const raw = JSON.stringify([
    null,
    "str",
    { id: "" },
    { id: 5 },
    { id: "a", title: "A\nsecond line", cwd: "/x" },
    { id: "a", title: "dup" },
    { id: "b" },
    { id: "c".repeat(5000) },
  ]);
  assert.deepEqual(parseSessionTabs(raw), [
    { id: "a", title: "A", cwd: "/x" },
    { id: "b", title: "", cwd: "" },
  ]);
});

test("parseSessionTabs keeps only the newest tabs past the cap", async () => {
  const { parseSessionTabs, MAX_SESSION_TABS } = await loadSubject();
  const raw = JSON.stringify(Array.from({ length: MAX_SESSION_TABS + 2 }, (_, i) => ({ id: `s${i}` })));
  const tabs = parseSessionTabs(raw);
  assert.equal(tabs.length, MAX_SESSION_TABS);
  assert.equal(tabs[0].id, "s2");
});

test("sessionIdsWaitingForInput lists unread input notifications and their aliases", async () => {
  const { sessionIdsWaitingForInput } = await loadSubject();
  const entry = (type, sessionId, read = false, aliases) => ({ read, event: { type, sessionId, aliases } });
  const waiting = sessionIdsWaitingForInput([
    entry("input", "a"),
    entry("input", "b", true),
    entry("completed", "c"),
    entry("input", "d", false, ["d-old"]),
  ]);
  assert.deepEqual([...waiting].sort(), ["a", "d", "d-old"]);
});

test("isScrolledToBottom treats the last 96px as the bottom", async () => {
  const { isScrolledToBottom } = await loadSubject();
  assert.equal(isScrolledToBottom(900, 100, 1000), true);
  assert.equal(isScrolledToBottom(810, 100, 1000), true);
  assert.equal(isScrolledToBottom(800, 100, 1000), false);
});

test("rememberScrollAnchor stores, forgets at the bottom, and evicts the stalest", async () => {
  const { rememberScrollAnchor } = await loadSubject();
  const anchors = new Map();
  rememberScrollAnchor(anchors, "a", { messageIndex: 3, offset: -12 }, 2);
  rememberScrollAnchor(anchors, "b", { messageIndex: 1, offset: 0 }, 2);
  rememberScrollAnchor(anchors, "a", { messageIndex: 4, offset: 5 }, 2);
  rememberScrollAnchor(anchors, "c", { messageIndex: 9, offset: 1 }, 2);
  assert.deepEqual([...anchors.keys()], ["a", "c"]);
  assert.equal(anchors.get("a").messageIndex, 4);
  rememberScrollAnchor(anchors, "a", null, 2);
  assert.deepEqual([...anchors.keys()], ["c"]);
});
