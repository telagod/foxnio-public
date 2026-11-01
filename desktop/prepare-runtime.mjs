import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeDir = join(root, "desktop", "runtime", "node");
const executable = process.platform === "win32" ? "node.exe" : "node";
const source = process.env.OMP_WEB_NODE_BIN || process.execPath;

const result = spawnSync(source, ["--version"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
if (result.status !== 0) {
  throw new Error(`Unable to execute the Node.js runtime at ${source}`);
}
const version = String(result.stdout).trim();
const major = Number(/^v?(\d+)/.exec(version)?.[1]);
if (!Number.isInteger(major) || major < 24) {
  throw new Error(`Desktop packaging requires Node.js >= 24; found ${version || "unknown"} at ${source}`);
}

rmSync(runtimeDir, { recursive: true, force: true });
mkdirSync(runtimeDir, { recursive: true });
const destination = join(runtimeDir, executable);
copyFileSync(source, destination);
if (process.platform !== "win32") chmodSync(destination, 0o755);
console.log(`Prepared bundled Node.js ${version} for ${process.platform}-${process.arch}: ${destination}`);
console.log("The omp executable remains an external prerequisite; set OMP_WEB_OMP_BIN when it is not on PATH.");
