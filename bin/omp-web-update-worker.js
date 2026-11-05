#!/usr/bin/env node
"use strict";
// Dependency-free CommonJS - copied outside pkgDir to survive Windows file-lock
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cp = require("node:child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require("node:os");

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const STAGES = ["preparing", "stopping", "installing", "restarting", "finalizing"];
// Same grammar as the version parser in lib/npm-update.ts, minus the optional "v" prefix.
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
// Control-file protocol shared with bin/omp-web.js (UPDATE_PROTOCOL there).
const LAUNCHER_PROTOCOL = 1;

function arg(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
const attemptId = arg("--attempt");
const root = arg("--root");
const packageDir = arg("--package-dir");
const manager = arg("--manager");
const managerPath = arg("--manager-path");
const target = arg("--target");
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const from = arg("--from");
const launcherPid = Number(arg("--launcher-pid"));
const serverPid = Number(arg("--server-pid"));
const kind = arg("--kind") || "app";
// Set when the server runs as this systemd unit; systemd stops and starts it.
const systemdUnit = arg("--systemd-unit");
const systemctlScope = arg("--systemd-user") === "1" ? ["--user"] : [];
let managerPrefix;
try {
  managerPrefix = JSON.parse(arg("--manager-prefix") || "[]");
} catch {
  managerPrefix = [];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function leaseFile() { return path.join(root, "lease.json"); }
function statusFile() { return path.join(root, "status.json"); }
function markerFile(m) { return path.join(root, attemptId + "." + m); }
function abortFile() { return markerFile("abort.json"); }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
function atomicWrite(file, obj) {
  const tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj), { encoding: "utf8", mode: 0o600, flag: "wx" });
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.rmSync(tmp, { force: true }); } catch {} throw e; }
}
function updateStatus(patch) {
  const cur = readJson(statusFile()) || {};
  const next = { ...cur, ...patch };
  // atomic write via tmp+rename
  const dir = path.dirname(statusFile());
  const tmp = path.join(dir, ".status." + process.pid + ".tmp");
  fs.writeFileSync(tmp, JSON.stringify(next), { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, statusFile());
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function isLaunchdActive() {
  try {
    const plist = path.join(os.homedir(), "Library", "LaunchAgents", "com.telagod.foxnio.plist");
    return fs.existsSync(plist);
  } catch { return false; }
}
function isTrayActive() {
  try {
    const svc = path.join(os.homedir(), ".omp", "agent", "web-service.json");
    if (!fs.existsSync(svc)) return false;
    const data = readJson(svc);
    return Boolean(data && data.pid);
  } catch { return false; }
}
function systemctl(action) {
  const result = cp.spawnSync("systemctl", [...systemctlScope, action, systemdUnit], { encoding: "utf8", timeout: 120000 });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || (result.error && result.error.message) || "").trim().slice(0, 200);
    throw new Error(`systemctl ${action} ${systemdUnit} failed${detail ? `: ${detail}` : ""}`);
  }
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (Date.now() > deadline) return false;
    await sleep(100);
  }
  return true;
}

// The launcher that started the server registered for this attempt: it stays alive while
// the server is stopped and starts the new release when asked (restartViaLauncher).
function isLauncherArmed() {
  const armed = readJson(markerFile("armed.json"));
  return Boolean(armed && armed.protocol === LAUNCHER_PROTOCOL && armed.attemptId === attemptId);
}

// What brings the server back after the install; null when nothing would.
function detectRestartMethod() {
  if (systemdUnit) return { systemd: true };
  if (isLauncherArmed()) return { launcher: true };
  const launchd = isLaunchdActive();
  const tray = isTrayActive();
  return launchd || tray ? { launchd, tray } : null;
}

// Only the server is stopped: the launcher stays up and restarts it on request.
async function stopServerProcess() {
  if (!Number.isInteger(serverPid) || serverPid <= 0 || serverPid === process.pid) throw new Error("The server process is unknown");
  try { process.kill(serverPid, "SIGTERM"); } catch (e) { if (e.code === "ESRCH") return; throw e; }
  if (await waitForExit(serverPid, 10000)) return;
  try { process.kill(serverPid, "SIGKILL"); } catch {}
  if (!await waitForExit(serverPid, 5000)) throw new Error("The server did not stop");
}

async function stopOriginalProcesses(info) {
  updateStatus({ stage: "stopping" });
  if (info.systemd) {
    systemctl("stop");
    return;
  }
  if (info.launcher) {
    await stopServerProcess();
    return;
  }
  if (info.launchd) {
    try {
      const uid = typeof process.getuid === "function" ? process.getuid() : 501;
      cp.spawnSync("launchctl", ["bootout", `gui/${uid}/com.telagod.foxnio`], { timeout: 15000, windowsHide: true });
    } catch {}
    await sleep(500);
  }
  if (info.tray) {
    try {
      const trayBin = path.join(packageDir, "bin", "omp-web-tray.js");
      if (fs.existsSync(trayBin)) {
        cp.spawnSync(process.execPath, [trayBin, "--stop"], { timeout: 15000, windowsHide: true });
      }
    } catch {}
    await sleep(500);
  }
}

// The npm `.cmd` shim cannot be spawned without a shell, and a shell would parse
// the arguments. On Windows run npm's own entry point with the current node instead.
function npmCliPath() {
  const cli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return fs.existsSync(cli) ? cli : null;
}
function runManager(args, timeout) {
  const isBun = manager === "bun";
  const bin = managerPath || (isBun ? "bun" : "npm");
  const fullArgs = Array.isArray(managerPrefix) && managerPrefix.length ? [...managerPrefix, ...args] : args;
  const options = { timeout, windowsHide: true, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } };
  if (!isBun && process.platform === "win32") {
    const cli = bin === "npm" ? npmCliPath() : null;
    if (cli) return cp.spawnSync(process.execPath, [cli, ...fullArgs], options);
    // Last resort: `target` and the prefix were validated, so the shell sees no metacharacters.
    return cp.spawnSync(bin === "npm" ? "npm.cmd" : bin, fullArgs, { ...options, shell: true });
  }
  return cp.spawnSync(bin, fullArgs, options);
}

// Availability comes from GitHub Releases but the install reads GitHub Packages, which
// needs a token even for public packages. Check that the registry serves the target
// before anything is stopped.
function preflightRegistry() {
  const spec = `@telagod/foxnio@${target}`;
  const result = runManager(manager === "bun" ? ["info", spec, "version"] : ["view", spec, "version"], 60 * 1000);
  const stdout = result.stdout ? result.stdout.toString() : "";
  if (result.status === 0 && stdout.split(/[\s:]+/).includes(target)) return;
  const hint = manager === "bun"
    ? "Map the @telagod scope to https://npm.pkg.github.com with a read:packages token (bunfig.toml [install.scopes] or ~/.npmrc)"
    : "Add '@telagod:registry=https://npm.pkg.github.com' and a read:packages token to ~/.npmrc";
  const stderr = result.stderr ? result.stderr.toString().trim().split("\n")[0] : "";
  const detail = stderr || (result.error ? String(result.error.message || result.error.code) : "");
  throw new Error(`${spec} is not readable from the registry. ${hint}.${detail ? ` ${detail}` : ""}`);
}

async function runManagerGate() {
  updateStatus({ stage: "installing" });
  if (kind === "omp") {
    // Run omp update
    const bin = process.env.OMP_WEB_OMP_BIN || "omp";
    // Try resolve via packageDir/../?
    await new Promise((resolve) => {
      const child = cp.spawn(bin, ["update"], { timeout: 5 * 60 * 1000, windowsHide: true, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" } });
      child.on("close", () => resolve());
      child.on("error", () => resolve());
      setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve(); }, 5 * 60 * 1000 + 1000);
    });
    return;
  }
  // App update via npm/bun
  const args = manager === "bun"
    ? ["add", "-g", `@telagod/foxnio@${target}`]
    : ["install", "-g", `@telagod/foxnio@${target}`];
  let retries = 0;
  let lastResult;
  while (retries <= 1) {
    const result = runManager(args, 5 * 60 * 1000);
    lastResult = result;
    const stderr = result.stderr ? result.stderr.toString() : "";
    const spawnError = result.error ? String(result.error.code || result.error.message || "") : "";
    const isBusy = (result.error && ["EBUSY", "EPERM"].includes(result.error.code || "")) || /EBUSY|EPERM/.test(stderr) || /EBUSY|EPERM/.test(spawnError);
    if (isBusy && retries === 0) {
      retries++;
      await sleep(2000);
      continue;
    }
    break;
  }
  if (lastResult && lastResult.status !== 0) {
    const stderr = lastResult.stderr ? lastResult.stderr.toString().trim().slice(0, 500) : "";
    const spawnErr = lastResult.error ? String(lastResult.error.message || lastResult.error.code || "").slice(0, 200) : "";
    const detail = stderr || spawnErr;
    throw new Error(`package install failed (exit ${lastResult.status})${detail ? `: ${detail}` : ""}`);
  }
}

let launcherRestartRequested = false;
// The launcher accepts one start request per attempt (generation 1) and answers with an ack.
async function restartViaLauncher() {
  launcherRestartRequested = true;
  atomicWrite(markerFile("restart-request.json"), { protocol: LAUNCHER_PROTOCOL, attemptId, action: "start", generation: 1, requestedAt: new Date().toISOString() });
  const ackFile = markerFile("restart-ack.json");
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const ack = readJson(ackFile);
    if (ack && ack.protocol === LAUNCHER_PROTOCOL && ack.attemptId === attemptId && ack.generation === 1) return;
    if (!isProcessAlive(launcherPid)) throw new Error("The foxnio launcher exited before it restarted the server");
    await sleep(100);
  }
  throw new Error("The foxnio launcher did not restart the server");
}

// Lets the launcher go back to normal operation; it answers with complete-ack.json.
async function releaseLauncher() {
  try {
    atomicWrite(markerFile("complete.json"), { protocol: LAUNCHER_PROTOCOL, attemptId, completedAt: new Date().toISOString() });
    for (let i = 0; i < 50 && !fs.existsSync(markerFile("complete-ack.json")); i++) await sleep(100);
  } catch {}
}

async function restartServices(info) {
  updateStatus({ stage: "restarting" });
  if (info.systemd) {
    systemctl("start");
    // A Type=simple start returns once the process is forked; a release that
    // crashes on startup shows up as not active a moment later.
    // shortcut: one check after 3s, not a port probe; upgrade if slow-starting crashes slip through.
    await sleep(3000);
    systemctl("is-active");
    return;
  }
  if (info.launcher) {
    await restartViaLauncher();
    return;
  }
  if (info.launchd) {
    try {
      const uid = typeof process.getuid === "function" ? process.getuid() : 501;
      cp.spawnSync("launchctl", ["bootstrap", `gui/${uid}`, path.join(os.homedir(), "Library", "LaunchAgents", "com.telagod.foxnio.plist")], { timeout: 15000, windowsHide: true });
    } catch {}
    await sleep(1000);
    return;
  }
  if (info.tray) {
    try {
      const trayBin = path.join(packageDir, "bin", "omp-web-tray.js");
      if (fs.existsSync(trayBin)) {
        cp.spawn(process.execPath, [trayBin, "--start"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
      }
    } catch {}
    await sleep(1000);
  }
}

async function main() {
  if (!/^[0-9a-f-]{36}$/i.test(attemptId || "") || !root || !packageDir || !target) {
    process.exit(1);
  }
  if (!VERSION_PATTERN.test(target)) {
    // target ends up in package manager arguments (through a shell on old Windows setups)
    updateStatus({ state: "failed", error: "Refusing to install an invalid target version", finishedAt: new Date().toISOString(), cleanupReady: true });
    process.exit(1);
  }
  // Check abort
  if (fs.existsSync(abortFile())) {
    updateStatus({ state: "failed", error: (readJson(abortFile()) || {}).reason || "aborted", finishedAt: new Date().toISOString(), cleanupReady: true });
    process.exit(0);
  }
  // Check go marker exists (commit signal)
  if (!fs.existsSync(markerFile("go"))) {
    // wait briefly for go
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(markerFile("go"))) break;
      await sleep(200);
    }
  }
  updateStatus({ state: "running", stage: "preparing", startedAt: new Date().toISOString() });
  await sleep(1000); // PREPARING_MIN 1s

  let svcInfo = null;
  let stopAttempted = false;
  try {
    if (kind !== "omp") {
      svcInfo = detectRestartMethod();
      if (!svcInfo) throw new Error("foxnio is not running under a launcher or service that can restart it after an update");
      preflightRegistry();
      stopAttempted = true;
      await stopOriginalProcesses(svcInfo);
    }
    await runManagerGate();
    try {
      const pkgPath = path.join(packageDir, "package.json");
      if (fs.existsSync(pkgPath)) {
        const pkg = readJson(pkgPath);
        if (pkg && pkg.version !== target) {
          // version mismatch not fatal but record
        }
      }
    } catch {}
    if (kind !== "omp") await restartServices(svcInfo);
    await sleep(500);
    // Before the terminal status: once the UI sees it, it may clean the control files up.
    if (svcInfo && svcInfo.launcher) await releaseLauncher();
    updateStatus({ state: "succeeded", stage: "finalizing", finishedAt: new Date().toISOString(), cleanupReady: true });
  } catch (e) {
    let msg = e instanceof Error ? e.message : String(e);
    // Never leave the service stopped after a failed install. Nothing was stopped
    // when the pre-flight failed, so there is nothing to bring back.
    if (stopAttempted) {
      if (systemdUnit) {
        try { systemctl("start"); } catch { msg = `${systemdUnit} is still stopped: ${msg}`; }
      } else if (!launcherRestartRequested) {
        // A launcher that was asked once and did not answer is not asked again.
        try { await restartServices(svcInfo); } catch { msg = `The service could not be restarted: ${msg}`; }
      }
    }
    if (svcInfo && svcInfo.launcher) await releaseLauncher();
    updateStatus({ state: "failed", error: msg.slice(0, 240), finishedAt: new Date().toISOString(), cleanupReady: true });
  }
}

main().catch((e) => {
  try { updateStatus({ state: "failed", error: String(e).slice(0, 240), finishedAt: new Date().toISOString(), cleanupReady: true }); } catch {}
  process.exit(1);
});
