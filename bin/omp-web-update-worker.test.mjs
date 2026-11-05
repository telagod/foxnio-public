import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

const WORKER = fileURLToPath(new URL("./omp-web-update-worker.js", import.meta.url));
const ATTEMPT = "11111111-2222-3333-4444-555555555555";
const posixOnly = { skip: process.platform === "win32" };

// Runs the worker with stub `systemctl`, `launchctl` and package managers on PATH.
// `install` selects what the worker believes it is stopping: a systemd unit, a
// launchd agent or the tray service.
function runWorker(t, {
  manager = "npm",
  target = "0.6.0",
  install = "systemd",
  npmExit = 0,
  bunExit = 0,
  viewExit = 0,
  viewOutput = target,
  startExit = 0,
  activeExit = 0,
  expectedStatus = 0,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "update-worker-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home");
  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(home);
  const log = join(dir, "calls.log");
  // The stub package managers answer `view`/`info` (the pre-flight) separately from the install.
  const stubManager = (name, exit) => `#!/bin/sh\necho "${name} $*" >> "${log}"\ncase "$1" in view|info) echo "${viewOutput}"; echo "E404 not found" >&2; exit ${viewExit};; esac\nexit ${exit}\n`;
  writeFileSync(join(dir, "systemctl"), `#!/bin/sh\necho "systemctl $*" >> "${log}"\n[ "$2" = start ] && exit ${startExit}\n[ "$2" = is-active ] && { echo failed; exit ${activeExit}; }\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(dir, "launchctl"), `#!/bin/sh\necho "launchctl $1" >> "${log}"\nexit 0\n`, { mode: 0o755 });
  writeFileSync(join(dir, "npm"), stubManager("npm", npmExit), { mode: 0o755 });
  writeFileSync(join(dir, "bun"), stubManager("bun", bunExit), { mode: 0o755 });
  writeFileSync(join(dir, "bin", "omp-web-tray.js"), `require("node:fs").appendFileSync(${JSON.stringify(log)}, "tray " + process.argv[2] + "\\n");\n`);
  writeFileSync(join(dir, "status.json"), JSON.stringify({ attemptId: ATTEMPT, state: "running" }), { mode: 0o600 });
  writeFileSync(join(dir, `${ATTEMPT}.go`), "{}", { mode: 0o600 });
  const args = [
    WORKER,
    "--attempt", ATTEMPT,
    "--root", dir,
    "--package-dir", dir,
    "--manager", manager,
    "--manager-path", manager,
    "--target", target,
    "--kind", "app",
  ];
  if (install === "systemd") args.push("--systemd-unit", "foxnio.service", "--systemd-user", "1");
  if (install === "launchd") {
    mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(join(home, "Library", "LaunchAgents", "com.telagod.foxnio.plist"), "<plist/>");
  }
  if (install === "launcher") {
    writeFileSync(join(dir, `${ATTEMPT}.armed.json`), JSON.stringify({ protocol: 1, attemptId: ATTEMPT, launcherPid: process.pid }), { mode: 0o600 });
  }
  if (install === "tray") {
    mkdirSync(join(home, ".omp", "agent"), { recursive: true });
    writeFileSync(join(home, ".omp", "agent", "web-service.json"), JSON.stringify({ pid: 1 }));
  }
  const result = spawnSync(process.execPath, args, {
    env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${dir}${delimiter}${process.env.PATH}` },
    timeout: 30000,
  });
  assert.equal(result.status, expectedStatus, String(result.stderr));
  return {
    calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
    status: JSON.parse(readFileSync(join(dir, "status.json"), "utf8")),
  };
}

test("a systemd update checks the registry, stops the unit, installs, starts it and checks it stayed up", posixOnly, (t) => {
  const { calls, status } = runWorker(t);
  assert.deepEqual(calls, [
    "npm view @telagod/foxnio@0.6.0 version",
    "systemctl --user stop foxnio.service",
    "npm install -g @telagod/foxnio@0.6.0",
    "systemctl --user start foxnio.service",
    "systemctl --user is-active foxnio.service",
  ]);
  assert.equal(status.state, "succeeded");
});

test("a Bun global update uses the scoped registry mapping without overriding npmjs", posixOnly, (t) => {
  const { calls, status } = runWorker(t, { manager: "bun" });
  assert.equal(calls[0], "bun info @telagod/foxnio@0.6.0 version");
  assert.equal(calls[2], "bun add -g @telagod/foxnio@0.6.0");
  assert.equal(status.state, "succeeded");
});

test("a registry that does not serve the target fails before anything is stopped", posixOnly, (t) => {
  for (const install of ["systemd", "launchd", "tray", "launcher"]) {
    const { calls, status } = runWorker(t, { install, viewExit: 1 });
    assert.deepEqual(calls, ["npm view @telagod/foxnio@0.6.0 version"], install);
    assert.equal(status.state, "failed", install);
    assert.match(status.error, /@telagod:registry=https:\/\/npm\.pkg\.github\.com/, install);
    assert.match(status.error, /read:packages/, install);
  }
});

test("a server that no launcher or service would restart is left running", posixOnly, (t) => {
  const { calls, status } = runWorker(t, { install: "plain" });
  assert.deepEqual(calls, []);
  assert.equal(status.state, "failed");
  assert.match(status.error, /launcher or service that can restart it/);
});

test("a registry that answers without the target version fails before anything is stopped", posixOnly, (t) => {
  const { calls, status } = runWorker(t, { viewOutput: "" });
  assert.deepEqual(calls, ["npm view @telagod/foxnio@0.6.0 version"]);
  assert.equal(status.state, "failed");
});

test("a Bun pre-flight failure points at the Bun registry setup", posixOnly, (t) => {
  const { calls, status } = runWorker(t, { manager: "bun", viewExit: 1 });
  assert.deepEqual(calls, ["bun info @telagod/foxnio@0.6.0 version"]);
  assert.match(status.error, /bunfig\.toml/);
});

test("a target that is not a plain version never reaches a package manager or a stop action", posixOnly, (t) => {
  for (const target of ["9.0.0-x&calc", "0.6.0 --foo", "$(id)", "latest", "0.6", "v0.6.0", "0.6.0-"]) {
    const { calls, status } = runWorker(t, { target, expectedStatus: 1 });
    assert.deepEqual(calls, [], target);
    assert.equal(status.state, "failed", target);
  }
});

test("a prerelease target is accepted", posixOnly, (t) => {
  const { status } = runWorker(t, { target: "0.7.0-rc.1" });
  assert.equal(status.state, "succeeded");
});

test("a failed install starts the unit again", posixOnly, (t) => {
  const { calls, status } = runWorker(t, { npmExit: 1 });
  assert.equal(calls.at(-1), "systemctl --user start foxnio.service");
  assert.equal(status.state, "failed");
  assert.match(status.error, /package install failed/);
});

test("a failed install starts the launchd agent again", posixOnly, (t) => {
  const { calls, status } = runWorker(t, { install: "launchd", npmExit: 1 });
  assert.deepEqual(calls, [
    "npm view @telagod/foxnio@0.6.0 version",
    "launchctl bootout",
    "npm install -g @telagod/foxnio@0.6.0",
    "launchctl bootstrap",
  ]);
  assert.equal(status.state, "failed");
  assert.match(status.error, /package install failed/);
});

test("a failed install starts the tray service again", posixOnly, (t) => {
  const { calls, status } = runWorker(t, { install: "tray", npmExit: 1 });
  assert.deepEqual(calls, [
    "npm view @telagod/foxnio@0.6.0 version",
    "tray --stop",
    "npm install -g @telagod/foxnio@0.6.0",
    "tray --start",
  ]);
  assert.equal(status.state, "failed");
});

test("a unit that will not start again is reported as stopped", posixOnly, (t) => {
  const { status } = runWorker(t, { startExit: 1 });
  assert.equal(status.state, "failed");
  assert.match(status.error, /^foxnio\.service is still stopped: /);
});

test("a new release that does not stay up fails the update", posixOnly, (t) => {
  const { status } = runWorker(t, { activeExit: 3 });
  assert.equal(status.state, "failed");
  assert.match(status.error, /systemctl is-active foxnio\.service failed: failed/);
});
