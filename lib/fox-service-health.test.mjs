import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { foxServiceHealth } = await jiti.import("./fox-service-health.ts");
const now = "2026-11-08T12:00:00Z";

test("service status distinguishes disabled, fresh, stale and unavailable", () => {
  const status = { config: { enabled: true }, lastTickAt: now };
  const time = Date.parse(now);
  assert.equal(foxServiceHealth(status, false, time), "checking");
  assert.equal(foxServiceHealth(status, false, time + 180_000), "stale");
  assert.equal(foxServiceHealth({ ...status, lastTickAt: null }, false, time), "starting");
  assert.equal(foxServiceHealth({ ...status, config: { enabled: false } }, false, time), "manual");
  assert.equal(foxServiceHealth(status, true, time), "unavailable");
  assert.equal(foxServiceHealth(null, false, time), "loading");
});
