import assert from "node:assert/strict";
import test from "node:test";
import {
  isSupportedNodeVersion,
  nodeExecutableName,
  parseNodeMajor,
  pathCandidates,
  resolveNodeBinary,
} from "./node-runtime.cjs";

test("requires Node.js 24 or newer", () => {
  assert.equal(parseNodeMajor("v24.17.0"), 24);
  assert.equal(isSupportedNodeVersion("v24.0.0"), true);
  assert.equal(isSupportedNodeVersion("v23.11.1"), false);
  assert.equal(isSupportedNodeVersion("not a version"), false);
});

test("uses the packaged runtime before PATH", () => {
  const candidates = pathCandidates({
    appRoot: "/opt/foxnio/app",
    resourcesPath: "/opt/foxnio/resources",
    platform: "linux",
    env: { OMP_WEB_NODE_BIN: "/custom/node", PATH: "/usr/bin" },
  });
  assert.deepEqual(candidates.slice(0, 4), [
    "/custom/node",
    "/opt/foxnio/resources/node/node",
    "/opt/foxnio/app/desktop/runtime/node/node",
    "/usr/bin/node",
  ]);
});

test("never accepts Electron as the Node runtime", () => {
  const selected = resolveNodeBinary({
    candidates: ["/electron", "/node24"],
    probe: (candidate) => candidate === "/node24",
  });
  assert.equal(selected, "/node24");
  assert.equal(nodeExecutableName("win32"), "node.exe");
});

test("reports a clear error when no supported runtime exists", () => {
  assert.throws(
    () => resolveNodeBinary({ candidates: ["/node18"], probe: () => false }),
    /Node\.js >= 24.*OMP_WEB_NODE_BIN/,
  );
});
