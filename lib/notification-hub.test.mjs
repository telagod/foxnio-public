import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const hub = await jiti.import("./notification-hub.ts");
const store = await jiti.import("./notification-history-store.ts");
const { closeStorage } = await jiti.import("./storage/client.ts");
const event = { type: "completed", sessionId: "session-one", sessionName: "Session" };
async function isolated(t) {
  await hub.drainNotificationWrites();
  await closeStorage();
  const root = mkdtempSync(join(tmpdir(), "fox-hub-data-"));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  Object.assign(process.env, { HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: join(root, "agent") });
  globalThis.__ompNotificationHub = undefined;
  t.after(async () => {
    await hub.drainNotificationWrites();
    await closeStorage();
    globalThis.__ompNotificationHub = undefined;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
}
test("durable notification signals are published only after their history commits", async (t) => {
  await isolated(t);
  const delivered = [];
  hub.attachNotificationClient("tab", (message) => delivered.push(message));
  const pending = hub.publishNotification(event);
  assert.deepEqual(delivered, []);
  await pending;
  assert.deepEqual(delivered, [{ kind: "signal", event }]);
  assert.equal((await store.listHistory())[0].event.sessionId, "session-one");
});
test("input settlement follows earlier queued inputs and leaves unrelated questions unread", async (t) => {
  await isolated(t);
  const first = hub.publishNotification({ type: "input", sessionId: "session-one", sessionName: "One" });
  const other = hub.publishNotification({ type: "input", sessionId: "session-two", sessionName: "Two" });
  const settled = hub.settleNotificationInputs(["session-one:input"]);
  await Promise.all([first, other, settled]);
  const history = await store.listHistory();
  assert.equal(history.find((item) => item.id === "session-one:input").read, true);
  assert.equal(history.find((item) => item.id === "session-two:input").read, false);
});
for (const type of ["completed", "error"]) test(`${type} commits alias input settlement atomically`, async (t) => {
  await isolated(t);
  for (const id of ["current", "previous", "unrelated"]) await hub.publishNotification({ type: "input", sessionId: id, sessionName: id });
  await hub.publishNotification({ type, sessionId: "current", aliases: ["previous"], sessionName: "Current" });
  const history = await store.listHistory();
  assert.equal(history.find((item) => item.id === "current:input").read, true);
  assert.equal(history.find((item) => item.id === "previous:input").read, true);
  assert.equal(history.find((item) => item.id === "unrelated:input").read, false);
});
test("broken streams do not suppress another stream and overlapping detach remains exact", async (t) => {
  await isolated(t);
  const values = [];
  hub.attachNotificationClient("broken", () => { throw new Error("closed"); });
  const live = hub.attachNotificationClient("tab", (message) => values.push(message));
  const stale = hub.attachNotificationClient("tab", () => { throw new Error("old"); });
  stale();
  await hub.publishNotification(event);
  assert.deepEqual(values, [{ kind: "signal", event }]);
  live();
  await hub.publishNotification(event);
  assert.equal(values.length, 1);
});
test("goal alerts require a reachable client and never settle a native human input", async (t) => {
  await isolated(t);
  await hub.publishNotification({ type: "input", sessionId: "worker-one", sessionName: "Worker" });
  const notice = { key: "goal:decision", day: "2026-11-12", kind: "input", title: "Release", detail: "Choose target" };
  assert.equal(hub.publishFoxGoalNotice("fox-session", notice), false);
  const values = [];
  const detach = hub.attachNotificationClient("tab", (message) => values.push(message));
  assert.equal(hub.publishFoxGoalNotice("fox-session", notice), true);
  assert.equal(values[0].kind, "goal-notice");
  assert.equal((await store.listHistory())[0].read, false);
  detach();
});
test("test alerts and retired device endpoints cannot recreate a legacy notification store", async (t) => {
  await isolated(t);
  await hub.publishNotification({ type: "test", sessionId: "", sessionName: "foxnio" });
  assert.deepEqual(await store.listHistory(), []);
  const devices = await jiti.import("../app/api/notifications/devices/route.ts");
  const presence = await jiti.import("../app/api/notifications/presence/route.ts");
  const tests = await jiti.import("../app/api/notifications/test/route.ts");
  assert.equal((await devices.GET()).status, 410);
  assert.equal((await devices.PUT()).status, 410);
  assert.equal((await presence.POST()).status, 410);
  assert.equal((await tests.POST()).status, 410);
});
