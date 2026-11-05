import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getPreferredToolPreset, setPreferredToolPreset } = await jiti.import("./tool-preset-preference.ts");
const { getToolNamesForPreset, getToolPresetStatus } = await jiti.import("./tool-presets.ts");

function createStorage(values = {}) {
  const entries = new Map(Object.entries(values));
  return {
    getItem(key) { return entries.get(key) ?? null; },
    setItem(key, value) { entries.set(key, value); },
  };
}

test("defaults to the full OMP toolset and persists explicit choices", () => {
  const storage = createStorage({ "omp-web:tool-preset": "unknown" });
  assert.equal(getPreferredToolPreset(storage), "full");

  setPreferredToolPreset("default", storage);
  assert.equal(getPreferredToolPreset(storage), "default");

  setPreferredToolPreset("full", storage);
  assert.equal(getPreferredToolPreset(storage), "full");
});

test("full preset leaves OMP's native toolset unrestricted", () => {
  assert.equal(getToolNamesForPreset("full"), undefined);
  assert.deepEqual(getToolNamesForPreset("default"), ["read", "bash", "edit", "write"]);
  assert.deepEqual(getToolNamesForPreset("none"), []);
});

test("reports the active preset only when the spawn arguments establish it", () => {
  assert.equal(getToolPresetStatus(["read", "bash", "edit", "write"]), "default");
  assert.equal(getToolPresetStatus(["bash", "read", "edit", "write", "grep", "find", "ls"]), "full");
  assert.equal(getToolPresetStatus(undefined, [], null), null);
  assert.equal(getToolPresetStatus(undefined, ["--no-tools"], null), "none");
  assert.equal(getToolPresetStatus(undefined, ["--tools", "read,bash,edit,write"], null), "default");
  assert.equal(getToolPresetStatus(["read", "bash"], []), "custom");
});
