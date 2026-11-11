import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Real POST /api/agent/[id] handler against a real saved-session file. The omp
// binary is a launcher stub that records every launch and exits at once, so a
// launch record is the observable proof that a child process was created.
const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});

const SAVED_ID = "saved-skill-session";
const agentDir = mkdtempSync(join(tmpdir(), "omp-web-skill-diagnostics-route-"));
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
    ? `@echo off\r\necho launched>> "${launchLog}"\r\nexit /b 1\r\n`
    : `#!/bin/sh\necho launched >> '${launchLog}'\nexit 1\n`,
  { mode: 0o755 },
);

const environment = { HOME: agentDir, USERPROFILE: agentDir, PI_CODING_AGENT_DIR: agentDir, OMP_WEB_OMP_BIN: fakeOmp };
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

const launches = () => (existsSync(launchLog) ? readFileSync(launchLog, "utf8").split(/\r?\n/).filter(Boolean).length : 0);

const post = (id, body, query = "") => agentRoute.POST(
  new Request(`http://localhost/api/agent/${id}${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id }) },
);

/** Replace the process-wide wrapper registry and clear the launch record for one test. */
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

const reply = { cwd: "/workspace", showStartupDiagnostics: false, diagnostics: [] };

function wrapper({ alive = true, running = false } = {}) {
  const self = {
    advisorChoice: "inherit",
    applied: [],
    sent: [],
    destroyed: 0,
    isAlive: () => alive,
    isRunning: () => running,
    isEditingHistory: () => false,
    async applyAdvisorChoice(choice) {
      self.applied.push(choice);
      return true;
    },
    async send(command) {
      self.sent.push(command);
      return reply;
    },
    async destroyAndWait() {
      self.destroyed += 1;
    },
  };
  return self;
}

const COMMANDS = [
  { type: "get_skill_diagnostics" },
  { type: "set_skill_startup_diagnostics", enabled: false },
];

for (const command of COMMANDS) {
  test(`${command.type} for a saved session with no live wrapper is unavailable and never starts omp`, async (t) => {
    useRegistry(t);

    const response = await post(SAVED_ID, command);
    const text = await response.text();

    assert.equal(response.status, 409, text);
    const body = JSON.parse(text);
    assert.equal(body.code, "skill_diagnostics_unavailable");
    assert.match(body.error, /skill diagnostics/i);
    assert.equal(launches(), 0, "no omp child was created");
    assert.equal(globalThis.__ompSessions.size, 0, "no wrapper was registered");
  });

  test(`${command.type} does not resume a session whose wrapper has exited`, async (t) => {
    const exited = wrapper({ alive: false });
    useRegistry(t, { [SAVED_ID]: exited });

    const response = await post(SAVED_ID, command);
    const text = await response.text();

    assert.equal(response.status, 409, text);
    assert.equal(JSON.parse(text).code, "skill_diagnostics_unavailable");
    assert.equal(launches(), 0, "no replacement omp child was created");
    assert.deepEqual(exited.sent, [], "the exited wrapper received nothing");
  });

  test(`${command.type} is answered by an active wrapper without switching or replacing it when the advisor query differs`, async (t) => {
    const live = wrapper();
    useRegistry(t, { [SAVED_ID]: live });

    const response = await post(SAVED_ID, command, "?advisor=on");
    const text = await response.text();

    assert.equal(response.status, 200, text);
    assert.equal(live.destroyed, 0, "an idle live child is never restarted to read or flip a setting");
    assert.deepEqual(live.applied, [], "reading diagnostics never changes the advisor");
    assert.equal(launches(), 0);
  });
}

test("an ordinary command for the same saved session still starts omp", async (t) => {
  // Control: proves the launch record observes a real start, so the zero-launch
  // assertions above cannot pass vacuously.
  useRegistry(t);

  const response = await post(SAVED_ID, { type: "get_state" });
  const text = await response.text();

  assert.equal(launches(), 1, `a session-owning command resumes omp (response ${response.status}: ${text})`);
  assert.notEqual(response.status, 409);
});
