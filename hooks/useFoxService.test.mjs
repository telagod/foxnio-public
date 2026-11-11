import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { act, cleanup, renderHook } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { useFoxService } = await jiti.import("./useFoxService.ts");
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

test("the existing visible poll observes native failure recovery without refreshing the page", async (t) => {
  let poll;
  t.mock.method(window, "setInterval", (callback, delay) => {
    assert.equal(delay, 30_000);
    poll = callback;
    return 1;
  });
  t.mock.method(window, "clearInterval", () => {});
  let lastRunError = "Provider unavailable";
  globalThis.fetch = async () => new Response(JSON.stringify({
    config: { enabled: true, quietStart: "22:00", quietEnd: "08:00", maxDailyMessages: 3 },
    seeded: true, lastTickAt: new Date().toISOString(), lastWakeAt: null,
    pending: 0, dailyCount: 0, lastRunError,
  }), { headers: { "content-type": "application/json" } });
  const view = renderHook(() => useFoxService());
  await act(async () => {});
  assert.equal(view.result.current.health, "error");
  assert.equal(view.result.current.status.lastRunError, "Provider unavailable");
  lastRunError = null;
  await act(async () => { poll(); });
  assert.equal(view.result.current.health, "checking");
  assert.equal(view.result.current.status.lastRunError, null);
});
