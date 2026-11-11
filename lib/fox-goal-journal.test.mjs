import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const { readFoxGoalJournal } = await createJiti(import.meta.url).import("./fox-goal-journal.ts");
function setup(t) { const dir = mkdtempSync(join(tmpdir(), "fox-goal-journal-")); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function put(file, header, entries = []) { writeFileSync(file, [header, ...entries].map((v) => JSON.stringify(v)).join("\n") + "\n"); }
const header = (id, extra = {}) => ({ type: "session", id, version: 3, cwd: "/project", ...extra });

test("complete native family includes revocation outside a rewound continuation", async (t) => {
  const dir = setup(t), original = join(dir, "original.jsonl"), continued = join(dir, "continued.jsonl");
  put(original, header("original"), [{ type: "custom", id: "revoke", customType: "fox-goal", timestamp: "2026-11-11T11:00:00Z", data: { op: "control", action: "revoke" } }]);
  put(continued, header("continued", { continuationOf: "original", parentSession: "original" }), [{ type: "custom", id: "admission", customType: "fox-goal", timestamp: "2026-11-11T10:00:00Z", data: { op: "admit" } }]);
  const journal = await readFoxGoalJournal(continued);
  assert.deepEqual(new Set(journal.sessionIds), new Set(["original", "continued"]));
  assert.deepEqual(new Set(journal.entries.map((e) => e.id)), new Set(["admission", "revoke"]));
});

test("a malformed sibling header cannot be silently omitted from authority", async (t) => {
  const dir = setup(t), file = join(dir, "original.jsonl");
  put(file, header("original"));
  writeFileSync(join(dir, "possibly-revoked.jsonl"), "broken\n");
  await assert.rejects(readFoxGoalJournal(file));
});

test("truncated or malformed authority records fail closed", async (t) => {
  const dir = setup(t), file = join(dir, "original.jsonl");
  for (const suffix of ["{\"type\":\"custom\"", "broken\n"]) {
    writeFileSync(file, JSON.stringify(header("original")) + "\n" + suffix);
    await assert.rejects(readFoxGoalJournal(file));
  }
});

test("duplicate identity and missing continuation parents fail closed", async (t) => {
  const dir = setup(t), file = join(dir, "original.jsonl"), other = join(dir, "other.jsonl");
  put(file, header("original"));
  put(other, header("original"));
  await assert.rejects(readFoxGoalJournal(file), /ambiguous/);
  put(other, header("other", { continuationOf: "missing", parentSession: "missing" }));
  await assert.rejects(readFoxGoalJournal(file), /parent/);
});

test("native fixed title slot is accepted without treating it as authority", async (t) => {
  const dir = setup(t), file = join(dir, "original.jsonl");
  writeFileSync(file, [JSON.stringify({ type: "title", v: 1, title: "FOX", source: "user", pad: "" }), JSON.stringify(header("original")), ""].join("\n"));
  assert.deepEqual((await readFoxGoalJournal(file)).entries, []);
});

test("a verified fork excludes copied parent authority without deleting its branch ancestry", async (t) => {
  const dir = setup(t), parent = join(dir, "parent.jsonl"), fork = join(dir, "fork.jsonl");
  const source = [
    { type: "message", id: "request", parentId: null, message: { role: "user", content: "Do work" } },
    { type: "custom", id: "old-consent", parentId: "request", customType: "fox-goal", data: { version: 1, op: "consent", sessionId: "parent" } },
    { type: "mode_change", id: "old-mode", parentId: "old-consent", mode: "goal", data: { goal: { id: "old-goal" } } },
  ];
  put(parent, header("parent"), source);
  const own = { type: "custom", id: "new-consent", parentId: "old-mode", customType: "fox-goal", data: { version: 1, op: "consent", sessionId: "fork" } };
  put(fork, header("fork", { parentSession: parent }), [...source, own]);
  const result = await readFoxGoalJournal(fork);
  assert.deepEqual(result.ignoredEntryIds, ["old-consent", "old-mode"]);
  assert.deepEqual(result.inheritedGoalIds, ["old-goal"]);
  assert.deepEqual(result.entries.map((entry) => entry.id), ["request", "new-consent"]);
  assert.deepEqual(result.currentEntries.map((entry) => entry.id), ["request", "old-consent", "old-mode", "new-consent"]);
});

test("a fork cannot hide changed parent authority behind a copied entry identity", async (t) => {
  const dir = setup(t), parent = join(dir, "parent.jsonl"), fork = join(dir, "fork.jsonl");
  const consent = { type: "custom", id: "consent", parentId: null, customType: "fox-goal", data: { version: 1, op: "consent", sessionId: "parent" } };
  put(parent, header("parent"), [consent]);
  put(fork, header("fork", { parentSession: parent }), [{ ...consent, data: { ...consent.data, sessionId: "fork" } }]);
  await assert.rejects(readFoxGoalJournal(fork), /copied|fork/i);
});

test("native continuation still carries its own family revocation and never becomes a fresh fork", async (t) => {
  const dir = setup(t), parent = join(dir, "parent.jsonl"), next = join(dir, "next.jsonl");
  const revoke = { type: "custom", id: "revoked", parentId: null, customType: "fox-goal", data: { version: 1, op: "control", action: "revoke", sessionId: "parent" } };
  put(parent, header("parent"), [revoke]);
  put(next, header("next", { parentSession: parent, continuationOf: "parent" }), [revoke]);
  const result = await readFoxGoalJournal(next);
  assert.deepEqual(result.ignoredEntryIds, []);
  assert.equal(result.entries.filter((entry) => entry.id === "revoked").length, 2);
});
