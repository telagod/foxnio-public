import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function loadWorker({ windows = [], failSubscription = false } = {}) {
  const listeners = {};
  const calls = [];
  const self = {
    addEventListener: (type, listener) => { listeners[type] = listener; },
    skipWaiting: () => calls.push("skipWaiting"),
    registration: {
      pushManager: {
        getSubscription: async () => {
          calls.push("getSubscription");
          if (failSubscription) throw new Error("unavailable");
          return { unsubscribe: async () => calls.push("unsubscribe") };
        },
      },
      getNotifications: async () => [{ close: () => calls.push("closeNotification") }],
    },
    clients: {
      claim: async () => calls.push("claim"),
      matchAll: async () => windows,
      openWindow: async (url) => calls.push(["openWindow", url]),
    },
  };
  vm.runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), { self, URL });
  const dispatch = async (type, payload = {}) => {
    let done;
    listeners[type]({ ...payload, waitUntil: (promise) => { done = promise; } });
    await done;
  };
  return { listeners, calls, dispatch };
}

test("activation removes legacy subscriptions and notifications without a push handler", async () => {
  const worker = loadWorker();
  assert.equal(worker.listeners.push, undefined);
  worker.listeners.install();
  await worker.dispatch("activate");
  assert.deepEqual(worker.calls, ["skipWaiting", "getSubscription", "unsubscribe", "closeNotification", "claim"]);
});

test("activation still claims clients if legacy cleanup fails", async () => {
  const worker = loadWorker({ failSubscription: true });
  await worker.dispatch("activate");
  assert.deepEqual(worker.calls, ["getSubscription", "claim"]);
});

test("legacy notification clicks still open the exact session in an existing tab", async () => {
  const opened = [];
  const tab = {
    focused: true,
    url: "http://localhost/",
    focus: async () => opened.push("focus"),
    postMessage: (message) => opened.push(structuredClone(message)),
  };
  const worker = loadWorker({ windows: [tab] });
  await worker.dispatch("notificationclick", {
    notification: {
      data: { url: "/?session=s1", sessionId: "s1" },
      close: () => opened.push("close"),
    },
  });
  assert.deepEqual(opened, ["close", "focus", { type: "omp-open-session", sessionId: "s1" }]);
});
