import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { createJiti } from "jiti";

const agentDir = mkdtempSync(join(tmpdir(), "omp-web-session-ui-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = agentDir;
process.env.USERPROFILE = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { loadSessionUiState, updateSessionPins, parseSessionUiState, MAX_PINNED_SESSIONS } = await jiti.import("./session-ui-state.ts");
const { closeStorage, storageRequest } = await jiti.import("./storage/client.ts");
after(async () => {
  await closeStorage();
  for (const [key, value] of Object.entries(previousHome)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ids = (state) => state.pinned.map((entry) => entry.id);
beforeEach(async () => updateSessionPins({ unpin: ids(await loadSessionUiState()) }));

test("new installs have no pins", async () => {
  assert.deepEqual(await loadSessionUiState(), { pinned: [] });
});
test("concurrent pin commands retain every session and reload in timestamp order", async () => {
  await Promise.all([updateSessionPins({ pin: [id(1)] }, 100), updateSessionPins({ pin: [id(2)] }, 200)]);
  const state = await updateSessionPins({ pin: [id(3)] }, 300);
  assert.deepEqual(state.pinned, [{ id: id(3), at: 300 }, { id: id(2), at: 200 }, { id: id(1), at: 100 }]);
  await closeStorage();
  assert.deepEqual(await loadSessionUiState(), state);
});
test("batch pin order is last listed first and existing pins keep their time", async () => {
  await updateSessionPins({ pin: [id(1), id(2), id(3)] }, 5);
  assert.deepEqual(ids(await updateSessionPins({ pin: [id(1)] }, 99)), [id(3), id(2), id(1)]);
  assert.equal((await loadSessionUiState()).pinned.at(-1).at, 5);
});
test("unpin removes only named ids and is applied before pin", async () => {
  await updateSessionPins({ pin: [id(1), id(2), id(3)] }, 10);
  const state = await updateSessionPins({ unpin: [id(2), id(9), id(1)], pin: [id(1)] }, 20);
  assert.deepEqual(state.pinned, [{ id: id(1), at: 20 }, { id: id(3), at: 10 }]);
});
test("pins beyond the cap drop oldest entries", async () => {
  for (let n = 1; n <= MAX_PINNED_SESSIONS + 5; n++) await updateSessionPins({ pin: [id(n)] }, n);
  const state = await loadSessionUiState();
  assert.equal(state.pinned.length, MAX_PINNED_SESSIONS);
  assert.equal(state.pinned[0].id, id(MAX_PINNED_SESSIONS + 5));
  assert.equal(state.pinned.at(-1).id, id(6));
});
test("no-op commands do not advance committed revision", async () => {
  await updateSessionPins({ pin: [id(1)] }, 1);
  const before = await storageRequest({ operation: "head" });
  await updateSessionPins({ pin: [id(1)], unpin: [id(9)] }, 99);
  assert.deepEqual(await storageRequest({ operation: "head" }), before);
});
test("legacy parser drops malformed ids and duplicates and sorts timestamps", () => {
  assert.deepEqual(parseSessionUiState({ pinned: [{ id: id(1), at: 3 }, { id: id(2), at: 9 }, { id: id(1), at: 11 }, { id: "../escape", at: 1 }, { id: id(3), at: NaN }] }), { pinned: [{ id: id(2), at: 9 }, { id: id(1), at: 3 }] });
  assert.deepEqual(parseSessionUiState(null), { pinned: [] });
});
