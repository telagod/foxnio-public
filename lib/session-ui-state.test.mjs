import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Real module against a throwaway agent dir.
const agentDir = mkdtempSync(join(tmpdir(), "omp-web-session-ui-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const { loadSessionUiState, updateSessionPins, parseSessionUiState, sessionUiStatePath, MAX_PINNED_SESSIONS } = await jiti.import("./session-ui-state.ts");

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = (state) => state.pinned.map((entry) => entry.id);
const writeRaw = (text) => {
  mkdirSync(dirname(sessionUiStatePath()), { recursive: true });
  writeFileSync(sessionUiStatePath(), text, "utf8");
};

beforeEach(() => rmSync(sessionUiStatePath(), { force: true }));

test("the state lives under the omp-web directory of the agent dir", () => {
  assert.equal(sessionUiStatePath(), join(agentDir, "omp-web", "session-ui.json"));
});

test("a missing file is an empty state and reading never creates it", () => {
  assert.deepEqual(loadSessionUiState(), { pinned: [] });
  assert.equal(existsSync(sessionUiStatePath()), false);
});

test("pins come back newest first and survive a reload from disk", () => {
  updateSessionPins({ pin: [id(1)] }, 100);
  updateSessionPins({ pin: [id(2)] }, 200);
  const state = updateSessionPins({ pin: [id(3)] }, 300);
  assert.deepEqual(state.pinned, [{ id: id(3), at: 300 }, { id: id(2), at: 200 }, { id: id(1), at: 100 }]);
  assert.deepEqual(loadSessionUiState(), state);
  assert.deepEqual(JSON.parse(readFileSync(sessionUiStatePath(), "utf8")), state);
});

test("several ids in one change: the last one listed ends up first", () => {
  assert.deepEqual(ids(updateSessionPins({ pin: [id(1), id(2), id(3)] }, 5)), [id(3), id(2), id(1)]);
});

test("pinning an already pinned session keeps its position and time", () => {
  updateSessionPins({ pin: [id(1)] }, 100);
  updateSessionPins({ pin: [id(2)] }, 200);
  const state = updateSessionPins({ pin: [id(1)] }, 300);
  assert.deepEqual(state.pinned, [{ id: id(2), at: 200 }, { id: id(1), at: 100 }]);
});

test("unpin removes only the named sessions and ignores unknown ids", () => {
  updateSessionPins({ pin: [id(1), id(2), id(3)] }, 10);
  assert.deepEqual(ids(updateSessionPins({ unpin: [id(2), id(9)] })), [id(3), id(1)]);
});

test("unpin is applied before pin, so an id in both ends up pinned as the newest", () => {
  updateSessionPins({ pin: [id(1), id(2)] }, 10);
  const state = updateSessionPins({ pin: [id(1)], unpin: [id(1)] }, 20);
  assert.deepEqual(state.pinned, [{ id: id(1), at: 20 }, { id: id(2), at: 10 }]);
});

test("beyond the cap the oldest pins are dropped", () => {
  for (let n = 1; n <= MAX_PINNED_SESSIONS + 5; n++) updateSessionPins({ pin: [id(n)] }, n);
  const state = loadSessionUiState();
  assert.equal(state.pinned.length, MAX_PINNED_SESSIONS);
  assert.equal(state.pinned[0].id, id(MAX_PINNED_SESSIONS + 5));
  assert.equal(state.pinned.at(-1).id, id(6));
});

test("a change that alters nothing does not touch the disk", () => {
  assert.deepEqual(updateSessionPins({ pin: [], unpin: [id(1)] }), { pinned: [] });
  assert.equal(existsSync(sessionUiStatePath()), false);

  updateSessionPins({ pin: [id(1)] }, 1);
  const before = readFileSync(sessionUiStatePath(), "utf8");
  writeRaw(`${before}\n\n`);
  updateSessionPins({ pin: [id(1)] }, 99);
  assert.equal(readFileSync(sessionUiStatePath(), "utf8"), `${before}\n\n`);
});

test("corrupt or unreadable files read as empty and the next write replaces them", () => {
  for (const text of ["", "{not json", "null", "[]", '"pinned"', '{"pinned":"x"}', '{"pinned":{"0":1}}']) {
    writeRaw(text);
    assert.deepEqual(loadSessionUiState(), { pinned: [] }, JSON.stringify(text));
  }
  writeRaw("{not json");
  assert.deepEqual(ids(updateSessionPins({ pin: [id(1)] }, 1)), [id(1)]);
  assert.deepEqual(ids(loadSessionUiState()), [id(1)]);
});

test("parsing keeps well-formed entries only: valid ids, finite times, no duplicates", () => {
  const parsed = parseSessionUiState({
    pinned: [
      { id: id(1), at: 30 },
      { id: "not-a-session-id", at: 40 },
      { id: "../../etc/passwd", at: 50 },
      { id: id(2), at: Number.NaN },
      { id: id(3), at: "60" },
      { id: id(1), at: 70 },
      { id: 7, at: 80 },
      null,
      "text",
      { id: id(4), at: 10 },
    ],
  });
  assert.deepEqual(parsed.pinned, [{ id: id(1), at: 30 }, { id: id(4), at: 10 }]);
});

test("parsing orders by time, keeps stored order for equal times and applies the cap to the newest", () => {
  const unordered = { pinned: [{ id: id(1), at: 5 }, { id: id(2), at: 9 }, { id: id(3), at: 5 }, { id: id(4), at: 7 }] };
  assert.deepEqual(ids(parseSessionUiState(unordered)), [id(2), id(4), id(1), id(3)]);

  const oversized = { pinned: Array.from({ length: MAX_PINNED_SESSIONS + 10 }, (_, n) => ({ id: id(n + 1), at: n })) };
  const parsed = parseSessionUiState(oversized);
  assert.equal(parsed.pinned.length, MAX_PINNED_SESSIONS);
  assert.equal(parsed.pinned[0].at, MAX_PINNED_SESSIONS + 9);
  assert.equal(parsed.pinned.at(-1).at, 10);
});
