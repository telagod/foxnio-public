import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Real GET /api/sessions against a throwaway agent dir with real session files.
const agentDir = mkdtempSync(join(tmpdir(), "omp-web-sessions-partial-"));
const projectDir = join(agentDir, "sessions", "-project");
const otherProjectDir = join(agentDir, "sessions", "-other");
mkdirSync(projectDir, { recursive: true });
mkdirSync(otherProjectDir, { recursive: true });
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = agentDir;
process.env.USERPROFILE = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
after(async () => {
  await stopSessionIndex();
  await closeStorage();
  for (const [key, value] of Object.entries(previousHome)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const route = await jiti.import("../app/api/sessions/route.ts");
const { invalidateSessionListMeta, invalidateSessionListCache } = await jiti.import("./session-reader.ts");
const { ensureSessionIndex, stopSessionIndex } = await jiti.import("./session-index.ts");
const { closeStorage } = await jiti.import("./storage/client.ts");

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cwdA = join(agentDir, "work-a");
const cwdB = join(agentDir, "work-b");
const files = new Map();

function userEntry(text) {
  return { type: "message", id: `u-${text}`, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: text } };
}

/** `age` seconds in the past orders sessions by modification time (larger = older). */
function writeSession(n, { dir = projectDir, cwd = cwdA, parentSession, age = n, text = `hello ${n}` } = {}) {
  const filePath = join(dir, `2026-01-01_${n}.jsonl`);
  const header = { type: "session", version: 3, id: id(n), cwd, timestamp: "2026-01-01T00:00:00.000Z", ...(parentSession ? { parentSession } : {}) };
  writeFileSync(filePath, `${JSON.stringify(header)}\n${JSON.stringify(userEntry(text))}\n`);
  const when = new Date(Date.now() - age * 1000);
  utimesSync(filePath, when, when);
  files.set(n, filePath);
  return filePath;
}

const get = (query = "", headers = {}) => route.GET(new Request(`http://localhost/api/sessions${query}`, { headers }));
const full = async () => (await (await get()).json()).sessions;
const partial = async (...ids) => {
  const response = await get(`?ids=${ids.join(",")}`);
  assert.equal(response.status, 200);
  return response.json();
};

const parentPath = writeSession(1, { cwd: cwdA, age: 50 });
writeSession(2, { cwd: cwdA, age: 40, parentSession: parentPath });
writeSession(3, { cwd: cwdB, dir: otherProjectDir, age: 30 });
writeSession(4, { cwd: cwdA, age: 20 });
writeSession(5, { cwd: cwdB, dir: otherProjectDir, age: 10 });

test("the partial form returns the very entries the full list has for those ids", async () => {
  const list = await full();
  const wanted = [id(2), id(4), id(3)];
  const body = await partial(...wanted);
  assert.deepEqual(body.sessions, list.filter((s) => wanted.includes(s.id)));
  assert.deepEqual(body.missing, []);
  assert.equal(body.partial, true);
  assert.ok(Array.isArray(body.runningSessionIds) && Array.isArray(body.runningSessions));
  assert.equal(body.sessions.find((s) => s.id === id(2)).parentSessionId, id(1), "parent links resolve like the list");
  assert.ok(body.sessions.every((s) => s.projectRoot && s.projectKey));
});


test("a changed file shows up in the partial answer and matches the next full list", async () => {
  await full();
  appendFileSync(files.get(4), `${JSON.stringify(userEntry("more"))}\n`);
  const later = new Date(Date.now() + 5000);
  utimesSync(files.get(4), later, later);
  await ensureSessionIndex({ force: true });
  const body = await partial(id(4));
  assert.equal(body.sessions[0].messageCount, 2);
  invalidateSessionListMeta();
  assert.deepEqual(body.sessions, (await full()).filter((s) => s.id === id(4)));
});

test("ids without a file are reported missing, whether deleted after listing or never seen", async () => {
  await full();
  unlinkSync(files.get(5));
  invalidateSessionListMeta();
  await ensureSessionIndex({ force: true });
  const never = id(999);
  const body = await partial(id(3), id(5), never);
  assert.deepEqual(body.sessions.map((s) => s.id), [id(3)]);
  assert.deepEqual([...body.missing].sort(), [id(5), never].sort());
  writeSession(5, { cwd: cwdB, dir: otherProjectDir, age: 10 });
});

test("a session created since the last listing is found, equal to its list entry", async () => {
  invalidateSessionListCache();
  writeSession(6, { cwd: cwdB, dir: otherProjectDir, age: 1 });
  await ensureSessionIndex({ force: true });
  const body = await partial(id(6));
  assert.deepEqual(body.missing, []);
  assert.deepEqual(body.sessions, (await full()).filter((s) => s.id === id(6)));
});

test("a child whose parent is gone matches the list's answer (no parent link)", async () => {
  const orphanParent = join(projectDir, "2026-01-01_gone.jsonl");
  writeSession(7, { cwd: cwdA, age: 2, parentSession: orphanParent });
  invalidateSessionListCache();
  await ensureSessionIndex({ force: true });
  await full();
  const body = await partial(id(7));
  assert.equal(body.sessions[0].parentSessionId, undefined);
  assert.deepEqual(body.sessions, (await full()).filter((s) => s.id === id(7)));
});

test("duplicate ids are answered once", async () => {
  await full();
  const body = await partial(id(4), id(4));
  assert.deepEqual(body.sessions.map((s) => s.id), [id(4)]);
});

test("the partial answer is small, uncached and carries no ETag", async () => {
  await full();
  const response = await get(`?ids=${id(4)}`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("etag"), null);
  const conditional = await get(`?ids=${id(4)}`, { "if-none-match": '"anything"' });
  assert.equal(conditional.status, 200);
});

test("malformed or oversized id lists are rejected with 400 and no work", async () => {
  const hundred = Array.from({ length: 100 }, (_, n) => id(n + 1));
  const rejected = [
    "",
    ",",
    "abc",
    `${id(1)},`,
    `,${id(1)}`,
    `${id(1)},not-an-id`,
    `${id(1)},../../etc/passwd`,
    `${id(1)}%2C${id(2)}x`,
    [...hundred, id(101)].join(","),
  ];
  for (const ids of rejected) {
    const response = await get(`?ids=${ids}`);
    assert.equal(response.status, 400, ids.slice(0, 60));
    assert.equal((await response.json()).code, "invalid_session_ids");
  }
  assert.equal((await get(`?ids=${hundred.join(",")}`)).status, 200, "exactly the limit is fine");
  assert.equal((await get(`?ids=${Array(150).fill(id(1)).join(",")}`)).status, 200, "the limit counts distinct ids");
});

test("full list exposes its committed revision while retaining conditional reads", async () => {
  const response = await get();
  assert.equal(response.status, 200);
  const etag = response.headers.get("etag");
  assert.match(etag, /^"[0-9a-f]{16}"$/);
  const body = await response.json();
  assert.equal(typeof body.cursor.generation, "string");
  assert.equal(Number.isSafeInteger(body.cursor.revision), true);
  assert.equal(body.complete, true);
  assert.equal("partial" in body, false);
  assert.ok(body.sessions.length >= 5);
  const times = body.sessions.map((s) => Date.parse(s.modified));
  assert.deepEqual(times, [...times].sort((a, b) => b - a), "newest first");

  const notModified = await get("", { "if-none-match": etag });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get("etag"), etag);
});
