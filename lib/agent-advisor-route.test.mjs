import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Real POST /api/agent/[id] handler against a real saved-session file. The omp
// binary is a launcher stub that records its arguments and exits at once, so
// the launch record shows whether, and with which flags, a child was created.
const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});

const SAVED_ID = "saved-advisor-session";
const agentDir = mkdtempSync(join(tmpdir(), "omp-web-advisor-route-"));
const projectDir = join(agentDir, "sessions", "-project");
mkdirSync(projectDir, { recursive: true });
writeFileSync(
  join(projectDir, "2026-01-01_saved.jsonl"),
  `${[
    { type: "session", version: 3, id: SAVED_ID, cwd: agentDir, timestamp: "2026-01-01T00:00:00.000Z" },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "hello" } },
  ].map((line) => JSON.stringify(line)).join("\n")}\n`,
);

const launchLog = join(agentDir, "omp-launches.log");
const fakeOmp = join(agentDir, process.platform === "win32" ? "fake-omp.cmd" : "fake-omp");
writeFileSync(
  fakeOmp,
  process.platform === "win32"
    ? `@echo off\r\necho %*>> "${launchLog}"\r\nexit /b 1\r\n`
    : `#!/bin/sh\necho "$@" >> '${launchLog}'\nexit 1\n`,
  { mode: 0o755 },
);

const environment = {
  HOME: agentDir,
  USERPROFILE: agentDir,
  PI_CODING_AGENT_DIR: agentDir,
  OMP_WEB_OMP_BIN: fakeOmp,
  OMP_WEB_PACKAGE_DIR: fileURLToPath(new URL("../", import.meta.url)),
};
const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
Object.assign(process.env, environment);
const agentRoute = await jiti.import("../app/api/agent/[id]/route.ts");
const { stopSessionIndex } = await jiti.import("./session-index.ts");
const { closeStorage } = await jiti.import("./storage/client.ts");
const { drainNotificationWrites } = await jiti.import("./notification-hub.ts");
after(async () => {
  await drainNotificationWrites();
  await stopSessionIndex();
  await closeStorage();
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(agentDir, { recursive: true, force: true });
});

const launches = () => (existsSync(launchLog) ? readFileSync(launchLog, "utf8").split(/\r?\n/).filter(Boolean) : []);

const post = (body, query = "") => agentRoute.POST(
  new Request(`http://localhost/api/agent/${SAVED_ID}${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id: SAVED_ID }) },
);

function useRegistry(t, live) {
  rmSync(launchLog, { force: true });
  const previousSessions = globalThis.__ompSessions;
  const previousLocks = globalThis.__ompStartLocks;
  globalThis.__ompSessions = new Map(live ? [[SAVED_ID, live]] : []);
  globalThis.__ompStartLocks = new Map();
  t.after(() => {
    globalThis.__ompSessions = previousSessions;
    globalThis.__ompStartLocks = previousLocks;
  });
}

/** A live wrapper whose `/advisor` command succeeds unless `canApply` is false. */
function liveWrapper({ running = false, canApply = true } = {}) {
  const self = {
    advisorChoice: "inherit",
    applied: [],
    sent: [],
    destroyed: 0,
    isAlive: () => self.destroyed === 0,
    isRunning: () => running,
    isRestarting: () => false,
    isEditingHistory: () => false,
    async applyAdvisorChoice(choice) {
      self.applied.push(choice);
      if (choice === "inherit" || choice === self.advisorChoice) return true;
      if (!canApply) return false;
      self.advisorChoice = choice;
      return true;
    },
    async send(command) {
      self.sent.push(command.type);
      return {};
    },
    async destroyAndWait() {
      self.destroyed += 1;
    },
  };
  return self;
}

test("an idle child switches its advisor in place before the command, without a respawn", async (t) => {
  const live = liveWrapper();
  useRegistry(t, live);
  const response = await post({ type: "get_state" }, "?advisor=off");
  assert.equal(response.status, 200, await response.text());
  assert.equal(live.advisorChoice, "off");
  assert.deepEqual(live.sent, ["get_state"]);
  assert.equal(live.destroyed, 0);
  assert.deepEqual(launches(), []);
});

test("a running child keeps its advisor until a later request", async (t) => {
  const live = liveWrapper({ running: true });
  useRegistry(t, live);
  const response = await post({ type: "get_state" }, "?advisor=off");
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(live.applied, [], "no /advisor command while a turn runs");
  assert.deepEqual(live.sent, ["get_state"]);
  assert.equal(live.destroyed, 0);
});

test("without the /advisor command, On respawns the idle child with --advisor while Off keeps it", async (t) => {
  const keep = liveWrapper({ canApply: false });
  useRegistry(t, keep);
  const kept = await post({ type: "get_state" }, "?advisor=off");
  assert.equal(kept.status, 200, await kept.text());
  assert.equal(keep.destroyed, 0, "no flag disables the advisor, so a respawn could not help");
  assert.deepEqual(launches(), []);

  const replace = liveWrapper({ canApply: false });
  globalThis.__ompSessions.set(SAVED_ID, replace);
  const response = await post({ type: "get_state" }, "?advisor=on");
  const text = await response.text();
  assert.equal(replace.destroyed, 1);
  const [launch, ...rest] = launches();
  assert.ok(launch, `advisor On must start omp (response ${response.status}: ${text})`);
  assert.deepEqual(rest, []);
  assert.match(launch, /--advisor/);
});

test("a request with no choice reuses the child as it is", async (t) => {
  const live = liveWrapper({ canApply: false });
  useRegistry(t, live);
  const response = await post({ type: "get_state" });
  assert.equal(response.status, 200, await response.text());
  assert.equal(live.destroyed, 0);
  assert.equal(live.advisorChoice, "inherit");
});
