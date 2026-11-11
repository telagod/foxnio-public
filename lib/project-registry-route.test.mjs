import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = realpathSync.native(mkdtempSync(join(tmpdir(), "fox-project-route-")));
const previous = process.env.PI_CODING_AGENT_DIR;
const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const route = await jiti.import("../app/api/projects/route.ts");
const registry = await jiti.import("./project-registry.ts");
const { closeStorage, storageRequest } = await jiti.import("./storage/client.ts");
test.after(async () => {
  await closeStorage();
  for (const [key, value] of Object.entries(previousHome)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  rmSync(root, { recursive: true, force: true });
});
const request = (body, method = "PATCH") => new Request("http://localhost/api/projects", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const directory = (name) => { const path = join(root, name); mkdirSync(path, { recursive: true }); return realpathSync.native(path); };

test("concurrent presentation edits preserve launch configuration and other fields", async () => {
  const cwd = directory("parallel");
  assert.equal((await route.POST(request({ cwd, launchConfig: { profile: "work" } }, "POST"))).status, 200);
  const responses = await Promise.all([route.PATCH(request({ cwd, alias: "App" })), route.PATCH(request({ cwd, pinOrder: 3 }))]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  const project = (await registry.loadProjectRegistry()).projects.find((entry) => entry.path === cwd);
  assert.equal(project.alias, "App");
  assert.equal(project.pinOrder, 3);
  assert.equal(project.launchConfig.profile, "work");
});

test("batch registration and per-field edits commit together and reject stale revision", async () => {
  const first = directory("first");
  const second = directory("second");
  const before = await storageRequest({ operation: "head" });
  const response = await route.PATCH(request({ updates: [{ cwd: first, alias: "First" }, { cwd: first, pinOrder: 1 }, { cwd: second, sortOrder: 2 }], expectedRevision: before.revision }));
  assert.equal(response.status, 200);
  const after = await storageRequest({ operation: "head" });
  assert.equal(after.revision, before.revision + 1);
  assert.equal((await route.PATCH(request({ cwd: first, alias: "stale", expectedRevision: before.revision }))).status, 409);
  assert.equal((await registry.loadProjectRegistry()).projects.find((entry) => entry.path === first).alias, "First");
});

test("hidden entries remain hidden during presentation edits, and readd preserves config", async () => {
  const cwd = directory("hidden");
  await route.POST(request({ cwd, launchConfig: { advisor: true } }, "POST"));
  await route.DELETE(request({ cwd }, "DELETE"));
  await route.PATCH(request({ cwd, alias: "Ignored" }));
  let entry = (await registry.loadProjectRegistry()).projects.find((project) => project.path === cwd);
  assert.equal(entry.hidden, true);
  assert.equal(entry.alias, undefined);
  await route.POST(request({ cwd }, "POST"));
  entry = (await registry.loadProjectRegistry()).projects.find((project) => project.path === cwd);
  assert.equal(entry.hidden, false);
  assert.equal(entry.launchConfig.advisor, true);
});

test("managed removed paths are editable while missing unregistered paths are not registered", async () => {
  const cwd = directory("removed");
  await route.POST(request({ cwd }, "POST"));
  rmSync(cwd, { recursive: true });
  const absent = join(root, "never-existed");
  const response = await route.PATCH(request({ updates: [{ cwd, alias: "Still managed" }, { cwd: absent, sortOrder: 9 }] }));
  assert.equal(response.status, 200);
  const projects = (await registry.loadProjectRegistry()).projects;
  assert.equal(projects.find((entry) => entry.path === cwd).alias, "Still managed");
  assert.equal(projects.some((entry) => entry.path === absent), false);
});
