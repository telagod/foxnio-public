import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Real POST /api/agent/[id] and /api/agent/new handlers. Input that is
// malformed must be answered with a 4xx before any omp child is created; the
// omp binary is a launcher stub that records every launch.
const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const agentRoute = await jiti.import("../app/api/agent/[id]/route.ts");
const newRoute = await jiti.import("../app/api/agent/new/route.ts");
const { AgentSessionWrapper, WebRpcError } = await jiti.import("./rpc-manager.ts");

const agentDir = mkdtempSync(join(tmpdir(), "omp-web-agent-route-validation-"));
const launchLog = join(agentDir, "omp-launches.log");
const fakeOmp = join(agentDir, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp");
writeFileSync(
  fakeOmp,
  process.platform === "win32"
    ? `@echo off\r\necho launched>> "${launchLog}"\r\nexit /b 1\r\n`
    : `#!/bin/sh\necho launched >> '${launchLog}'\nexit 1\n`,
  { mode: 0o755 },
);

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousBin = process.env.OMP_WEB_OMP_BIN;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.OMP_WEB_OMP_BIN = fakeOmp;
after(() => {
  globalThis.__ompNotificationStore?.db.close();
  globalThis.__ompNotificationStore = undefined;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
  else process.env.OMP_WEB_OMP_BIN = previousBin;
  rmSync(agentDir, { recursive: true, force: true });
});

const launches = () => (existsSync(launchLog) ? readFileSync(launchLog, "utf8").split(/\r?\n/).filter(Boolean).length : 0);

const postRaw = (route, url, rawBody, params) => route.POST(
  new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: rawBody }),
  params,
);
const postAgent = (id, body) => postRaw(agentRoute, `http://localhost/api/agent/${id}`, JSON.stringify(body), { params: Promise.resolve({ id }) });
const postNew = (body) => postRaw(newRoute, "http://localhost/api/agent/new", JSON.stringify(body));

function useRegistry(t, wrappers = {}) {
  rmSync(launchLog, { force: true });
  const previousSessions = globalThis.__ompSessions;
  const previousLocks = globalThis.__ompStartLocks;
  globalThis.__ompSessions = new Map(Object.entries(wrappers));
  globalThis.__ompStartLocks = new Map();
  t.after(() => {
    globalThis.__ompSessions = previousSessions;
    globalThis.__ompStartLocks = previousLocks;
  });
}

/** A real wrapper over a fake child that answers every command with `{}`. */
function liveWrapper(t, id) {
  const wrapper = new AgentSessionWrapper({
    isAlive: true,
    onFrame() { return () => {}; },
    sendCommand: async () => ({}),
    sendFrame() {},
    dispose: async () => {},
  }, process.cwd(), null, "inherit", id, 0, "full", undefined);
  wrapper.start();
  t.after(() => wrapper.destroyAndWait());
  return wrapper;
}

async function assertRejected(response, status, code) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  const body = JSON.parse(text);
  assert.equal(body.code, code, text);
  assert.equal(typeof body.error, "string");
  assert.equal(launches(), 0, "no omp child was created");
}

for (const [label, raw] of [["null", "null"], ["an array", "[]"], ["a string", '"hi"'], ["a number", "7"]]) {
  test(`POST /api/agent/[id] answers 400 when the JSON body is ${label}`, async (t) => {
    useRegistry(t);
    await assertRejected(
      await postRaw(agentRoute, "http://localhost/api/agent/x", raw, { params: Promise.resolve({ id: "x" }) }),
      400,
      "invalid_request",
    );
  });

  test(`POST /api/agent/new answers 400 when the JSON body is ${label}`, async (t) => {
    useRegistry(t);
    await assertRejected(await postRaw(newRoute, "http://localhost/api/agent/new", raw), 400, "invalid_request");
  });
}

for (const toolNames of ["read", { 0: "read" }, [1], [null], [""], ["  "], ["--no-tools"], ["read", "-x"], ["read,bash"]]) {
  test(`POST /api/agent/new rejects toolNames ${JSON.stringify(toolNames)} before spawning`, async (t) => {
    useRegistry(t);
    await assertRejected(
      await postNew({ cwd: tmpdir(), type: "ensure_session", toolNames }),
      400,
      "invalid_request",
    );
  });
}

test("malformed commands for a live session are 400s, not server errors", async (t) => {
  const wrapper = liveWrapper(t, "live-validation");
  useRegistry(t, { "live-validation": wrapper });

  for (const command of [
    { type: "set_session_name", name: 123 },
    { type: "set_session_name" },
    { type: "set_session_name", name: "   " },
    { type: "set_host_tools", tools: [null] },
    { type: "set_host_tools", tools: "browser" },
    { type: "set_host_uri_schemes", schemes: [null] },
  ]) {
    const response = await postAgent("live-validation", command);
    const text = await response.text();
    assert.equal(response.status, 400, `${JSON.stringify(command)}: ${text}`);
    assert.equal(JSON.parse(text).code, "invalid_request", text);
  }
  // Well-formed registrations still work, and an empty list unregisters.
  assert.equal((await postAgent("live-validation", { type: "set_host_tools", tools: [{ name: "browser" }] })).status, 200);
  assert.equal((await postAgent("live-validation", { type: "set_host_tools", tools: [] })).status, 200);
  assert.equal((await postAgent("live-validation", { type: "set_session_name", name: " Release " })).status, 200);
});

test("transient session errors map to retryable statuses; other WebRpcErrors stay 400", async (t) => {
  const failing = (code) => ({
    isAlive: () => true,
    isRunning: () => true,
    isEditingHistory: () => false,
    async send() { throw new WebRpcError(`failed with ${code}`, code); },
  });
  const expected = {
    session_busy: 409,
    session_restarting: 409,
    session_changed: 409,
    session_unresponsive: 504,
    session_state_timeout: 504,
    invalid_edit_target: 400,
    mcp_change_failed: 400,
  };
  useRegistry(t);
  for (const [code, status] of Object.entries(expected)) {
    globalThis.__ompSessions.set("transient", failing(code));
    const response = await postAgent("transient", { type: "get_state" });
    const text = await response.text();
    assert.equal(response.status, status, `${code}: ${text}`);
    assert.equal(JSON.parse(text).code, code);
  }
});
