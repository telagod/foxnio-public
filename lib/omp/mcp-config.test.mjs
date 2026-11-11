import assert from "node:assert/strict";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { deleteMcpServer, parseMcpListOutput, readDiscoveredMcpServers, readMcpConfig, readUserMcpConfig, redactMcpServer, validateMcpServer, writeMcpServer } = await jiti.import("./mcp-config.ts");

function withWorkspace(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-mcp-config-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("writes, renames, and removes a native project MCP server", () => {
  withWorkspace((cwd) => {
    writeMcpServer(cwd, "filesystem", { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] });
    let file = readMcpConfig(cwd);
    assert.match(file.path.replace(/\\/g, "/"), /\.omp\/mcp\.json$/);
    assert.equal(file.config.mcpServers.filesystem.command, "npx");

    writeMcpServer(cwd, "project-files", { type: "stdio", command: "npx", args: [] }, "filesystem");
    file = readMcpConfig(cwd);
    assert.deepEqual(Object.keys(file.config.mcpServers), ["project-files"]);

    deleteMcpServer(cwd, "project-files");
    assert.deepEqual(readMcpConfig(cwd).config.mcpServers, {});
  });
});

test("redacts project MCP credentials and preserves them on edits and renames", () => {
  withWorkspace((cwd) => {
    writeMcpServer(cwd, "private", { type: "stdio", command: "node", env: { API_KEY: "secret" }, headers: { Authorization: "Bearer secret" } });
    const stored = readMcpConfig(cwd).config.mcpServers.private;
    assert.deepEqual(redactMcpServer(stored), { type: "stdio", command: "node" });
    writeMcpServer(cwd, "private", { type: "stdio", command: "node", args: ["server.js"] });
    assert.deepEqual(readMcpConfig(cwd).config.mcpServers.private.env, { API_KEY: "secret" });
    assert.deepEqual(readMcpConfig(cwd).config.mcpServers.private.headers, { Authorization: "Bearer secret" });
    writeMcpServer(cwd, "renamed", { type: "stdio", command: "node", args: ["renamed.js"] }, "private");
    const renamed = readMcpConfig(cwd).config.mcpServers;
    assert.equal(renamed.private, undefined);
    assert.deepEqual(renamed.renamed.env, { API_KEY: "secret" });
    assert.deepEqual(renamed.renamed.headers, { Authorization: "Bearer secret" });
  });
});

test("rejects malformed MCP transports before writing", () => {
  assert.throws(() => validateMcpServer("bad server", { command: "npx" }), /Server name/);
  assert.throws(() => validateMcpServer("bad", { type: "http", command: "npx" }), /requires a URL/);
  assert.throws(() => validateMcpServer("bad", { command: "npx", url: "https://example.com/mcp" }), /exactly one/);
  assert.throws(() => validateMcpServer("bad", { type: "sse", url: "file:///tmp/mcp" }), /http or https/);
});

test("reads OMP user MCP servers and disabled entries", () => {
  withWorkspace((cwd) => {
    const userPath = join(cwd, "user-mcp.json");
    writeFileSync(userPath, JSON.stringify({
      mcpServers: { ida: { command: "python", args: ["server.py"] } },
      disabledServers: ["node_repl"],
    }));

    const config = readUserMcpConfig(userPath);
    assert.deepEqual(config.servers.map(({ name }) => name), ["ida"]);
    assert.deepEqual(config.disabledServers, ["node_repl"]);
  });
});

test("parses every source and connection state from OMP's MCP list", () => {
  const servers = parseMcpListOutput(`\nConfigured MCP Servers\n\nUser level (~/.omp/agent/mcp.json):\n  ida ● connected [stdio]\n  frida ○ not connected [stdio]\n\nProject level (.omp/mcp.json):\n  docs ◌ connecting [http]\n\nClaude Code (~/.claude.json):\n  ida-reverse-engineering ● connected\n\nDisabled (discovered servers):\n  node_repl ◌ disabled\n`);
  assert.deepEqual(servers, [
    { name: "ida", source: "User level", status: "connected", type: "stdio" },
    { name: "frida", source: "User level", status: "not_connected", type: "stdio" },
    { name: "docs", source: "Project level", status: "connecting", type: "http" },
    { name: "ida-reverse-engineering", source: "Claude Code", status: "connected", type: undefined },
    { name: "node_repl", source: "Disabled", status: "disabled", type: undefined },
  ]);
});

test("parses rpc-ui's compact MCP list without claiming configured servers are connected", () => {
  assert.deepEqual(parseMcpListOutput("ida | stdio | enabled | python [user]\nfrida | stdio | disabled | frida serve [project]"), [
    { name: "ida", source: "User level", status: "configured", type: "stdio" },
    { name: "frida", source: "Project level", status: "disabled", type: "stdio" },
  ]);
});

test("serializes concurrent mutations through the config lock (no lost updates)", () => {
  withWorkspace((cwd) => {
    // Simulate two writers racing: each read-modify-write must re-read inside
    // the lock, so the second mutation preserves the first's server.
    writeMcpServer(cwd, "alpha", { type: "stdio", command: "python", args: ["a.py"] });
    writeMcpServer(cwd, "beta", { type: "stdio", command: "python", args: ["b.py"] });
    const file = readMcpConfig(cwd);
    assert.deepEqual(Object.keys(file.config.mcpServers).sort(), ["alpha", "beta"]);
    // Lock files must not leak after successful writes.
    assert.equal(existsSync(`${file.path}.lock`), false);
    assert.equal(existsSync(`${file.path}.tmp-${process.pid}-`), false);
  });
});

test("breaks a stale config lock from a crashed writer", () => {
  withWorkspace((cwd) => {
    const { path } = readMcpConfig(cwd);
    const lockPath = `${path}.lock`;
    // A lock file left behind by a crashed process, aged past the stale window.
    mkdirSync(join(dirname(lockPath)), { recursive: true });
    const fd = openSync(lockPath, "wx");
    closeSync(fd);
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lockPath, stale, stale);

    writeMcpServer(cwd, "recovered", { type: "stdio", command: "python", args: ["r.py"] });
    const file = readMcpConfig(cwd);
    assert.equal(file.config.mcpServers.recovered.command, "python");
    assert.equal(existsSync(lockPath), false);
  });
});

test("a new project mcp.json is owner-only and an existing mode survives edits", { skip: process.platform === "win32" }, () => {
  withWorkspace((cwd) => {
    writeMcpServer(cwd, "private", { type: "stdio", command: "node", env: { API_KEY: "secret" } });
    const { path } = readMcpConfig(cwd);
    assert.equal(statSync(path).mode & 0o777, 0o600);

    chmodSync(path, 0o664);
    writeMcpServer(cwd, "second", { type: "stdio", command: "node" });
    assert.equal(statSync(path).mode & 0o777, 0o664);
    deleteMcpServer(cwd, "second");
    assert.equal(statSync(path).mode & 0o777, 0o664);
    assert.deepEqual(readdirSync(dirname(path)).filter((name) => name.includes(".tmp-")), []);
  });
});

test("editing a symlinked mcp.json writes through the link", { skip: process.platform === "win32" }, () => {
  withWorkspace((cwd) => {
    const shared = join(cwd, "shared-mcp.json");
    writeFileSync(shared, JSON.stringify({ mcpServers: {} }), "utf8");
    mkdirSync(join(cwd, ".omp"), { recursive: true });
    const link = join(cwd, ".omp", "mcp.json");
    symlinkSync(shared, link);

    writeMcpServer(cwd, "linked", { type: "stdio", command: "node" });

    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(JSON.parse(readFileSync(shared, "utf8")).mcpServers.linked.command, "node");
  });
});

test("rejects project MCP file symlinks outside the canonical project without modifying the target", { skip: process.platform === "win32" }, () => {
  withWorkspace((base) => {
    const cwd = join(base, "project");
    mkdirSync(join(cwd, ".omp"), { recursive: true });
    const target = join(base, "private.json");
    const original = JSON.stringify({ mcpServers: { private: { command: "node" } } });
    writeFileSync(target, original);
    symlinkSync(target, join(cwd, ".omp", "mcp.json"));
    assert.throws(() => readMcpConfig(cwd), /MCP configuration.*outside.*project/i);
    assert.throws(() => writeMcpServer(cwd, "injected", { command: "node" }), /MCP configuration.*outside.*project/i);
    assert.throws(() => deleteMcpServer(cwd, "private"), /MCP configuration.*outside.*project/i);
    assert.equal(readFileSync(target, "utf8"), original);
    assert.equal(existsSync(`${target}.lock`), false);
  });
});

test("rejects external MCP directory symlinks for both existing and missing config targets", { skip: process.platform === "win32" }, () => {
  for (const existing of [false, true]) {
    withWorkspace((base) => {
      const cwd = join(base, "project");
      const outside = join(base, "outside");
      mkdirSync(cwd);
      mkdirSync(outside);
      symlinkSync(outside, join(cwd, ".omp"));
      const target = join(outside, "mcp.json");
      if (existing) writeFileSync(target, '{"mcpServers":{}}');
      assert.throws(() => readMcpConfig(cwd), /MCP configuration.*outside.*project/i);
      assert.throws(() => writeMcpServer(cwd, "injected", { command: "node" }), /MCP configuration.*outside.*project/i);
      assert.deepEqual(readdirSync(outside), existing ? ["mcp.json"] : []);
      if (existing) assert.equal(readFileSync(target, "utf8"), '{"mcpServers":{}}');
    });
  }
});

test("rejects an external parent even when the MCP file links back into the project", { skip: process.platform === "win32" }, () => {
  withWorkspace((base) => {
    const cwd = join(base, "project");
    const outside = join(base, "outside");
    mkdirSync(cwd);
    mkdirSync(outside);
    const target = join(cwd, "shared.json");
    writeFileSync(target, '{"mcpServers":{}}');
    symlinkSync(target, join(outside, "mcp.json"));
    symlinkSync(outside, join(cwd, ".omp"));
    assert.throws(() => readMcpConfig(cwd), /MCP configuration.*outside.*project/i);
    assert.throws(() => writeMcpServer(cwd, "injected", { command: "node" }), /MCP configuration.*outside.*project/i);
    assert.equal(readFileSync(target, "utf8"), '{"mcpServers":{}}');
  });
});

test("rejects dangling external MCP symlinks rather than falling back to a different config", { skip: process.platform === "win32" }, () => {
  for (const linkDirectory of [false, true]) {
    withWorkspace((base) => {
      const cwd = join(base, "project");
      mkdirSync(cwd);
      const outside = join(base, "missing", linkDirectory ? "config" : "mcp.json");
      if (linkDirectory) symlinkSync(outside, join(cwd, ".omp"));
      else {
        mkdirSync(join(cwd, ".omp"));
        symlinkSync(outside, join(cwd, ".omp", "mcp.json"));
      }
      assert.throws(() => readMcpConfig(cwd), /MCP configuration.*outside.*project/i);
      assert.throws(() => writeMcpServer(cwd, "injected", { command: "node" }), /MCP configuration.*outside.*project/i);
      assert.equal(existsSync(join(base, "missing")), false);
    });
  }
});

test("internal MCP directory symlinks and missing internal file targets remain writable", { skip: process.platform === "win32" }, () => {
  withWorkspace((cwd) => {
    const configDir = join(cwd, "config");
    mkdirSync(configDir);
    symlinkSync(configDir, join(cwd, ".omp"));
    const shared = join(cwd, "private", "mcp.json");
    const link = join(configDir, "mcp.json");
    symlinkSync(shared, link);
    assert.equal(readMcpConfig(cwd).exists, false);
    writeMcpServer(cwd, "linked", { command: "node" });
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readMcpConfig(cwd).config.mcpServers.linked.command, "node");
    assert.equal(JSON.parse(readFileSync(shared, "utf8")).mcpServers.linked.command, "node");
    deleteMcpServer(cwd, "linked");
    assert.deepEqual(JSON.parse(readFileSync(shared, "utf8")).mcpServers, {});
    assert.equal(lstatSync(join(cwd, ".omp")).isSymbolicLink(), true);
  });
});

test("internal MCP aliases use the canonical target lock and recover stale locks", { skip: process.platform === "win32" }, () => {
  withWorkspace((cwd) => {
    const target = join(cwd, "shared.json");
    writeFileSync(target, '{"mcpServers":{}}');
    mkdirSync(join(cwd, ".omp"));
    symlinkSync(target, join(cwd, ".omp", "mcp.json"));
    const lock = `${target}.lock`;
    writeFileSync(lock, "crashed");
    const stale = new Date(Date.now() - 60_000);
    utimesSync(lock, stale, stale);
    writeMcpServer(cwd, "linked", { command: "node" });
    assert.equal(existsSync(lock), false);
    assert.equal(existsSync(join(cwd, ".omp", "mcp.json.lock")), false);
    assert.equal(JSON.parse(readFileSync(target, "utf8")).mcpServers.linked.command, "node");
  });
});

test("a symlinked workspace uses its canonical project root", { skip: process.platform === "win32" }, () => {
  withWorkspace((base) => {
    const project = join(base, "project");
    const alias = join(base, "alias");
    mkdirSync(project);
    symlinkSync(project, alias);
    writeMcpServer(alias, "linked", { command: "node" });
    assert.equal(readMcpConfig(project).config.mcpServers.linked.command, "node");
    assert.equal(lstatSync(alias).isSymbolicLink(), true);
  });
});

test("project MCP discovery rejects external config files but preserves internal aliases", { skip: process.platform === "win32" }, (t) => {
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
  });
  withWorkspace((base) => {
    const home = join(base, "home");
    const cwd = join(base, "project");
    mkdirSync(home);
    process.env.HOME = process.env.USERPROFILE = home;
    mkdirSync(join(cwd, ".cursor"), { recursive: true });
    const target = join(base, "private.json");
    writeFileSync(target, '{"mcpServers":{"external":{"command":"node"}}}');
    const link = join(cwd, ".cursor", "mcp.json");
    symlinkSync(target, link);
    assert.throws(() => readDiscoveredMcpServers(cwd), /MCP configuration.*outside.*project/i);
    rmSync(link);
    const internal = join(cwd, "shared.json");
    writeFileSync(internal, '{"mcpServers":{"internal":{"command":"node"}}}');
    symlinkSync(internal, link);
    assert.deepEqual(readDiscoveredMcpServers(cwd).map(({ name, source }) => ({ name, source })), [
      { name: "internal", source: "Cursor" },
    ]);
  });
});
