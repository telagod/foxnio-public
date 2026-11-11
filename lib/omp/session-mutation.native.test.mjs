import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { nativeEnvironment, writeInertAgentConfig } from "../../tests/omp-native-env.mjs";

const enabled = process.env.OMP_WEB_TEST_NATIVE_COMPAT === "1";
test("offline mutations respect a native writer lease and cross-project parent lineage", { skip: !enabled, timeout: 120_000 }, async () => {
  const jiti = createJiti(import.meta.url);
  const { resolveOmpBin } = await jiti.import("./omp-cli.ts");
  const binary = resolveOmpBin();
  assert.ok(binary);
  const root = mkdtempSync(join(tmpdir(), "foxnio-native-mutation-"));
  const physicalAgentDir = join(root, "physical-agent");
  mkdirSync(physicalAgentDir);
  const agentDir = join(root, "agent");
  symlinkSync(physicalAgentDir, agentDir, process.platform === "win32" ? "junction" : "dir");
  const env = nativeEnvironment(root, agentDir);
  for (const key of Object.keys(process.env)) if (key !== "NODE_TEST_CONTEXT") delete process.env[key];
  Object.assign(process.env, env, { OMP_WEB_OMP_BIN: binary });
  writeInertAgentConfig(agentDir, { provider: "fixture", model: "offline", api: "openai-completions", apiKey: "inert" });
  const { RpcProcess } = await jiti.import("./rpc-process.ts");
  const { mutateSession } = await jiti.import("./session-mutation.ts");
  const cwd = join(root, "workspace");
  mkdirSync(cwd);
  const dir = join(agentDir, "sessions", "project");
  mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  const file = join(dir, `${id}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: new Date().toISOString() }) + "\n");
  const owner = new RpcProcess({ cwd, extraArgs: ["--resume", file, "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "--no-lsp", "--no-title", "--model", "fixture/offline"] });
  try {
    await owner.negotiateProtocol(await owner.waitReady(60_000));
    await owner.sendCommand({ type: "bash", command: "true" });
    // Ensure the original file, not a continuation copy, is held by this writer.
    const state = await owner.sendCommand({ type: "get_state" });
    assert.equal(state.sessionId, id);
    const before = readFileSync(file);
    for (const action of ["rename", "delete", "archive"]) {
      await assert.rejects(mutateSession({ action, sessionId: id, filePath: file, name: "unsafe" }), { code: "session_busy" });
      assert.deepEqual(readFileSync(file), before);
    }
    await owner.dispose();
    await mutateSession({ action: "rename", sessionId: id, filePath: file, name: "owned safely" });
    assert.match(readFileSync(file, "utf8"), /owned safely/);
    const other = join(agentDir, "sessions", "other-project");
    mkdirSync(other);
    const childId = randomUUID();
    const childFile = join(other, `${childId}.jsonl`);
    writeFileSync(childFile, JSON.stringify({ type: "session", version: 3, id: childId, cwd, parentSession: file, timestamp: new Date().toISOString() }) + "\n");
    for (const action of ["delete", "archive"]) await assert.rejects(mutateSession({ action, sessionId: id, filePath: file }), { code: "session_has_children" });
    assert.equal(existsSync(file), true);
    await mutateSession({ action: "delete", sessionId: childId, filePath: childFile });
    assert.equal(existsSync(childFile), false);
    const { archivedPath } = await mutateSession({ action: "archive", sessionId: id, filePath: file });
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(archivedPath), true);
  } finally {
    await owner.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
