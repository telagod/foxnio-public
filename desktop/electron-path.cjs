"use strict";

const path = require("node:path");

function resolveElectronBinary(electronRoot, relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error("Electron path.txt must point to a binary within Electron's dist directory.");
  }
  const dist = path.resolve(electronRoot, "dist");
  const binary = path.resolve(dist, relativePath);
  const relativeToDist = path.relative(dist, binary);
  if (relativeToDist === ".." || relativeToDist.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToDist)) {
    throw new Error("Electron path.txt must point to a binary within Electron's dist directory.");
  }
  return binary;
}

module.exports = { resolveElectronBinary };
