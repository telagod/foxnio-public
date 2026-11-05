import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@/": new URL("../", import.meta.url).pathname },
});

// A shell stand-in for `omp`: records its argument vector and answers `plugin list`.
const skip = process.platform === "win32" ? "needs a POSIX shell script as the omp binary" : false;

async function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-web-plugins-route-")));
  const log = path.join(root, "calls.log");
  const bin = path.join(root, "fake-omp");
  fs.writeFileSync(bin, [
    "#!/bin/sh",
    `for arg in "$@"; do printf '%s\\n' "$arg" >> '${log}'; done`,
    `printf -- '--END--\\n' >> '${log}'`,
    'if [ "$2" = "list" ]; then echo \'{"npm":[],"marketplace":[]}\'; fi',
    "",
  ].join("\n"), { mode: 0o755 });
  const previous = { bin: process.env.OMP_WEB_OMP_BIN, agent: process.env.PI_CODING_AGENT_DIR };
  process.env.OMP_WEB_OMP_BIN = bin;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  t.after(() => {
    for (const [key, value] of [["OMP_WEB_OMP_BIN", previous.bin], ["PI_CODING_AGENT_DIR", previous.agent]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.__piAllowedRootsCache = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const { allowFileRoot } = await jiti.import("./file-access.ts");
  const { POST } = await jiti.import("../app/api/plugins/route.ts");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  allowFileRoot(workspace);
  globalThis.__piAllowedRootsCache = undefined;

  const post = (body) => POST(new Request("http://localhost/api/plugins", {
    method: "POST",
    body: JSON.stringify({ cwd: workspace, ...body }),
  }));
  /** Argument vectors of every omp invocation so far, in order. */
  const calls = () => {
    if (!fs.existsSync(log)) return [];
    return fs.readFileSync(log, "utf8").split("--END--\n").filter(Boolean).map((chunk) => chunk.split("\n").filter(Boolean));
  };
  return { post, calls };
}

test("refuses a plugin source that would be parsed as an omp option", { skip }, async (t) => {
  const { post, calls } = await setup(t);
  for (const action of ["install", "remove", "update", "enable", "disable"]) {
    for (const source of ["--force", "-l", "--set=key=value", "  --dry-run"]) {
      const response = await post({ action, source });
      assert.equal(response.status, 400, `${action} ${source}`);
      assert.equal((await response.json()).code, "source_invalid");
    }
  }
  assert.deepEqual(calls(), [], "omp is never started for a rejected source");
});

test("passes the source after `--`, behind every flag", { skip }, async (t) => {
  const { post, calls } = await setup(t);

  assert.equal((await post({ action: "install", source: " @scope/pkg@1.2.3 ", scope: "project" })).status, 200);
  assert.equal((await post({ action: "remove", source: "pkg" })).status, 200);
  assert.equal((await post({ action: "update" })).status, 200);
  assert.equal((await post({ action: "update", source: "pkg", scope: "project" })).status, 200);
  assert.equal((await post({ action: "disable", source: "pkg" })).status, 200);

  const mutations = calls().filter((args) => args[1] !== "list");
  assert.deepEqual(mutations, [
    ["plugin", "install", "--json", "--scope", "project", "--", "@scope/pkg@1.2.3"],
    ["plugin", "uninstall", "--json", "--", "pkg"],
    ["plugin", "upgrade"],
    ["plugin", "upgrade", "--scope", "project", "--", "pkg"],
    ["plugin", "disable", "--json", "--", "pkg"],
  ]);
});
