import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@/": new URL("../", import.meta.url).pathname,
  },
});
const {
  armSelfUpdateLauncher,
  commitSelfUpdate,
  getSelfUpdateStatus,
  markSelfUpdateStopping,
  parseSystemdServiceCgroup,
  resolveSelfUpdateTempRoot,
  validateCommitSelfUpdate,
} = await jiti.import("./self-update.ts");

test("parseSystemdServiceCgroup finds system and user services, and nothing outside one", () => {
  assert.deepEqual(parseSystemdServiceCgroup("0::/system.slice/foxnio-api.service\n"), { unit: "foxnio-api.service", user: false });
  assert.deepEqual(
    parseSystemdServiceCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/foxnio.service\n"),
    { unit: "foxnio.service", user: true },
  );
  assert.deepEqual(
    parseSystemdServiceCgroup("12:pids:/system.slice/x.service\n1:name=systemd:/system.slice/foxnio.service\n"),
    { unit: "foxnio.service", user: false },
  );
  assert.deepEqual(
    parseSystemdServiceCgroup("1:name=systemd:/system.slice/foxnio.service\n0::/\n"),
    { unit: "foxnio.service", user: false },
  );
  assert.equal(parseSystemdServiceCgroup("0::/user.slice/user-1000.slice/session-3.scope\n"), null);
  assert.equal(parseSystemdServiceCgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/tmux-spawn-1.scope\n"), null);
  assert.equal(parseSystemdServiceCgroup(""), null);
});

function withUpdateState(t, { workerPid, leaseExpiresAt, state = "running" }) {
  const temporary = mkdtempSync(join(tmpdir(), "self-update-test-"));
  // os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows.
  const names = ["TMPDIR", "TEMP", "TMP"];
  const previous = names.map((name) => process.env[name]);
  for (const name of names) process.env[name] = temporary;
  t.after(() => {
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
    rmSync(temporary, { recursive: true, force: true });
  });
  const root = resolveSelfUpdateTempRoot("app");
  mkdirSync(root, { mode: 0o700 });
  const attemptId = "2e4c6460-5a8f-4ef7-8d81-42cb688a8bdc";
  if (leaseExpiresAt !== null) {
    writeFileSync(join(root, "lease.json"), JSON.stringify({ attemptId, kind: "app", expiresAt: leaseExpiresAt }), { mode: 0o600 });
  }
  writeFileSync(join(root, `${attemptId}.ready`), "{}", { mode: 0o600 });
  writeFileSync(join(root, "status.json"), JSON.stringify({
    attemptId,
    state,
    ...(state === "running" ? { stage: "stopping" } : {}),
    fromVersion: "0.5.2",
    targetVersion: "0.6.0",
    preparedAt: new Date().toISOString(),
    workerPid,
  }), { mode: 0o600 });
  return { statusFile: join(root, "status.json"), leaseFile: join(root, "lease.json"), attemptId };
}

// A pid far above any pid_max, so it is never alive.
const DEAD_PID = 2 ** 30;

test("a running update whose worker died is reported, and stored, as failed", (t) => {
  const { statusFile } = withUpdateState(t, { workerPid: DEAD_PID, leaseExpiresAt: Date.now() + 60_000 });
  const status = getSelfUpdateStatus("app");
  assert.equal(status.state, "failed");
  assert.equal(status.cleanupReady, true);
  assert.match(status.error, /worker stopped/);
  assert.equal(JSON.parse(readFileSync(statusFile, "utf8")).state, "failed");
});

test("a running update past its lease is failed even when its pid is alive (reused)", (t) => {
  withUpdateState(t, { workerPid: process.pid, leaseExpiresAt: Date.now() - 1 });
  assert.equal(getSelfUpdateStatus("app").state, "failed");
});

test("a running update with a live worker inside its lease stays running", (t) => {
  const { statusFile } = withUpdateState(t, { workerPid: process.pid, leaseExpiresAt: Date.now() + 60_000 });
  assert.equal(getSelfUpdateStatus("app").state, "running");
  assert.equal(JSON.parse(readFileSync(statusFile, "utf8")).state, "running");
});

test("a running update before its worker pid is recorded stays running", (t) => {
  withUpdateState(t, { workerPid: undefined, leaseExpiresAt: Date.now() + 60_000 });
  assert.equal(getSelfUpdateStatus("app").state, "running");
});

test("a running update without a lease is failed", (t) => {
  withUpdateState(t, { workerPid: process.pid, leaseExpiresAt: null });
  assert.equal(getSelfUpdateStatus("app").state, "failed");
});

test("a prepared update whose lease expired cannot be committed", (t) => {
  const { attemptId } = withUpdateState(t, { state: "prepared", leaseExpiresAt: Date.now() - 1 });
  assert.throws(() => validateCommitSelfUpdate(attemptId, "app"), { code: "lease_expired" });
});

test("starting a commit renews the lease, so a late commit is not reported as lost", (t) => {
  const { attemptId, leaseFile } = withUpdateState(t, { state: "prepared", leaseExpiresAt: Date.now() + 1_000 });
  assert.equal(validateCommitSelfUpdate(attemptId, "app"), "ready");
  markSelfUpdateStopping(attemptId, "app");
  assert.ok(JSON.parse(readFileSync(leaseFile, "utf8")).expiresAt > Date.now() + 10 * 60_000);
  assert.equal(getSelfUpdateStatus("app").state, "running");
});

// Replaces the IPC channel to the launcher; `reply` builds the launcher's answer to a message.
function withLauncherIpc(t, { reply, ipc = true }) {
  const sent = [];
  const previous = { send: Object.getOwnPropertyDescriptor(process, "send"), connected: Object.getOwnPropertyDescriptor(process, "connected") };
  const home = mkdtempSync(join(tmpdir(), "self-update-home-"));
  const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  Object.defineProperty(process, "send", {
    configurable: true,
    writable: true,
    value: ipc
      ? (message, callback) => {
          sent.push(message);
          callback?.(null);
          if (reply) setImmediate(() => process.emit("message", reply(message)));
          return true;
        }
      : undefined,
  });
  Object.defineProperty(process, "connected", { configurable: true, value: ipc });
  t.after(() => {
    for (const [name, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(process, name, descriptor);
      else delete process[name];
    }
    for (const [name, value] of Object.entries(previousHome)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });
  return { sent, home };
}

const ack = (ok, error) => (message) => ({ type: "ompweb:update-control-ack", protocol: 1, attemptId: message.attemptId, ok, ...(error ? { error } : {}) });

test("arming sends the control root to the launcher and waits for its acknowledgement", async (t) => {
  const { attemptId } = withUpdateState(t, { state: "prepared", leaseExpiresAt: Date.now() + 60_000 });
  const { sent } = withLauncherIpc(t, { reply: ack(true) });
  await armSelfUpdateLauncher(attemptId, "app");
  assert.deepEqual(sent, [{ type: "ompweb:update-control", protocol: 1, attemptId, root: resolveSelfUpdateTempRoot("app") }]);
});

test("a launcher that refuses to arm fails the update with its reason", async (t) => {
  const { attemptId } = withUpdateState(t, { state: "prepared", leaseExpiresAt: Date.now() + 60_000 });
  withLauncherIpc(t, { reply: ack(false, "update attempt is no longer active") });
  await assert.rejects(armSelfUpdateLauncher(attemptId, "app"), { code: "launcher_unavailable", message: /no longer active/ });
});

test("a server without a launcher channel cannot be updated in place", async (t) => {
  const { attemptId } = withUpdateState(t, { state: "prepared", leaseExpiresAt: Date.now() + 60_000 });
  withLauncherIpc(t, { ipc: false });
  await assert.rejects(armSelfUpdateLauncher(attemptId, "app"), { code: "launcher_unavailable" });
});

test("a server run by a launchd agent leaves the launcher alone", async (t) => {
  const { attemptId } = withUpdateState(t, { state: "prepared", leaseExpiresAt: Date.now() + 60_000 });
  const { sent, home } = withLauncherIpc(t, { reply: ack(true) });
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(join(home, "Library", "LaunchAgents", "com.telagod.foxnio.plist"), "<plist/>");
  await armSelfUpdateLauncher(attemptId, "app");
  assert.deepEqual(sent, []);
});

test("the worker is started with its own path once and only named options", async (t) => {
  const { statusFile, attemptId } = withUpdateState(t, { state: "prepared", leaseExpiresAt: Date.now() + 60_000 });
  const root = dirname(statusFile);
  const output = join(root, "argv.json");
  const workerDir = join(root, "attempts", attemptId);
  mkdirSync(workerDir, { recursive: true, mode: 0o700 });
  const worker = join(workerDir, "worker.js");
  writeFileSync(worker, `require("node:fs").writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(1)));`);
  const previousPackageDir = process.env.OMP_WEB_PACKAGE_DIR;
  process.env.OMP_WEB_PACKAGE_DIR = dirname(root);
  t.after(() => {
    if (previousPackageDir === undefined) delete process.env.OMP_WEB_PACKAGE_DIR;
    else process.env.OMP_WEB_PACKAGE_DIR = previousPackageDir;
  });
  await commitSelfUpdate(attemptId, "app");
  const deadline = Date.now() + 10_000;
  while (!existsSync(output) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  const argv = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(argv[0], worker);
  assert.equal(argv.filter((value) => value === worker).length, 1);
  const options = argv.slice(1);
  assert.equal(options.length % 2, 0);
  for (let index = 0; index < options.length; index += 2) assert.match(options[index], /^--[a-z-]+$/, `argument ${index + 1} must be an option name: ${options[index]}`);
  const value = (name) => options[options.indexOf(name) + 1];
  assert.equal(value("--attempt"), attemptId);
  assert.equal(value("--root"), root);
  assert.equal(value("--target"), "0.6.0");
  assert.equal(value("--server-pid"), String(process.pid));
});
