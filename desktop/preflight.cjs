"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveElectronBinary } = require("./electron-path.cjs");

const root = path.resolve(__dirname, "..");
const electronRoot = path.join(root, "node_modules", "electron");
const electronPathFile = path.join(electronRoot, "path.txt");
const nextBuildId = path.join(root, ".next", "BUILD_ID");
const runtime = path.join(root, "desktop", "runtime", "node", process.platform === "win32" ? "node.exe" : "node");

function fail(message) {
  console.error(`Desktop packaging preflight failed: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(nextBuildId)) fail("Next.js production build is missing; run npm run build first.");
if (!fs.existsSync(electronPathFile)) fail("Electron binary is missing; install dependencies without skipping lifecycle scripts.");
if (!fs.existsSync(runtime)) fail("Bundled Node.js runtime is missing; run npm run desktop:prepare-runtime first.");

const relativeElectronPath = fs.readFileSync(electronPathFile, "utf8").trim();
let electronBinary;
try {
  electronBinary = resolveElectronBinary(electronRoot, relativeElectronPath);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
if (!fs.existsSync(electronBinary)) fail(`Electron binary is missing: ${electronBinary}`);

const electronArgs = process.platform === "linux" ? ["--no-sandbox", "--version"] : ["--version"];
const electronVersion = spawnSync(electronBinary, electronArgs, {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
if (electronVersion.status !== 0) {
  fail(`Electron binary failed to start: ${electronVersion.stderr || electronVersion.error?.message || `exit ${electronVersion.status}`}`);
}

const nodeVersion = spawnSync(runtime, ["--version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
const major = Number(/^v?(\d+)/.exec(nodeVersion.stdout ?? "")?.[1]);
if (nodeVersion.status !== 0 || !Number.isInteger(major) || major < 24) {
  fail(`Bundled Node.js must be >= 24 (got ${String(nodeVersion.stdout).trim() || "unknown"}).`);
}

try {
  require("sharp");
} catch (error) {
  fail(`sharp native module is not usable for this platform: ${error instanceof Error ? error.message : String(error)}`);
}

console.log(`Desktop preflight passed: Electron ${electronVersion.stdout.trim()}, Node.js ${String(nodeVersion.stdout).trim()}, ${process.platform}-${process.arch}; Next build and sharp are present.`);
