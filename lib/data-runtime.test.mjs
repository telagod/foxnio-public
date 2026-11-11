import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";
import { nativeEnvironment } from "../tests/omp-native-env.mjs";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const runtime = await jiti.import("./data-runtime.ts");
const storage = await jiti.import("./storage/client.ts");
const { foxWorkspaceDir } = await jiti.import("./fox-workspace.ts");
const packageDir = fileURLToPath(new URL("../", import.meta.url));
const settle = () => new Promise(resolve => setImmediate(resolve));

async function until(t, predicate) {
  while (!await predicate()) {
    t.signal.throwIfAborted();
    await delay(20);
  }
}

async function isolated(t) {
  const root = mkdtempSync(join(tmpdir(), "fox-data-runtime-"));
  const environment = { ...nativeEnvironment(root, join(root, "agent")), OMP_WEB_PACKAGE_DIR: packageDir };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const sessionsDir = join(process.env.PI_CODING_AGENT_DIR, "sessions", "project");
  mkdirSync(sessionsDir, { recursive: true });
  globalThis.__ompSessions = new Map();
  globalThis.__ompRunningListeners = new Set();
  const warnings = [];
  t.mock.method(console, "warn", (...args) => warnings.push(args));
  t.after(async () => {
    await runtime.stopDataRuntime();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, sessionsDir, warnings, briefing: join(foxWorkspaceDir(), "BRIEFING.md") };
}

function session(dir, id, title = id) {
  const file = join(dir, `${id}.jsonl`);
  const timestamp = new Date().toISOString();
  writeFileSync(file, [
    { type: "session", version: 3, id, cwd: join(dir, "project"), timestamp, title },
    { type: "message", id: "user", parentId: null, timestamp, message: { role: "user", content: "Review this project" } },
  ].map(JSON.stringify).join("\n") + "\n");
  return file;
}

function assertStopped() {
  assert.equal(globalThis.__foxDataRuntime, undefined);
  assert.equal(globalThis.__foxSessionFileWatch, undefined);
  assert.equal(globalThis.__foxSessionIndex, undefined);
  assert.equal(globalThis.__foxnioFoxService, undefined);
  assert.equal(globalThis.__foxStorageContext?.listeners.size ?? 0, 0);
  assert.equal(globalThis.__foxStorageContext?.clients.size ?? 0, 0);
  assert.equal(globalThis.__ompRunningListeners.size, 0);
  assert.equal(globalThis.__foxReportRelay?.listeners.size ?? 0, 0);
}

test("resident services recover from first storage unavailability and mirror external session changes without a browser", { timeout: 20_000 }, async t => {
  const fixture = await isolated(t);
  session(fixture.sessionsDir, "recovered-session");
  process.env.OMP_WEB_PACKAGE_DIR = join(fixture.root, "temporarily-unavailable-package");
  assert.equal(runtime.startDataServices(), undefined, "register does not await storage startup");
  await until(t, () => fixture.warnings.some(args => args.some(value => value?.code === "storage_unavailable")));
  assert.equal(globalThis.__foxSessionFileWatch, undefined);
  process.env.OMP_WEB_PACKAGE_DIR = packageDir;
  await until(t, () => globalThis.__foxnioFoxService && existsSync(fixture.briefing));
  assert.match(readFileSync(fixture.briefing, "utf8"), /recovered-session/);
  session(fixture.sessionsDir, "recovered-session", "changed-without-browser");
  await until(t, () => readFileSync(fixture.briefing, "utf8").includes("changed-without-browser"));
  assert.equal((await storage.storageRequest({ operation: "index.get", ids: ["recovered-session"] })).sessions[0].name, "changed-without-browser");
  await runtime.stopDataRuntime();
  assertStopped();
});

test("failed subscriptions unwind the already started index and listeners before a clean retry", { timeout: 20_000 }, async t => {
  const fixture = await isolated(t);
  session(fixture.sessionsDir, "partial-start");
  const failure = t.mock.method(globalThis.__ompRunningListeners, "add", () => { throw new Error("listener registration failed"); });
  await assert.rejects(runtime.startDataRuntime(), /listener registration failed/);
  assert.equal(globalThis.__foxSessionFileWatch, undefined);
  assert.equal(globalThis.__foxSessionIndex, undefined);
  assert.equal(globalThis.__foxStorageContext.listeners.size, 0);
  assert.equal(globalThis.__foxStorageContext.timer, undefined);
  failure.mock.restore();
  await runtime.startDataRuntime();
  await until(t, () => existsSync(fixture.briefing));
  assert.match(readFileSync(fixture.briefing, "utf8"), /partial-start/);
});

test("resident startup retries back off to thirty seconds and stop cancels the next attempt", { timeout: 20_000 }, async t => {
  await isolated(t);
  await storage.storageRequest({ operation: "head" });
  const client = [...globalThis.__foxStorageContext.clients.values()][0];
  let attempts = 0;
  const unavailable = t.mock.method(client, "request", async () => {
    attempts++;
    throw Object.assign(new Error("storage offline"), { code: "storage_unavailable" });
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  runtime.startDataServices();
  await settle();
  assert.equal(attempts, 1);
  for (const backoff of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const before = attempts;
    runtime.startDataServices();
    t.mock.timers.tick(backoff - 1);
    await settle();
    assert.equal(attempts, before, "repeated register does not bypass backoff");
    t.mock.timers.tick(1);
    await settle();
    assert.equal(attempts, before + 1);
  }
  unavailable.mock.restore();
  await runtime.stopDataRuntime();
  t.mock.timers.tick(60_000);
  await settle();
  assertStopped();
  t.mock.timers.reset();
});

for (const operation of ["head", "index.scan"]) {
  test(`stop waits for pending ${operation} startup and prevents late runtime or FOX resurrection`, { timeout: 20_000 }, async t => {
    const fixture = await isolated(t);
    await storage.storageRequest({ operation: "head" });
    const client = [...globalThis.__foxStorageContext.clients.values()][0];
    const request = client.request;
    const entered = Promise.withResolvers();
    const release = Promise.withResolvers();
    t.mock.method(client, "request", async function (input) {
      if (input.operation === operation) {
        entered.resolve();
        await release.promise;
      }
      return request.call(this, input);
    });
    runtime.startDataServices();
    await entered.promise;
    let stopped = false;
    const stopping = runtime.stopDataRuntime().then(() => { stopped = true; });
    runtime.startDataServices();
    await assert.rejects(runtime.startDataRuntime(), /stopp|cancel/i);
    await settle();
    assert.equal(stopped, false, "shutdown must join an admitted startup");
    release.resolve();
    await stopping;
    assertStopped();
    assert.equal(existsSync(fixture.briefing), false);
  });
}

test("shutdown joins an in-flight briefing read before closing its storage client", { timeout: 20_000 }, async t => {
  const fixture = await isolated(t);
  await storage.storageRequest({ operation: "head" });
  const client = [...globalThis.__foxStorageContext.clients.values()][0];
  const request = client.request;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.mock.method(client, "request", async function (input) {
    if (input.operation === "snapshot.open") {
      entered.resolve();
      await release.promise;
    }
    return request.call(this, input);
  });
  await runtime.startDataRuntime();
  await entered.promise;
  let stopped = false;
  const stopping = runtime.stopDataRuntime().then(() => { stopped = true; });
  await settle();
  assert.equal(stopped, false);
  assert.equal(globalThis.__foxSessionFileWatch, undefined, "producers stop before the outstanding read settles");
  release.resolve();
  await stopping;
  assertStopped();
  assert.equal(existsSync(fixture.briefing), false, "a canceled mirror cannot publish after shutdown");
});

test("an initial index scan failure closes its watcher before resident retry", { timeout: 20_000 }, async t => {
  const fixture = await isolated(t);
  session(fixture.sessionsDir, "index-recovery");
  await storage.storageRequest({ operation: "head" });
  const client = [...globalThis.__foxStorageContext.clients.values()][0];
  const request = client.request;
  const failure = t.mock.method(client, "request", function (input) {
    if (input.operation === "index.scan") return Promise.reject(new Error("initial inventory unavailable"));
    return request.call(this, input);
  });
  await assert.rejects(runtime.startDataRuntime(), /initial inventory unavailable/);
  assert.equal(globalThis.__foxSessionFileWatch, undefined);
  assert.equal(globalThis.__foxSessionIndex, undefined);
  failure.mock.restore();
  await runtime.startDataRuntime();
  await until(t, () => existsSync(fixture.briefing));
  assert.match(readFileSync(fixture.briefing, "utf8"), /index-recovery/);
});
