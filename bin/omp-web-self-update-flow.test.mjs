// End-to-end in-app update of a plain launcher install: the real bin/omp-web.js,
// the real lib/self-update.ts and the real update worker, with a fake Next.js server
// and a fake `npm` standing in for the network and the global install.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const BIN_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_DIR = fileURLToPath(new URL("..", import.meta.url));
const JITI = pathToFileURL(join(REPO_DIR, "node_modules", "jiti", "lib", "jiti.mjs")).href;
const OLD_VERSION = "0.1.0";
const NEW_VERSION = "99.0.0";
const posixOnly = { skip: process.platform === "win32" };

// Stands in for `next start -p <port> -H <host>`. POST /update runs the same calls the
// /api/app-update route makes; GET /version reports which release this process runs.
const FAKE_NEXT = `
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("-p") + 1]);
const host = args[args.indexOf("-H") + 1];
const version = JSON.parse(fs.readFileSync(path.join(process.env.OMP_WEB_PACKAGE_DIR, "package.json"), "utf8")).version;
let selfUpdate;
async function load() {
  if (selfUpdate) return selfUpdate;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ tag_name: "v${NEW_VERSION}" }) });
  const { createJiti } = await import(${JSON.stringify(JITI)});
  selfUpdate = await createJiti(${JSON.stringify(import.meta.url)}, { alias: { "@/": ${JSON.stringify(REPO_DIR + "/")} } }).import(${JSON.stringify(join(REPO_DIR, "lib", "self-update.ts"))});
  return selfUpdate;
}
function reply(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
const server = http.createServer(async (req, res) => {
  if (req.url === "/version") return reply(res, 200, { version, pid: process.pid });
  if (req.url === "/update" && req.method === "POST") {
    try {
      const update = await load();
      const { attemptId } = await update.prepareSelfUpdate();
      update.validateCommitSelfUpdate(attemptId);
      update.markSelfUpdateStopping(attemptId);
      await update.armSelfUpdateLauncher(attemptId);
      await update.commitSelfUpdate(attemptId);
      return reply(res, 202, { attemptId });
    } catch (error) {
      return reply(res, 500, { error: String(error && error.message || error) });
    }
  }
  if (req.url === "/acknowledge" && req.method === "POST") {
    try {
      const update = await load();
      return reply(res, 200, update.acknowledgeSelfUpdate(update.getSelfUpdateStatus().attemptId));
    } catch (error) {
      return reply(res, 409, { error: String(error && error.message || error) });
    }
  }
  return reply(res, 404, {});
});
server.listen(port, host, () => console.log("Ready"));
process.on("SIGTERM", () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); });
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function request(port, path, method = "GET") {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, timeout: 2000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function waitFor(description, probe, timeoutMs, diagnostics) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${description}\n${diagnostics()}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Installs a launcher + fake Next.js into a temporary package directory, starts it on a free
// port and returns what the test needs to drive and observe an update.
async function startLauncher(t, { install }) {
  const dir = mkdtempSync(join(tmpdir(), "self-update-flow-"));
  const pkg = join(dir, "pkg");
  const home = join(dir, "home");
  const tmp = join(dir, "tmp");
  const fakeBin = join(dir, "fakebin");
  const log = join(dir, "calls.log");
  for (const directory of [home, tmp, fakeBin, join(pkg, ".next"), join(pkg, "node_modules", "next", "dist", "bin")]) {
    mkdirSync(directory, { recursive: true });
  }
  mkdirSync(join(pkg, "bin"));
  for (const name of readdirSync(BIN_DIR)) {
    if (name.endsWith(".js")) cpSync(join(BIN_DIR, name), join(pkg, "bin", name));
  }
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@telagod/foxnio", version: OLD_VERSION }));
  writeFileSync(join(pkg, "node_modules", "next", "package.json"), JSON.stringify({ name: "next", version: "0.0.0" }));
  writeFileSync(join(pkg, "node_modules", "next", "dist", "bin", "next"), FAKE_NEXT);
  const npm = [
    "#!/bin/sh",
    `echo "npm $*" >> "${log}"`,
    `case "$1" in view) echo "${NEW_VERSION}"; exit 0;; esac`,
    install === "fails"
      ? `echo "npm ERR! simulated install failure" >&2; exit 1`
      : `printf '{"name":"@telagod/foxnio","version":"${NEW_VERSION}"}' > "${join(pkg, "package.json")}"; exit 0`,
    "",
  ].join("\n");
  writeFileSync(join(fakeBin, "npm"), npm, { mode: 0o755 });

  const port = await freePort();
  const output = [];
  const launcher = spawn(process.execPath, [join(pkg, "bin", "omp-web.js"), "--no-open", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: pkg,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      TMPDIR: tmp,
      TEMP: tmp,
      TMP: tmp,
      PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  launcher.stdout.on("data", (chunk) => output.push(String(chunk)));
  launcher.stderr.on("data", (chunk) => output.push(String(chunk)));
  const pids = new Set();
  t.after(async () => {
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    if (launcher.exitCode === null && launcher.signalCode === null) {
      launcher.kill("SIGTERM");
      await new Promise((resolve) => { launcher.once("exit", resolve); setTimeout(resolve, 6000).unref(); });
      launcher.kill("SIGKILL");
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const diagnostics = () => [
    `launcher exit: ${launcher.exitCode ?? launcher.signalCode ?? "running"}`,
    `status: ${JSON.stringify(readJson(statusFile))}`,
    `calls: ${existsSync(log) ? readFileSync(log, "utf8").trim() : "(none)"}`,
    `output:\n${output.join("")}`,
  ].join("\n");
  const statusFile = join(tmp, `ompweb-self-update-${process.getuid()}`, "status.json");
  const version = async () => {
    const response = await request(port, "/version");
    if (response?.status === 200) pids.add(response.body.pid);
    return response?.status === 200 ? response.body : null;
  };
  const initial = await waitFor("the first server", version, 15_000, diagnostics);
  return { port, launcher, initial, version, statusFile, diagnostics, log, pkg };
}

// One update through the fake server's /update endpoint; resolves once the worker reports a
// terminal status and a different server process answers on the original port.
async function updateOnce(flow, previous) {
  const started = await request(flow.port, "/update", "POST");
  assert.equal(started?.status, 202, `update was not accepted: ${JSON.stringify(started)}\n${flow.diagnostics()}`);
  const { attemptId } = started.body;
  const status = await waitFor("a terminal update status", () => {
    const current = readJson(flow.statusFile);
    return current?.attemptId === attemptId && (current.state === "succeeded" || current.state === "failed") ? current : null;
  }, 60_000, flow.diagnostics);
  const after = await waitFor("a server on the original port", async () => {
    const current = await flow.version();
    return current && current.pid !== previous.pid ? current : null;
  }, 40_000, flow.diagnostics);
  return { attemptId, status, after };
}

async function runUpdate(t, { install }) {
  const flow = await startLauncher(t, { install });
  assert.equal(flow.initial.version, OLD_VERSION);
  return { ...flow, ...await updateOnce(flow, flow.initial) };
}

test("a plain launcher update installs the new release and restarts the server on the same port", posixOnly, async (t) => {
  const run = await runUpdate(t, { install: "succeeds" });
  assert.equal(run.status.state, "succeeded", run.diagnostics());
  assert.equal(run.after.version, NEW_VERSION, run.diagnostics());
  assert.equal(run.launcher.exitCode, null, "the launcher must keep running");
  assert.ok(isAlive(run.launcher.pid), "the launcher must keep running");
  assert.match(readFileSync(run.log, "utf8"), /npm install -g @telagod\/foxnio@99\.0\.0/);
});

test("a failed install brings the previous release back on the same port", posixOnly, async (t) => {
  const run = await runUpdate(t, { install: "fails" });
  assert.equal(run.status.state, "failed", run.diagnostics());
  assert.match(run.status.error, /package install failed/);
  assert.equal(run.after.version, OLD_VERSION, run.diagnostics());
  assert.equal(run.launcher.exitCode, null, "the launcher must keep running");
});

test("a launcher that finished one update accepts the next one", posixOnly, async (t) => {
  const first = await runUpdate(t, { install: "succeeds" });
  assert.equal(first.status.state, "succeeded", first.diagnostics());
  // The UI acknowledges a terminal attempt as soon as it sees it, before it offers another update.
  await waitFor("the first attempt to be acknowledged", async () => {
    const response = await request(first.port, "/acknowledge", "POST");
    return response?.status === 200 ? response : null;
  }, 10_000, first.diagnostics);
  const second = await updateOnce(first, first.after);
  assert.equal(second.status.state, "succeeded", first.diagnostics());
  assert.notEqual(second.attemptId, first.attemptId);
  assert.equal(first.launcher.exitCode, null, "the launcher must keep running");
});
