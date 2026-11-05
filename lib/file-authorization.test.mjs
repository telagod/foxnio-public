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
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-file-auth-")));
  t.after(() => {
    for (const key of ENV_KEYS) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    globalThis.__piAllowedRootsCache = undefined;
    fs.rmSync(home, { recursive: true, force: true });
  });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  for (const key of ["PI_CODING_AGENT_DIR", "PI_CONFIG_DIR", "XDG_DATA_HOME"]) delete process.env[key];

  const agentDir = path.join(home, ".omp", "agent");
  fs.mkdirSync(path.join(agentDir, "omp-web"), { recursive: true });
  fs.mkdirSync(path.join(home, ".omp", "run", "daemons", "abc"), { recursive: true });
  const workspace = path.join(home, "workspace");
  fs.mkdirSync(workspace);
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
