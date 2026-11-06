import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { enableProvider, readModelRoles, updateModelRoles } = await jiti.import("./model-roles.ts");

function withAgentDir(run) {
  const dir = mkdtempSync(join(tmpdir(), "omp-web-model-roles-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    run(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("updating roles keeps the rest of config.yml, comments included", () => {
  withAgentDir((dir) => {
    const path = join(dir, "config.yml");
    writeFileSync(path, "# mine\npersonality: friendly # keep\ndisabledProviders: [openai]\n", "utf8");
    assert.deepEqual(updateModelRoles({ default: "anthropic/claude-sonnet" }), { default: "anthropic/claude-sonnet" });
    assert.deepEqual(readModelRoles().roles, { default: "anthropic/claude-sonnet" });
    const text = readFileSync(path, "utf8");
    assert.match(text, /# mine/);
    assert.match(text, /personality: friendly # keep/);
    assert.match(text, /disabledProviders:/);
  });
});

test("only the named roles change; roles set elsewhere meanwhile survive", () => {
  withAgentDir((dir) => {
    const path = join(dir, "config.yml");
    writeFileSync(path, "modelRoles:\n  default: a/one # pinned\n  smol: a/small\n  plan: a/plan\n", "utf8");

    // The editor loaded this state, then another tab changed `plan` and added `slow`.
    writeFileSync(path, "modelRoles:\n  default: a/one # pinned\n  smol: a/small\n  plan: b/plan2\n  slow: b/slow\n", "utf8");

    const roles = updateModelRoles({ default: "c/three", smol: "" });
    assert.deepEqual(roles, { default: "c/three", plan: "b/plan2", slow: "b/slow" });
    assert.match(readFileSync(path, "utf8"), /# pinned/);
  });
});

test("roles the editor no longer lists (omp's removed `designer`) survive saving other roles", () => {
  withAgentDir((dir) => {
    writeFileSync(join(dir, "config.yml"), "modelRoles:\n  designer: a/design # legacy\n  default: a/one\n", "utf8");
    assert.deepEqual(updateModelRoles({ memory: "a/mem", widget: "a/widget:low" }), { designer: "a/design", default: "a/one", memory: "a/mem", widget: "a/widget:low" });
    assert.match(readFileSync(join(dir, "config.yml"), "utf8"), /designer: a\/design # legacy/);
  });
});

test("an empty selector removes the role, and a missing config.yml is created", () => {
  withAgentDir((dir) => {
    assert.deepEqual(updateModelRoles({ default: "a/b", smol: "  " }), { default: "a/b" });
    assert.deepEqual(updateModelRoles({ default: "" }), {});
    assert.match(readFileSync(join(dir, "config.yml"), "utf8"), /modelRoles/);
  });
});

test("a non-mapping modelRoles value is replaced by a mapping", () => {
  withAgentDir((dir) => {
    writeFileSync(join(dir, "config.yml"), "modelRoles: none\npersonality: friendly\n", "utf8");
    assert.deepEqual(updateModelRoles({ default: "a/b" }), { default: "a/b" });
    assert.match(readFileSync(join(dir, "config.yml"), "utf8"), /personality: friendly/);
  });
});

test("config.yml written for roles or provider re-enabling stays private", { skip: process.platform === "win32" }, () => {
  withAgentDir((dir) => {
    const path = join(dir, "config.yml");
    updateModelRoles({ default: "a/b" });
    assert.equal(statSync(path).mode & 0o777, 0o600);

    chmodSync(path, 0o640);
    writeFileSync(path, "disabledProviders: [openai, anthropic]\n", { mode: 0o640 });
    enableProvider("openai");
    assert.equal(statSync(path).mode & 0o777, 0o640);
    assert.match(readFileSync(path, "utf8"), /anthropic/);
    assert.doesNotMatch(readFileSync(path, "utf8"), /openai/);
    assert.deepEqual(readdirSync(dir), ["config.yml"]);
  });
});
