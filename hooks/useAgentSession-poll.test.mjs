import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  tryNative: false,
  alias: { "@/": fileURLToPath(new URL("../", import.meta.url)) },
});
const { AGENT_STATE_RECONCILE_MS, RECONCILE_BACKOFF_MIN_MS, reconcileDelayMs, startVisiblePoll } = await jiti.import("./useAgentSession-stream.ts");

let hidden = false;
function setHidden(value) {
  hidden = value;
  document.dispatchEvent(new window.Event("visibilitychange"));
}
Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
afterEach(() => {
  hidden = false;
});
// The DOM double lives only for this file's process; no restore needed.

test("healing polls of a quiet stream back off from 2s to the 15s cap", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 10].map((quietPolls) => reconcileDelayMs(quietPolls)),
    [RECONCILE_BACKOFF_MIN_MS, 4000, 8000, AGENT_STATE_RECONCILE_MS, AGENT_STATE_RECONCILE_MS, AGENT_STATE_RECONCILE_MS],
  );
  assert.equal(reconcileDelayMs(5000), AGENT_STATE_RECONCILE_MS, "a huge streak cannot overflow past the cap");
});

test("a visible poll runs on its interval and stops when cleaned up", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let runs = 0;
  const stop = startVisiblePoll(() => { runs += 1; }, 1000);
  t.mock.timers.tick(3500);
  assert.equal(runs, 3);
  stop();
  t.mock.timers.tick(5000);
  assert.equal(runs, 3);
});

test("a hidden tab stops the poll, and becoming visible runs it once before resuming", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let runs = 0;
  const stop = startVisiblePoll(() => { runs += 1; }, 1000);
  t.mock.timers.tick(1000);
  assert.equal(runs, 1);

  setHidden(true);
  t.mock.timers.tick(60_000);
  assert.equal(runs, 1, "nothing runs while hidden");

  setHidden(false);
  assert.equal(runs, 2, "one run as soon as the tab is visible again");
  t.mock.timers.tick(2000);
  assert.equal(runs, 4, "the interval resumes");
  stop();
});

test("a poll started in a hidden tab waits for the tab to show", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  hidden = true;
  let runs = 0;
  const stop = startVisiblePoll(() => { runs += 1; }, 1000);
  t.mock.timers.tick(10_000);
  assert.equal(runs, 0);
  setHidden(false);
  assert.equal(runs, 1);
  stop();
});

test("repeated visibility events while visible do not stack intervals", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let runs = 0;
  const stop = startVisiblePoll(() => { runs += 1; }, 1000);
  for (let i = 0; i < 5; i++) document.dispatchEvent(new window.Event("visibilitychange"));
  t.mock.timers.tick(1000);
  assert.equal(runs, 1);
  stop();
});

test("after cleanup a visibility change does nothing", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let runs = 0;
  startVisiblePoll(() => { runs += 1; }, 1000)();
  setHidden(true);
  setHidden(false);
  t.mock.timers.tick(5000);
  assert.equal(runs, 0);
});
