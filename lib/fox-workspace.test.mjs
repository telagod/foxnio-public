import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { ensureFoxWorkspace, foxWorkspaceDir } = await jiti.import("./fox-workspace.ts");

test("creates the FOX cwd and persona on first use", () => {
  const home = mkdtempSync(join(tmpdir(), "fox-home-"));
  try {
    const cwd = ensureFoxWorkspace(home);
    assert.equal(cwd, foxWorkspaceDir(home));
    const persona = readFileSync(join(cwd, "AGENTS.md"), "utf8");
    assert.match(persona, /FOX/);
    assert.match(persona, /Cross-project coordinator/i);
    assert.match(persona, /send_to_session/);
    assert.match(persona, /new_session/);
    assert.match(persona, /worker session/);
    assert.match(persona, /Never redirect a request to an arbitrary session/);
    assert.match(persona, /Never edit project files/);
    assert.match(persona, /Proactive observation/);
    assert.match(persona, /server wake/);
    assert.match(persona, /OMP's todo/);
    assert.match(persona, /tool_call hook/);
    assert.match(persona, /There is no taskId/);
    assert.doesNotMatch(persona, /use the workspace tools/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("never overwrites a persona the user has edited", () => {
  const home = mkdtempSync(join(tmpdir(), "fox-home-"));
  try {
    const cwd = ensureFoxWorkspace(home);
    const persona = join(cwd, "AGENTS.md");
    writeFileSync(persona, "my custom chief\n", "utf8");
    ensureFoxWorkspace(home);
    assert.equal(readFileSync(persona, "utf8"), "my custom chief\n");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
