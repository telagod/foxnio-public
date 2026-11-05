import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  buildSessionTree,
  flattenSessionTree,
  formatRelativeTime,
  normalizeProjectKey,
  projectLabel,
  sessionDisplayTitle,
} = await jiti.import("./session-tree.ts");

function session(id, overrides = {}) {
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd: "/work/app",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hi",
    ...overrides,
  };
}

function shape(nodes) {
  return nodes.map((node) => (node.children.length ? { id: node.session.id, children: shape(node.children) } : node.session.id));
}

test("normalizeProjectKey unifies separators and folds case only for Windows-style paths", () => {
  const cases = [
    ["/home/me/app/", "/home/me/app"],
    ["/home/me/App", "/home/me/App"],
    ["C:\\Users\\Me\\App", "c:/users/me/app"],
    ["c:/users/me/app", "c:/users/me/app"],
    ["D:/Work", "d:/work"],
    ["\\\\srv\\Share\\x", "//srv/share/x"],
    ["", ""],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeProjectKey(input), expected, input);
  assert.equal(normalizeProjectKey("C:\\Users\\Me"), normalizeProjectKey("c:/users/me/"));
});

test("projectLabel returns the final folder for / and \\ separators", () => {
  const cases = [
    ["/home/me/app", "app"],
    ["/home/me/app/", "app"],
    ["/home/me/app///", "app"],
    ["C:\\Work\\Api\\", "Api"],
    ["C:\\Work/mixed", "mixed"],
    ["C:\\", "C:"],
    ["plain", "plain"],
    ["/", ""],
    ["", ""],
  ];
  for (const [input, expected] of cases) assert.equal(projectLabel(input), expected, input);
});

test("sessionDisplayTitle prefers the name, then the first message, then the id prefix", () => {
  assert.equal(sessionDisplayTitle(session("abc", { name: "Named", firstMessage: "first" })), "Named");
  assert.equal(sessionDisplayTitle(session("abc", { firstMessage: "first line\nsecond line" })), "first line");
  assert.equal(sessionDisplayTitle(session("abc", { firstMessage: "tab\tand\u0007bell" })), "tab and bell");
  assert.equal(sessionDisplayTitle(session("0123456789abcdef", { firstMessage: "(no messages)" })), "0123456789ab");
  assert.equal(sessionDisplayTitle(session("0123456789abcdef", { firstMessage: "   " })), "0123456789ab");
  const long = sessionDisplayTitle(session("abc", { firstMessage: "x".repeat(300) }));
  assert.ok(long.length <= 81 && long.endsWith("…"));
});

test("formatRelativeTime buckets minutes, hours, days, months and years", () => {
  const now = Date.parse("2026-06-01T12:00:00.000Z");
  const ago = (ms) => new Date(now - ms).toISOString();
  const minute = 60_000;
  const cases = [
    [ago(0), "now"],
    [ago(59_999), "now"],
    [ago(minute), "1m"],
    [ago(59 * minute), "59m"],
    [ago(60 * minute), "1h"],
    [ago(23 * 60 * minute), "23h"],
    [ago(24 * 60 * minute), "1d"],
    [ago(29 * 24 * 60 * minute), "29d"],
    [ago(30 * 24 * 60 * minute), "1mo"],
    [ago(359 * 24 * 60 * minute), "11mo"],
    [ago(360 * 24 * 60 * minute), "1y"],
    [ago(-5 * minute), "now"],
  ];
  for (const [value, expected] of cases) assert.equal(formatRelativeTime(value, "en", now), expected, value);
  assert.equal(formatRelativeTime("not a date", "en", now), null);
  assert.equal(formatRelativeTime("", "en", now), null);
});

test("buildSessionTree nests forks under their parent and orders every level newest first", () => {
  const tree = buildSessionTree([
    session("old", { modified: "2026-01-01T00:00:00.000Z" }),
    session("new", { modified: "2026-01-03T00:00:00.000Z" }),
    session("fork-a", { parentSessionId: "new", modified: "2026-01-04T00:00:00.000Z" }),
    session("fork-b", { parentSessionId: "new", modified: "2026-01-05T00:00:00.000Z" }),
    session("grandchild", { parentSessionId: "fork-a", modified: "2026-01-06T00:00:00.000Z" }),
  ]);
  assert.deepEqual(shape(tree), [{ id: "new", children: ["fork-b", { id: "fork-a", children: ["grandchild"] }] }, "old"]);
});

test("buildSessionTree orders by search score before recency", () => {
  const sessions = [
    session("a", { modified: "2026-01-03T00:00:00.000Z" }),
    session("b", { modified: "2026-01-02T00:00:00.000Z" }),
    session("c", { modified: "2026-01-01T00:00:00.000Z" }),
  ];
  const tree = buildSessionTree(sessions, new Map([["c", 9], ["b", 9], ["a", 1]]));
  assert.deepEqual(shape(tree), ["b", "c", "a"]);
});

test("a fork whose parent is not in the list becomes a root", () => {
  const tree = buildSessionTree([session("orphan", { parentSessionId: "gone" }), session("root")]);
  assert.deepEqual(new Set(shape(tree)), new Set(["orphan", "root"]));
});

test("parent cycles never make sessions disappear", () => {
  const self = buildSessionTree([session("a", { parentSessionId: "a" })]);
  assert.deepEqual(shape(self), ["a"]);

  const pair = buildSessionTree([
    session("a", { parentSessionId: "b" }),
    session("b", { parentSessionId: "a" }),
  ]);
  const ids = [];
  (function walk(nodes) {
    for (const node of nodes) {
      ids.push(node.session.id);
      walk(node.children);
    }
  })(pair);
  assert.deepEqual(ids.sort(), ["a", "b"]);
  assert.equal(pair.length, 1);

  const triangle = buildSessionTree([
    session("a", { parentSessionId: "c" }),
    session("b", { parentSessionId: "a" }),
    session("c", { parentSessionId: "b" }),
    session("tail", { parentSessionId: "c" }),
  ]);
  assert.equal(triangle.length, 1);
  assert.equal(flattenSessionTree(triangle, new Set()).length, 4);
});

test("buildSessionTree orders ISO timestamps exactly like a locale comparison", () => {
  const stamps = [];
  let seed = 7;
  for (let i = 0; i < 200; i++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    stamps.push(new Date(Date.UTC(2026, 0, 1) + (seed % 1_000_000_000)).toISOString());
  }
  const tree = buildSessionTree(stamps.map((modified, i) => session(`s${i}`, { modified })));
  const actual = tree.map((node) => node.session.modified);
  const expected = [...actual].sort((a, b) => b.localeCompare(a));
  assert.deepEqual(actual, expected);
});

test("buildSessionTree does not mutate its input", () => {
  const sessions = Object.freeze([
    Object.freeze(session("a", { modified: "2026-01-01T00:00:00.000Z" })),
    Object.freeze(session("b", { modified: "2026-01-02T00:00:00.000Z", parentSessionId: "a" })),
    Object.freeze(session("c", { modified: "2026-01-03T00:00:00.000Z" })),
  ]);
  const tree = buildSessionTree(sessions);
  assert.deepEqual(sessions.map((s) => s.id), ["a", "b", "c"]);
  assert.deepEqual(shape(tree), ["c", { id: "a", children: ["b"] }]);
});

test("flattenSessionTree emits pre-order rows with depth, root index and fold state", () => {
  const tree = buildSessionTree([
    session("r1", { modified: "2026-01-03T00:00:00.000Z" }),
    session("r1-a", { parentSessionId: "r1", modified: "2026-01-03T01:00:00.000Z" }),
    session("r1-a-x", { parentSessionId: "r1-a", modified: "2026-01-03T02:00:00.000Z" }),
    session("r2", { modified: "2026-01-02T00:00:00.000Z" }),
  ]);
  const open = flattenSessionTree(tree, new Set());
  assert.deepEqual(open.map((n) => [n.session.id, n.depth, n.rootIndex, n.hasChildren, n.folded]), [
    ["r1", 0, 0, true, false],
    ["r1-a", 1, 0, true, false],
    ["r1-a-x", 2, 0, false, false],
    ["r2", 0, 1, false, false],
  ]);

  const folded = flattenSessionTree(tree, new Set(["r1"]));
  assert.deepEqual(folded.map((n) => [n.session.id, n.folded]), [["r1", true], ["r2", false]]);

  const innerFold = flattenSessionTree(tree, new Set(["r1-a", "r2"]));
  assert.deepEqual(innerFold.map((n) => n.session.id), ["r1", "r1-a", "r2"]);
  assert.equal(innerFold[2].folded, false);
});

test("deep fork chains flatten without recursion limits", () => {
  const sessions = [];
  for (let i = 0; i < 20_000; i++) {
    sessions.push(session(`s${i}`, { parentSessionId: i === 0 ? undefined : `s${i - 1}`, modified: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString() }));
  }
  const flat = flattenSessionTree(buildSessionTree(sessions), new Set());
  assert.equal(flat.length, 20_000);
  assert.equal(flat[19_999].depth, 19_999);
});
