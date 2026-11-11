import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parseDataQuery, dataErrorResponse } = await jiti.import("./http.ts");
const { StorageError } = await jiti.import("../../../lib/storage/protocol.ts");

test("durable routes reject malformed cursor generations, revision ranges and paging tokens", () => {
  for (const value of [null, {}, { generation: "", revision: 0 }, { generation: "one", revision: -1 }, { generation: "one", revision: 0.1 }, { generation: "one", revision: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => parseDataQuery(new URL(`http://test/api/data/changes?cursor=${encodeURIComponent(JSON.stringify(value))}`), "changes"));
  }
  for (const suffix of ["?token=", "?token=x&token=y", "?unexpected=x"]) assert.throws(() => parseDataQuery(new URL(`http://test/api/data/snapshot${suffix}`), "snapshot"));
  assert.throws(() => parseDataQuery(new URL("http://test/api/data/changes"), "changes"));
  assert.deepEqual(parseDataQuery(new URL('http://test/api/data/changes?cursor=%7B%22generation%22%3A%22one%22%2C%22revision%22%3A0%7D'), "changes"), { cursor: { generation: "one", revision: 0 } });
});

test("durable failures distinguish reset from retryable service errors", async () => {
  for (const [code, status] of [["reset_required", 409], ["storage_busy", 503], ["migration_required", 503], ["restore_required", 503]]) {
    const response = dataErrorResponse(new StorageError(code, "test failure"));
    assert.equal(response.status, status); assert.equal((await response.json()).code, code);
  }
});

test("real worker migration unavailability keeps SSE alive and paged HTTP snapshots stay pinned", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "fox-data-http-"));
  const previous = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = path.join(home, ".omp", "agent");
  await fs.mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });
  await fs.writeFile(path.join(process.env.PI_CODING_AGENT_DIR, "projects.json"), JSON.stringify({ version: 1, projects: [] }));
  const { storageRequest, closeStorage } = await jiti.import("../../../lib/storage/client.ts");
  const { EventStreamConnection } = await jiti.import("../../../lib/event-stream-hub.ts");
  const route = await jiti.import("./snapshot/route.ts");
  const changes = await jiti.import("./changes/route.ts");
  const connection = new EventStreamConnection();
  const reader = connection.stream.getReader();
  const frame = async () => {
    let watchdog;
    const result = await Promise.race([reader.read(), new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error("Missing durable SSE frame")), 5000); })]).finally(() => clearTimeout(watchdog));
    const text = new TextDecoder().decode(result.value);
    return JSON.parse(/^data: (.*)$/m.exec(text)[1]);
  };
  try {
    assert.equal((await frame()).type, "hello");
    assert.deepEqual(await connection.subscribe("s1", { kind: "data" }), { ok: true });
    assert.equal((await frame()).type, "open");
    const unavailable = await frame();
    assert.equal(unavailable.type, "data-unavailable"); assert.equal(unavailable.code, "migration_required");
    await storageRequest({ operation: "migrate", offline: true });
    assert.equal((await frame()).type, "data-head");
    assert.equal((await route.GET(new Request("http://test/api/data/snapshot"))).status, 200);
    const updates = Array.from({ length: 501 }, (_, index) => ({ path: path.join(home, `${index}.jsonl`), stamp: `s${index}`, session: { id: `session-${index}`, path: path.join(home, `${index}.jsonl`), cwd: home, projectRoot: home, created: "2026-01-01T00:00:00Z", modified: "2026-01-01T00:00:00Z", messageCount: 1, firstMessage: "fixture" } }));
    await storageRequest({ operation: "index.apply", updates });
    const opened = await (await route.GET(new Request("http://test/api/data/snapshot"))).json();
    assert.equal(opened.data.sessions.length, 500); assert.equal(opened.next, true);
    await storageRequest({ operation: "pins.patch", pin: ["session-1"] });
    const second = await (await route.GET(new Request(`http://test/api/data/snapshot?token=${opened.token}`))).json();
    assert.deepEqual(second.cursor, opened.cursor); assert.equal(second.sessions.length, 1); assert.equal(second.next, false);
    assert.deepEqual(opened.data.pins, []);
    const replay = await changes.GET(new Request(`http://test/api/data/changes?cursor=${encodeURIComponent(JSON.stringify(opened.cursor))}`));
    assert.equal(replay.status, 200); assert.ok((await replay.json()).changes.some((item) => item.topic === "pins"));
    const aborted = await (await route.GET(new Request("http://test/api/data/snapshot"))).json();
    const controller = new AbortController(); controller.abort();
    await route.GET(new Request(`http://test/api/data/snapshot?token=${aborted.token}`, { signal: controller.signal }));
    await storageRequest({ operation: "head" });
    assert.equal((await route.GET(new Request(`http://test/api/data/snapshot?token=${aborted.token}`))).status, 409);
  } finally {
    await reader.cancel(); await closeStorage();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await fs.rm(home, { recursive: true, force: true });
  }
});
