import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": new URL("../", import.meta.url).pathname },
});

const ENV_KEYS = ["HOME", "USERPROFILE", "PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "XDG_DATA_HOME"];

/** Fake home with ~/.omp populated, plus a workspace that is an allowed root. */
async function setup(t) {
  const { allowFileRoot } = await jiti.import("./file-access.ts");
  const { authorizeFileAccess } = await jiti.import("./file-authorization.ts");
  const { patchProjectRegistry } = await jiti.import("./project-registry.ts");
  const { drainNotificationWrites } = await jiti.import("./notification-hub.ts");
  const { stopSessionIndex } = await jiti.import("./session-index.ts");
  const { closeStorage } = await jiti.import("./storage/client.ts");
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const previousRoots = globalThis.__piAdditionalAllowedRoots;
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-auth-")));
  t.after(async () => {
    await drainNotificationWrites();
    await stopSessionIndex();
    await closeStorage();
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    globalThis.__piAdditionalAllowedRoots = previousRoots;
    globalThis.__piAllowedRootsCache = undefined;
    fs.rmSync(home, { recursive: true, force: true });
  });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const key of ["PI_CONFIG_DIR", "XDG_DATA_HOME"]) delete process.env[key];
  globalThis.__piAdditionalAllowedRoots = new Set();

  const agentDir = path.join(home, ".omp", "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  fs.mkdirSync(path.join(agentDir, "omp-web"), { recursive: true });
  fs.mkdirSync(path.join(home, ".omp", "run", "daemons", "abc"), { recursive: true });
  const workspace = path.join(home, "workspace");
  fs.mkdirSync(workspace);
  // Initialize app.db before credential fixtures create legacy-looking files.
  await patchProjectRegistry([{ path: workspace, register: true }]);
  // Dotfile-manager tests relocate ~/.omp; do not keep its SQLite handles open.
  await closeStorage();
  // The native-agent override test still needs this in-memory workspace grant.
  allowFileRoot(workspace);
  globalThis.__piAllowedRootsCache = undefined;

  const access = (filePath) => authorizeFileAccess(filePath.replace(/\\/g, "/").split("/").filter(Boolean), null, false);
  return { home, agentDir, workspace, access };
}

function write(filePath, content = "secret") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

test("denies omp and omp-web credential files and their SQLite sidecars", async (t) => {
  const { home, agentDir, access } = await setup(t);
  const credentialFiles = [
    path.join(agentDir, "agent.db"),
    path.join(agentDir, "agent.db-wal"),
    path.join(agentDir, "agent.db-shm"),
    path.join(agentDir, "models.yml"),
    path.join(agentDir, "mcp.json"),
    path.join(agentDir, "omp-web-settings.json"),
    path.join(agentDir, "omp-web", "notifications.db"),
    path.join(agentDir, "omp-web", "notifications.db-wal"),
    path.join(agentDir, "omp-web", "notifications.db-shm"),
    path.join(agentDir, "omp-web", "web-auth-secret.json"),
    path.join(home, ".omp", "run", "daemons", "abc", "broker.token"),
    path.join(home, ".omp", "mcp.json"),
  ];
  for (const file of credentialFiles) write(file);

  for (const file of credentialFiles) {
    const decision = await access(file);
    assert.equal(decision.ok, false, `${path.relative(home, file)} must be denied`);
    assert.equal(decision.status, 403);
  }

  // The same directory still serves ordinary rule files.
  const rules = write(path.join(agentDir, "AGENTS.md"), "# rules\n");
  assert.equal((await access(rules)).ok, true);
});

test("a workspace file with a credential-like name is still served", async (t) => {
  const { workspace, access } = await setup(t);
  const file = write(path.join(workspace, "agent.db"), "fixture");
  assert.equal((await access(file)).ok, true);
});

test("denies a symlink that resolves to a credential file", { skip: process.platform === "win32" }, async (t) => {
  const { agentDir, workspace, access } = await setup(t);
  const database = write(path.join(agentDir, "agent.db"));
  const settings = write(path.join(agentDir, "omp-web-settings.json"));
  const rules = write(path.join(agentDir, "AGENTS.md"), "# rules\n");

  fs.symlinkSync(database, path.join(workspace, "notes.txt"));
  fs.symlinkSync(settings, path.join(workspace, "settings-link"));
  fs.symlinkSync(agentDir, path.join(workspace, "agent-dir"));
  fs.symlinkSync(rules, path.join(workspace, "rules.md"));

  assert.equal((await access(path.join(workspace, "notes.txt"))).ok, false);
  assert.equal((await access(path.join(workspace, "settings-link"))).ok, false);
  assert.equal((await access(path.join(workspace, "agent-dir", "agent.db"))).ok, false);
  assert.equal((await access(path.join(workspace, "agent-dir", "agent.db-wal"))).ok, false);
  // Links to non-credential files in the config root keep working.
  assert.equal((await access(path.join(workspace, "rules.md"))).ok, true);
});

test("denies credentials when ~/.omp is itself a symlink", { skip: process.platform === "win32" }, async (t) => {
  const { home, workspace, access } = await setup(t);
  // Dotfile managers keep the real directory elsewhere and link it into $HOME.
  const real = path.join(home, "dotfiles-omp");
  fs.renameSync(path.join(home, ".omp"), real);
  fs.symlinkSync(real, path.join(home, ".omp"));
  const database = write(path.join(real, "agent", "agent.db"));
  globalThis.__piAllowedRootsCache = undefined;

  fs.symlinkSync(database, path.join(workspace, "innocent.txt"));
  assert.equal((await access(path.join(workspace, "innocent.txt"))).ok, false);
  assert.equal((await access(path.join(home, ".omp", "agent", "agent.db"))).ok, false);
});

async function upload(directory, fileNames, check = false) {
  const { POST } = await jiti.import("../app/api/files/[...path]/route.ts");
  const { NextRequest } = await jiti.import("next/server");
  const segments = directory.replace(/\\/g, "/").split("/").filter(Boolean);
  const form = new FormData();
  for (const name of fileNames) form.append("files", new File(["uploaded"], name));
  return POST(new NextRequest(`http://localhost/api/files/${segments.join("/")}?type=${check ? "upload-check" : "upload"}&conflict=overwrite`, {
    method: "POST",
    body: check ? JSON.stringify({ fileNames }) : form,
  }), { params: Promise.resolve({ path: segments }) });
}

test("global rule browsing never grants upload access to config-owned state", async (t) => {
  const { home, agentDir, access } = await setup(t);
  const rules = write(path.join(agentDir, "AGENTS.md"), "rules");
  assert.equal((await access(rules)).ok, true);
  for (const directory of [agentDir, path.join(home, ".agents"), path.join(home, ".agent")]) {
    fs.mkdirSync(directory, { recursive: true });
    assert.equal((await upload(directory, ["new.txt"], true)).status, 403);
    assert.equal((await upload(directory, ["new.txt"])).status, 403);
    assert.equal(fs.existsSync(path.join(directory, "new.txt")), false);
  }
});

test("a home workspace cannot overwrite credentials, sessions, security state or global rules", async (t) => {
  const { home, agentDir } = await setup(t);
  const { allowFileRoot } = await jiti.import("./file-access.ts");
  allowFileRoot(home);
  const files = [
    path.join(agentDir, "agent.db"),
    path.join(agentDir, "agent.db-wal"),
    path.join(agentDir, "sessions", "project", "session.jsonl"),
    path.join(agentDir, "omp-web", "web-auth-secret.json"),
    path.join(agentDir, "omp-web", "notifications.db"),
    path.join(agentDir, "config.yml"),
    path.join(agentDir, "AGENTS.md"),
    path.join(home, ".omp", "run", "daemons", "abc", "broker.token"),
  ];
  for (const file of files) {
    write(file, "original");
    assert.equal((await upload(path.dirname(file), [path.basename(file)], true)).status, 403, file);
    assert.equal((await upload(path.dirname(file), [path.basename(file)])).status, 403, file);
    assert.equal(fs.readFileSync(file, "utf8"), "original");
  }
});

test("workspace uploads still create and overwrite ordinary project files", async (t) => {
  const { workspace } = await setup(t);
  write(path.join(workspace, "agent.db"), "fixture");
  assert.equal((await upload(workspace, ["agent.db", "new.txt"], true)).status, 200);
  const response = await upload(workspace, ["agent.db", "new.txt"]);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { uploaded: ["agent.db", "new.txt"], skipped: [], errors: [] });
  assert.equal(fs.readFileSync(path.join(workspace, "agent.db"), "utf8"), "uploaded");
  assert.equal(fs.readFileSync(path.join(workspace, "new.txt"), "utf8"), "uploaded");
  const projectConfig = path.join(workspace, ".omp");
  fs.mkdirSync(projectConfig);
  assert.equal((await upload(projectConfig, ["project.txt"])).status, 200);
});

test("upload directory symlinks keep workspace access but cannot reach config-owned state", { skip: process.platform === "win32" }, async (t) => {
  const { home, agentDir, workspace } = await setup(t);
  const { allowFileRoot } = await jiti.import("./file-access.ts");
  allowFileRoot(home);
  fs.symlinkSync(agentDir, path.join(workspace, "agent-link"));
  assert.equal((await upload(path.join(workspace, "agent-link"), ["new.txt"])).status, 403);
  assert.equal(fs.existsSync(path.join(agentDir, "new.txt")), false);
  fs.mkdirSync(path.join(workspace, "uploads"));
  fs.symlinkSync(path.join(workspace, "uploads"), path.join(workspace, "upload-link"));
  assert.equal((await upload(path.join(workspace, "upload-link"), ["new.txt"])).status, 200);
  assert.equal(fs.readFileSync(path.join(workspace, "uploads", "new.txt"), "utf8"), "uploaded");
});

test("config state remains write-protected when dotfiles are symlinked into a workspace", { skip: process.platform === "win32" }, async (t) => {
  const { home, workspace } = await setup(t);
  const target = path.join(workspace, "dotfiles");
  fs.renameSync(path.join(home, ".omp"), target);
  fs.symlinkSync(target, path.join(home, ".omp"));
  const stateDir = path.join(target, "agent", "omp-web");
  write(path.join(stateDir, "web-auth-secret.json"), "original");
  assert.equal((await upload(stateDir, ["web-auth-secret.json"])).status, 403);
  assert.equal(fs.readFileSync(path.join(stateDir, "web-auth-secret.json"), "utf8"), "original");
});

test("XDG-relocated native session state is protected inside a home workspace", { skip: process.platform !== "linux" && process.platform !== "darwin" }, async (t) => {
  const { home } = await setup(t);
  const { allowFileRoot } = await jiti.import("./file-access.ts");
  allowFileRoot(home);
  process.env.XDG_DATA_HOME = path.join(home, ".local", "share");
  const session = write(path.join(process.env.XDG_DATA_HOME, "omp", "sessions", "project", "session.jsonl"), "original");
  assert.equal((await upload(path.dirname(session), ["session.jsonl"])).status, 403);
  assert.equal(fs.readFileSync(session, "utf8"), "original");
});

test("an overridden native agent directory stays protected inside an allowed workspace", async (t) => {
  const { workspace } = await setup(t);
  const agentDir = path.join(workspace, "native-state");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const secret = write(path.join(agentDir, "agent.db"), "original");
  globalThis.__piAllowedRootsCache = undefined;
  assert.equal((await upload(agentDir, ["agent.db"])).status, 403);
  assert.equal(fs.readFileSync(secret, "utf8"), "original");
  assert.equal((await upload(workspace, ["project.txt"])).status, 200);
});

test("a directory replaced while the upload body arrives cannot redirect writes into native state", { skip: process.platform === "win32" }, async (t) => {
  const { workspace, agentDir } = await setup(t);
  const { POST } = await jiti.import("../app/api/files/[...path]/route.ts");
  const { NextRequest } = await jiti.import("next/server");
  const directory = path.join(workspace, "uploads");
  fs.mkdirSync(directory);
  const database = write(path.join(agentDir, "agent.db"), "original");
  const form = new FormData();
  form.append("files", new File(["injected"], "agent.db"));
  const encoded = new Request("http://localhost/", { method: "POST", body: form });
  const bytes = new Uint8Array(await encoded.arrayBuffer());
  const body = new ReadableStream({
    pull(controller) {
      fs.rmdirSync(directory);
      fs.symlinkSync(agentDir, directory);
      controller.enqueue(bytes);
      controller.close();
    },
  }, { highWaterMark: 0 });
  const segments = directory.split("/").filter(Boolean);
  const response = await POST(new NextRequest("http://localhost/api/files/uploads?conflict=overwrite", {
    method: "POST",
    headers: { "content-type": encoded.headers.get("content-type") },
    body,
    duplex: "half",
  }), { params: Promise.resolve({ path: segments }) });
  assert.equal(response.status, 403);
  assert.equal(fs.readFileSync(database, "utf8"), "original");
});
