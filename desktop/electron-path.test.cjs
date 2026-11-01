"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { resolveElectronBinary } = require("./electron-path.cjs");

const root = path.resolve("test-electron");

test("accepts platform-relative Electron binary paths including the macOS app bundle", () => {
  assert.equal(resolveElectronBinary(root, "electron"), path.join(root, "dist", "electron"));
  assert.equal(
    resolveElectronBinary(root, "Electron.app/Contents/MacOS/Electron"),
    path.join(root, "dist", "Electron.app", "Contents", "MacOS", "Electron"),
  );
});

test("rejects absolute paths and paths escaping Electron dist", () => {
  assert.throws(() => resolveElectronBinary(root, ""), /within Electron's dist/);
  assert.throws(() => resolveElectronBinary(root, path.resolve("outside")), /within Electron's dist/);
  assert.throws(() => resolveElectronBinary(root, "../../outside/electron"), /within Electron's dist/);
});
