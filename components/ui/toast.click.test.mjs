import "../../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, before } from "node:test";
import React from "react";
import { act, cleanup, render, renderHook } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tryNative: false, tsconfigPaths: true });
// Same specifiers as the hook's own imports: on Windows a relative path
// can load a second toast module, whose manager the rendered provider never sees.
const { ClampedDescription, ToastProvider, toast } = await jiti.import("@/components/ui/toast");
const { useSessionSignals } = await jiti.import("@/hooks/useSessionSignals");
const { notificationHistory } = await jiti.import("@/lib/notification-history");
const { OPEN_SESSION_EVENT } = await jiti.import("@/lib/notification-client");
const durableSnapshot = {
  token: "toast-reader", cursor: { generation: "toast-generation", revision: 1 }, next: false,
  complete: true, staleSources: [], warnings: [],
  data: { sessions: [], projects: [], pins: [], notifications: [], foxPointer: { sessionId: null, resetAt: null, revokedSessionId: null }, foxObservation: {}, foxWorkspace: "/fox" },
};

/** The tab side of the shared event-stream worker (lib/event-stream.ts), so a
 * test can deliver frames on the notifications channel the hook opened. */
const eventStreams = new Map();
const eventWorker = {
  onmessage: null,
  onerror: null,
  postMessage(message) {
    if (message.op === "open") eventStreams.set(message.id, message.channel);
    else if (message.op === "close") eventStreams.delete(message.id);
  },
};
function deliverNotification(message) {
  const id = [...eventStreams].findLast(([, channel]) => channel.kind === "notifications")?.[0];
  assert.ok(id, "useSessionSignals must hold a notifications channel");
  eventWorker.onmessage({ data: { id, type: "message", data: JSON.stringify({ type: "notification", ...message }) } });
}

before(() => {
  globalThis.AbortController = window.AbortController;
  window.Element.prototype.setPointerCapture = () => {};
  globalThis.fetch = async (url, init) => ({ ok: true, status: 200, json: async () => init?.method === "DELETE" ? { ok: true } : String(url).includes("/api/data/snapshot") ? durableSnapshot : {} });
  // `new Worker()` yields the one shared fake (a constructor may return an object).
  globalThis.Worker = function Worker() { return eventWorker; };
});
afterEach(() => { act(() => toast.close()); cleanup(); window.getSelection()?.removeAllRanges(); });

function pointer(target, type, x, y, { detail = 1 } = {}) {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, detail });
  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: "mouse" } });
  act(() => { target.dispatchEvent(event); });
}
function show(description, options = {}) {
  const opened = [];
  render(React.createElement(ToastProvider, null));
  act(() => { toast.info("Agent finished", description, { onClick: () => opened.push(1), ...options }); });
  return { opened, card: () => document.querySelector(".toast-card") };
}

test("clicking anywhere on a toast card runs its action and closes it", () => {
  const { opened, card } = show("Body");
  assert.equal(card().style.cursor, "pointer");
  const title = card().querySelector(".display-serif");
  pointer(title, "pointerdown", 100, 50);
  pointer(title, "click", 102, 51);
  assert.equal(opened.length, 1);
  assert.equal(card()?.hasAttribute("data-ending-style") ?? true, true);
});

test("Enter on the focused card runs its action; Enter inside it does not", () => {
  const { opened, card } = show(React.createElement("button", { type: "button" }, "inner"));
  const press = (target) => act(() => { target.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  press(card().querySelector("button:not(.toast-close-button)"));
  assert.equal(opened.length, 0);
  press(card());
  assert.equal(opened.length, 1);
});

test("buttons, links, expandable text, drags and text selection do not trigger the card action", () => {
  let pressed = 0;
  const { opened, card } = show(React.createElement("span", null,
    React.createElement("button", { type: "button", onClick: () => { pressed += 1; } }, "Open"),
    React.createElement("a", { href: "#x" }, "link"),
    React.createElement(ClampedDescription, null, "long text")));
  act(() => card().querySelector("button:not(.toast-close-button)").click());
  assert.equal(pressed, 1);
  act(() => card().querySelector("a").click());
  // A press on the clamped text whose click is retargeted to the card, as pointer capture does.
  pointer(card().querySelector("[aria-expanded]"), "pointerdown", 100, 50);
  pointer(card(), "click", 100, 50);
  // A drag that fell short of a swipe.
  const title = card().querySelector(".display-serif");
  pointer(title, "pointerdown", 100, 50);
  pointer(title, "click", 130, 50);
  // A drag pulled back to where it started.
  pointer(title, "pointerdown", 100, 50);
  pointer(title, "pointermove", 160, 50);
  pointer(title, "click", 101, 50);
  window.getSelection().selectAllChildren(title);
  act(() => title.click());
  assert.equal(opened.length, 0);
  assert.equal(card()?.hasAttribute("data-ending-style") ?? false, false);
});

test("a toast without an action keeps the default cursor", () => {
  render(React.createElement(ToastProvider, null));
  act(() => { toast.info("Saved"); });
  assert.equal(document.querySelector(".toast-card").style.cursor, "");
});

test("live signals cannot invent database history or alerts; legacy alert frames are ignored", async () => {
  let calls = 0;
  const requests = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return { ok: true, status: 200, json: async () => durableSnapshot };
  };
  globalThis.Notification = window.Notification = class { static requestPermission() { calls++; throw new Error("permission"); } constructor() { calls++; throw new Error("alert"); } };
  try {
    render(React.createElement(ToastProvider, null));
    const view = renderHook(() => useSessionSignals({ sessionId: null, onOpenSession: () => {} }));
    await act(async () => { await Promise.resolve(); });
    act(() => {
      deliverNotification({ kind: "toast", event: { type: "error", sessionId: "toast", sessionName: "Toast" } });
      deliverNotification({ kind: "os", event: { type: "error", sessionId: "os", sessionName: "OS" } });
      deliverNotification({ kind: "signal", event: { type: "error", sessionId: "s9", sessionName: "Signal", detail: "boom" } });
    });
    assert.deepEqual(notificationHistory.get(), []);
    assert.equal([...document.querySelectorAll(".toast-card")].some((card) => ["Signal", "Toast", "OS"].includes(card.querySelector(".display-serif")?.textContent)), false);
    assert.equal(calls, 0);
    assert.ok(requests.every((url) => !url.startsWith("/api/notifications/history")));
    view.unmount();
    assert.equal([...eventStreams.values()].filter((c) => c.kind === "notifications").length, 0);
  } finally {
    globalThis.fetch = previousFetch;
    delete window.Notification;
    delete globalThis.Notification;
  }
});

test("session open events and legacy worker clicks navigate and detach on cleanup", async () => {
  const worker = new window.EventTarget();
  worker.getRegistration = async () => undefined;
  Object.defineProperty(window.navigator, "serviceWorker", { configurable: true, value: worker });
  const opened = [];
  try {
    const view = renderHook(() => useSessionSignals({ sessionId: null, onOpenSession: (id) => opened.push(id) }));
    await act(async () => { await Promise.resolve(); });
    act(() => {
      window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: "report-worker" }));
      worker.dispatchEvent(new window.MessageEvent("message", { data: { type: "omp-open-session", sessionId: "legacy-worker" } }));
      worker.dispatchEvent(new window.MessageEvent("message", { data: { type: "omp-open-session", sessionId: "" } }));
    });
    assert.deepEqual(opened, ["report-worker", "legacy-worker"]);
    view.unmount();
    act(() => window.dispatchEvent(new CustomEvent(OPEN_SESSION_EVENT, { detail: "after" })));
    assert.deepEqual(opened, ["report-worker", "legacy-worker"]);
  } finally {
    delete window.navigator.serviceWorker;
  }
});

test("legacy service worker cleanup leaves unrelated registrations alone", async () => {
  const worker = new window.EventTarget();
  const calls = [];
  const registration = {
    active: { scriptURL: "http://localhost/sw.js" },
    update: async () => calls.push("update"),
    pushManager: { getSubscription: async () => ({ unsubscribe: async () => calls.push("unsubscribe") }) },
    getNotifications: async () => [{ close: () => calls.push("close") }],
  };
  worker.getRegistration = async () => registration;
  Object.defineProperty(window.navigator, "serviceWorker", { configurable: true, value: worker });
  try {
    const first = renderHook(() => useSessionSignals({ sessionId: null, onOpenSession: () => {} }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.deepEqual(calls, ["update", "unsubscribe", "close"]);
    first.unmount();
    calls.length = 0;
    registration.active.scriptURL = "http://localhost/unrelated-sw.js";
    renderHook(() => useSessionSignals({ sessionId: null, onOpenSession: () => {} }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.deepEqual(calls, []);
  } finally {
    delete window.navigator.serviceWorker;
  }
});
