import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Real /api/session-ui handlers against a throwaway agent dir.
const agentDir = mkdtempSync(join(tmpdir(), "omp-web-session-ui-route-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = agentDir;
process.env.USERPROFILE = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
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

const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const route = await jiti.import("../app/api/session-ui/route.ts");
const { loadSessionUiState, updateSessionPins, MAX_PINNED_SESSIONS } = await jiti.import("./session-ui-state.ts");
const { closeStorage } = await jiti.import("./storage/client.ts");

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const URL_ = "http://localhost/api/session-ui";
const patch = (body) => route.PATCH(new Request(URL_, {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
}));
const pinnedIds = async () => (await (await route.GET()).json()).pinned.map((entry) => entry.id);

beforeEach(async () => updateSessionPins({ unpin: (await loadSessionUiState()).pinned.map((entry) => entry.id) }));

test("GET on a fresh install lists nothing", async () => {
  const response = await route.GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { pinned: [] });
});

test("PATCH pins and answers with the updated state, newest first", async () => {
  const first = await patch({ pin: [id(1)] });
  assert.equal(first.status, 200);
  const second = await patch({ pin: [id(2)] });
  const body = await second.json();
  assert.deepEqual(body.pinned.map((entry) => entry.id), [id(2), id(1)]);
  assert.ok(body.pinned.every((entry) => Number.isFinite(entry.at)));
  assert.deepEqual(await pinnedIds(), [id(2), id(1)]);
});

test("PATCH unpin removes, and pin and unpin may arrive together", async () => {
  await patch({ pin: [id(1), id(2), id(3)] });
  assert.deepEqual((await (await patch({ unpin: [id(2)] })).json()).pinned.map((entry) => entry.id), [id(3), id(1)]);
  const both = await patch({ pin: [id(4)], unpin: [id(1)] });
  assert.deepEqual((await both.json()).pinned.map((entry) => entry.id), [id(4), id(3)]);
  assert.deepEqual(await pinnedIds(), [id(4), id(3)]);
});

test("PATCH with an empty list is accepted and changes nothing", async () => {
  await patch({ pin: [id(1)] });
  const response = await patch({ pin: [] });
  assert.equal(response.status, 200);
  assert.deepEqual(await pinnedIds(), [id(1)]);
});

test("invalid PATCH bodies return 400 and change nothing", async () => {
  await patch({ pin: [id(1)] });
  const tooMany = Array.from({ length: MAX_PINNED_SESSIONS + 1 }, (_, n) => id(n + 1));
  const invalid = [
    "{not json",
    "",
    "null",
    "[]",
    "42",
    {},
    { other: [id(2)] },
    { pin: id(2) },
    { pin: [id(2), 7] },
    { pin: ["not-a-session-id"] },
    { pin: ["../../etc/passwd"] },
    { unpin: [id(1), "x"] },
    { unpin: "all" },
    { pin: tooMany },
    { unpin: tooMany },
  ];
  for (const body of invalid) {
    const response = await patch(body);
    assert.equal(response.status, 400, typeof body === "string" ? JSON.stringify(body) : JSON.stringify(body).slice(0, 60));
    assert.equal((await response.json()).code, "invalid_session_ui_request");
  }
  assert.deepEqual(await pinnedIds(), [id(1)]);
});

test("an oversized PATCH is refused with 413 before it is parsed", async () => {
  const response = await patch({ pin: [id(2)], pad: "y".repeat(40_000) });
  assert.equal(response.status, 413);
  assert.deepEqual(await pinnedIds(), []);
});

test("a full request at the cap is accepted", async () => {
  const all = Array.from({ length: MAX_PINNED_SESSIONS }, (_, n) => id(n + 1));
  const response = await patch({ pin: all });
  assert.equal(response.status, 200);
  assert.equal((await pinnedIds()).length, MAX_PINNED_SESSIONS);
});
