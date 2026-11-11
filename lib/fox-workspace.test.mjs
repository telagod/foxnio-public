import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { ensureFoxWorkspace } = await jiti.import("./fox-workspace.ts");


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
