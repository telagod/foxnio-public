"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MIN_NODE_MAJOR = 24;

function nodeExecutableName(platform = process.platform) {
  return platform === "win32" ? "node.exe" : "node";
}

function parseNodeMajor(versionOutput) {
  const match = /^v?(\d+)(?:\.|$)/.exec(String(versionOutput).trim());
  return match ? Number(match[1]) : NaN;
}

function isSupportedNodeVersion(versionOutput) {
  return parseNodeMajor(versionOutput) >= MIN_NODE_MAJOR;
}

function pathCandidates(options = {}) {
  const {
    appRoot = process.cwd(),
    resourcesPath,
    env = process.env,
    platform = process.platform,
    pathEnv = env.PATH ?? env.Path ?? "",
  } = options;
  const executable = nodeExecutableName(platform);
  const candidates = [];
  const add = (candidate) => {
    if (typeof candidate !== "string" || candidate.length === 0) return;
    const resolved = path.resolve(candidate);
    if (!candidates.includes(resolved)) candidates.push(resolved);
  };

  add(env.OMP_WEB_NODE_BIN);
  if (resourcesPath) add(path.join(resourcesPath, "node", executable));
  add(path.join(appRoot, "desktop", "runtime", "node", executable));

  for (const directory of String(pathEnv).split(path.delimiter)) {
    if (directory) add(path.join(directory, executable));
  }
  if (platform !== "win32") add(path.join("/usr", "local", "bin", executable));
  add(path.join(os.homedir(), ".local", "bin", executable));
  return candidates;
}

function probeNode(candidate, run = spawnSync) {
  try {
    if (!fs.existsSync(candidate)) return false;
    const result = run(candidate, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return result.status === 0 && isSupportedNodeVersion(result.stdout);
  } catch {
    return false;
  }
}

function resolveNodeBinary(options = {}) {
  const candidates = options.candidates ?? pathCandidates(options);
  const probe = options.probe ?? ((candidate) => probeNode(candidate));
  for (const candidate of candidates) {
    if (probe(candidate)) return candidate;
  }
  throw new Error(
    `Node.js >= ${MIN_NODE_MAJOR} is required to run foxnio. ` +
    "Install Node.js 24 or set OMP_WEB_NODE_BIN to its executable.",
  );
}

module.exports = {
  MIN_NODE_MAJOR,
  isSupportedNodeVersion,
  nodeExecutableName,
  parseNodeMajor,
  pathCandidates,
  probeNode,
  resolveNodeBinary,
};
