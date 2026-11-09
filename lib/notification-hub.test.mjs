import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const hub = await jiti.import("./notification-hub.ts");
const { DEFAULT_NOTIFICATION_PREFS } = await jiti.import("./notification-events.ts");
const store = await jiti.import("./notification-store.ts");
const webpush = (await jiti.import("web-push")).default;
const { buildBriefing } = await jiti.import("./briefing.ts");
const core = await jiti.import("./fox-service-core.ts");
const { createFoxServiceEngine } = await jiti.import("./fox-service-engine.ts");

const event = { type: "completed", sessionId: "s1", sessionName: "Session" };
const prefs = (patch = {}) => ({ ...DEFAULT_NOTIFICATION_PREFS, enabled: true, ...patch });
const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: `B${"A".repeat(86)}`, auth: "A".repeat(22) } };

function reopenStore() {
  globalThis.__ompNotificationStore?.db.close();
  globalThis.__ompNotificationStore = undefined;
}
function isolatedStore(t) {
  const dir = mkdtempSync(join(tmpdir(), "omp-notify-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousSend = webpush.sendNotification;
  const previousHub = globalThis.__ompNotificationHub;
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.__ompNotificationHub = undefined;
  reopenStore();
  t.after(() => {
    webpush.sendNotification = previousSend;
    globalThis.__ompNotificationHub = previousHub;
    reopenStore();
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("push subscriptions must use real key sizes and permitted endpoints", () => {
  assert.equal(store.parsePushSubscription({ ...subscription, keys: { p256dh: "bad", auth: "x" } }), null);
  assert.equal(store.parsePushSubscription({ ...subscription, endpoint: "https://127.0.0.1/" }), null);
  assert.deepEqual(store.parsePushSubscription(subscription), subscription);
});

test("another instance sharing the agent dir sees the same keys and devices", (t) => {
  const dir = isolatedStore(t);
  store.saveDevice("phone-device", prefs({ locale: "ja" }), subscription);
  const publicKey = store.getVapidKeys(webpush.generateVAPIDKeys).publicKey;
  reopenStore();
  store.saveDevice("laptop-device", prefs());
  reopenStore();
  assert.equal(store.getVapidKeys(webpush.generateVAPIDKeys).publicKey, publicKey);
  assert.equal(store.getDevice("laptop-device").prefs.enabled, true);
  store.saveDevice("phone-device", prefs({ locale: "en" }));
  assert.ok(store.getDevice("laptop-device"));
  assert.deepEqual(store.getDevice("phone-device").subscription, subscription);
  if (process.platform !== "win32") assert.equal(statSync(join(dir, "omp-web", "notifications.db")).mode & 0o077, 0);
});

test("all real event kinds are recorded without devices or preferences", (t) => {
  isolatedStore(t);
  for (const type of ["completed", "input", "error", "modelSwitch"]) hub.publishNotification({ ...event, type });
  assert.deepEqual(new Set(store.listHistory().map((entry) => entry.event.type)), new Set(["completed", "input", "error", "modelSwitch"]));
});

test("legacy push devices never receive pushes; all streams receive signals only", (t) => {
  isolatedStore(t);
  let sends = 0;
  webpush.sendNotification = async () => { sends++; };
  store.saveDevice("phone-device", prefs(), subscription);
  const first = [], second = [];
  hub.attachNotificationClient("a", (message) => first.push(message));
  hub.attachNotificationClient("b", (message) => second.push(message));
  hub.publishNotification(event);
  assert.equal(sends, 0);
  assert.deepEqual(first, [{ kind: "signal", event }]);
  assert.deepEqual(second, first);
});

test("test events are ignored", (t) => {
  isolatedStore(t);
  const received = [];
  hub.attachNotificationClient("tab", (message) => received.push(message));
  hub.publishNotification({ type: "test", sessionId: "", sessionName: "foxnio" });
  assert.deepEqual(store.listHistory(), []);
  assert.deepEqual(received, []);
});

test("store failure and a broken stream cannot stop another stream", (t) => {
  const dir = isolatedStore(t);
  writeFileSync(join(dir, "omp-web"), "");
  t.mock.method(console, "warn", () => {});
  const received = [];
  hub.attachNotificationClient("a", () => { throw new Error("broken"); });
  hub.attachNotificationClient("b", (message) => received.push(message.kind));
  assert.doesNotThrow(() => hub.publishNotification(event));
  assert.deepEqual(received, ["signal"]);
});

test("detaching an overlapping stream keeps the other active", (t) => {
  isolatedStore(t);
  const received = [];
  const live = hub.attachNotificationClient("tab", () => received.push("live"));
  const stale = hub.attachNotificationClient("tab", () => received.push("stale"));
  stale();
  hub.publishNotification(event);
  assert.deepEqual(received, ["live"]);
  live();
  hub.publishNotification(event);
  assert.deepEqual(received, ["live"]);
});

for (const type of ["completed", "error"]) {
  test(`${type} marks input for the source and aliases read`, (t) => {
    isolatedStore(t);
    for (const sessionId of ["new", "old", "other"]) hub.publishNotification({ type: "input", sessionId, sessionName: sessionId });
    hub.publishNotification({ type, sessionId: "new", sessionName: "new", aliases: ["old"] });
    const history = store.listHistory();
    assert.equal(history.find((e) => e.id === "new:input").read, true);
    assert.equal(history.find((e) => e.id === "old:input").read, true);
    assert.equal(history.find((e) => e.id === "other:input").read, false);
    assert.equal(history.find((e) => e.id === `new:${type}`).read, false);
  });
}

test("an internal error signal reaches FOX exactly once without browser or push delivery", async (t) => {
  isolatedStore(t);
  let pushes = 0;
  webpush.sendNotification = async () => { pushes++; };
  const now = new Date(2026, 10, 8, 12).getTime();
  t.mock.timers.enable({ apis: ["Date"], now });
  const date = new Date(now).toISOString();
  const session = { id: "project-session", path: "/work/project/s.jsonl", cwd: "/work/project", projectRoot: "/work/project", projectKey: "/work/project", name: "Project", created: date, modified: date, lastMessageAt: date, messageCount: 1, firstMessage: "Task" };
  let state = core.emptyFoxServiceState();
  const wakes = [];
  const engine = createFoxServiceEngine({
    now: () => now,
    loadBriefing: async () => buildBriefing({ now, sessions: [session], notifications: store.listHistory() }),
    loadConfig: () => ({ enabled: true, quietStart: "00:00", quietEnd: "00:00", maxDailyMessages: 3 }),
    loadState: () => state,
    saveState: (next) => { state = next; },
    resolveTarget: async () => ({ sessionId: "fox" }),
    isBusy: () => false,
    wake: async (target, message) => { wakes.push({ target, message }); },
    log: () => {},
  });
  assert.equal((await engine.tick(now)).reason, "seeded");
  hub.publishNotification({ type: "error", sessionId: session.id, sessionName: session.name, detail: "isolated pipeline failure" });
  assert.equal((await engine.tick(now)).reason, "wake");
  assert.equal(wakes.length, 1);
  assert.deepEqual(wakes[0].target, { sessionId: "fox" });
  assert.match(wakes[0].message, /isolated pipeline failure/);
  assert.equal((await engine.tick(now)).reason, "no-events");
  assert.equal(wakes.length, 1);
  assert.equal(pushes, 0);
});

test("retired delivery APIs return 410 without touching the store", async (t) => {
  isolatedStore(t);
  const routes = [
    [await jiti.import("../app/api/notifications/devices/route.ts"), ["GET", "PUT"]],
    [await jiti.import("../app/api/notifications/presence/route.ts"), ["POST"]],
    [await jiti.import("../app/api/notifications/test/route.ts"), ["POST"]],
  ];
  for (const [route, methods] of routes) for (const method of methods) {
    const response = route[method]();
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), { error: "Notifications are managed by FOX.", code: "notifications_managed_by_fox" });
  }
  assert.deepEqual(store.listDevices(), []);
  assert.deepEqual(store.listHistory(), []);
});
