import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createJiti } from "jiti";

/**
 * Mocks the `omp` child. `answer(command, spawnIndex)` returns the response
 * `data`, or `undefined` to leave the command unanswered (a wedged child).
 */
async function utilityFixture(t, answer) {
  const previousBin = process.env.OMP_WEB_OMP_BIN;
  process.env.OMP_WEB_OMP_BIN = process.execPath;
  const children = [];
  const spawnMock = t.mock.method(childProcess, "spawn", () => {
    const index = children.length;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      commands: [],
      killed: false,
      kill() {
        child.killed = true;
        queueMicrotask(() => child.emit("exit", 0, null));
        return true;
      },
    });
    let pending = "";
    child.stdin.on("data", (chunk) => {
      pending += chunk.toString();
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const command = JSON.parse(line);
        child.commands.push(command.type);
        const data = command.type === "negotiate_protocol" ? { protocolVersion: 2 } : answer(command, index);
        if (data === undefined) continue;
        child.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data }) + "\n");
      }
    });
    child.stdin.on("end", () => queueMicrotask(() => child.emit("exit", 0, null)));
    queueMicrotask(() => child.stdout.write(`${JSON.stringify({ type: "ready", supportedProtocolVersions: [1, 2] })}\n`));
    children.push(child);
    return child;
  });
  syncBuiltinESMExports();
  const isolated = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
  const utility = await isolated.import("./rpc-utility.ts");
  t.after(() => {
    utility.disposeUtilityRpc();
    globalThis.__ompUtilityRpcState = undefined;
    spawnMock.mock.restore();
    syncBuiltinESMExports();
    if (previousBin === undefined) delete process.env.OMP_WEB_OMP_BIN;
    else process.env.OMP_WEB_OMP_BIN = previousBin;
  });
  globalThis.__ompUtilityRpcState = undefined;
  return { ...utility, children };
}

test("utility RPC processes negotiate v2 before the first command and are reused", async (t) => {
  const { runUtilityCommand, children } = await utilityFixture(t, (command) => ({ echo: command.type }));

  assert.deepEqual(await runUtilityCommand({ type: "get_models" }), { echo: "get_models" });
  assert.deepEqual(await runUtilityCommand({ type: "get_login_providers" }), { echo: "get_login_providers" });

  assert.equal(children.length, 1, "later commands reuse the shared process");
  assert.deepEqual(children[0].commands, ["negotiate_protocol", "get_models", "get_login_providers"]);
});

test("a timed-out command disposes the wedged utility process so the next command gets a fresh one", async (t) => {
  // Only the first child hangs; its replacement answers normally.
  const { runUtilityCommand, children } = await utilityFixture(t, (command, spawnIndex) => (spawnIndex === 0 ? undefined : { fresh: command.type }));

  await assert.rejects(runUtilityCommand({ type: "get_models" }, 30), { name: "RpcCommandTimeoutError" });
  assert.equal(children.length, 1);

  assert.deepEqual(await runUtilityCommand({ type: "get_models" }, 1000), { fresh: "get_models" });
  assert.equal(children.length, 2, "the wedged child was not reused");
  assert.equal(children[0].killed || children[0].stdin.writableEnded, true, "the wedged child is shut down");
});
