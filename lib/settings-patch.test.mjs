import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { diffSettingsSections, mergeSettingsPatch } = await jiti.import("./settings-patch.ts");

test("merge applies nested keys without dropping their siblings, and does not mutate", () => {
  const base = { personality: "friendly", tools: { approvalMode: "write", approval: { bash: "prompt", extension: "allow" } }, retry: { enabled: true, maxRetries: 3 } };
  const snapshot = structuredClone(base);
  const merged = mergeSettingsPatch(base, { tools: { approval: { bash: "deny" } }, retry: { maxRetries: 5 } });
  assert.deepEqual(merged, {
    personality: "friendly",
    tools: { approvalMode: "write", approval: { bash: "deny", extension: "allow" } },
    retry: { enabled: true, maxRetries: 5 },
  });
  assert.deepEqual(base, snapshot);
});

test("merge replaces arrays and whole fallback chains instead of splicing them", () => {
  const merged = mergeSettingsPatch(
    { enabledModels: ["a", "b"], retry: { fallbackChains: { default: ["x"], plan: ["y"] } } },
    { enabledModels: ["c"], retry: { fallbackChains: { default: ["z"] } } },
  );
  assert.deepEqual(merged.enabledModels, ["c"]);
  assert.deepEqual(merged.retry.fallbackChains, { default: ["z"] });
});

test("diff lists only the keys that changed, one section level deep", () => {
  const base = { enabledModels: ["a"], registryHasScopedEntries: false, retry: { enabled: true, maxRetries: 3, fallbackChains: { default: ["x"] } } };
  const next = { enabledModels: ["a"], registryHasScopedEntries: false, retry: { enabled: true, maxRetries: 3, fallbackChains: { default: ["x", "y"] } } };
  assert.deepEqual(diffSettingsSections(base, next), { retry: { fallbackChains: { default: ["x", "y"] } } });
  assert.deepEqual(diffSettingsSections(base, base), {});
  assert.deepEqual(diffSettingsSections({ retry: { enabled: true } }, { retry: { enabled: false } }), { retry: { enabled: false } });
  assert.deepEqual(diffSettingsSections({}, { retry: { enabled: false } }), { retry: { enabled: false } });
  assert.deepEqual(diffSettingsSections({ enabledModels: ["a"] }, { enabledModels: [] }), { enabledModels: [] });
});
