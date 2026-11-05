import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import React from "react";
import { act, cleanup, render } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { SidebarResizeHandle, SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } = await jiti.import("./AppShell-layout.tsx");

// jsdom has no pointer capture; track it so the handle's capture calls are observable.
const captured = new Set();
window.HTMLElement.prototype.setPointerCapture = function setPointerCapture(id) { captured.add(id); };
window.HTMLElement.prototype.hasPointerCapture = function hasPointerCapture(id) { return captured.has(id); };
window.HTMLElement.prototype.releasePointerCapture = function releasePointerCapture(id) { captured.delete(id); };

afterEach(() => {
  cleanup();
  captured.clear();
  document.documentElement.style.removeProperty("--ui-scale");
});

function mount(width = 280) {
  const sidebar = document.createElement("nav");
  document.body.append(sidebar);
  const commits = [];
  let renders = 0;
  function Host() {
    renders += 1;
    return React.createElement(SidebarResizeHandle, {
      sidebarRef: { current: sidebar },
      width,
      onCommit: (next) => commits.push(next),
    });
  }
  const view = render(React.createElement(Host));
  return { sidebar, commits, handle: view.getByRole("separator"), renders: () => renders };
}

function fire(target, type, init = {}) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: init.x ?? 0 },
    clientY: { value: 0 },
    pointerId: { value: init.id ?? 1 },
    pointerType: { value: init.pointerType ?? "mouse" },
    isPrimary: { value: init.isPrimary ?? true },
    button: { value: init.button ?? 0 },
  });
  act(() => { target.dispatchEvent(event); });
  return event;
}

test("the separator exposes its range to assistive technology", () => {
  const { handle } = mount(300);
  assert.equal(handle.getAttribute("aria-orientation"), "vertical");
  assert.equal(handle.getAttribute("aria-valuenow"), "300");
  assert.equal(handle.getAttribute("aria-valuemin"), String(SIDEBAR_MIN_WIDTH));
  assert.equal(handle.getAttribute("aria-valuemax"), String(SIDEBAR_MAX_WIDTH));
  assert.equal(handle.getAttribute("tabindex"), "0");
});

test("dragging writes --sidebar-width straight to the sidebar and commits once on release", () => {
  const { handle, sidebar, commits, renders } = mount(280);
  const before = renders();
  const down = fire(handle, "pointerdown", { x: 400 });
  assert.equal(down.defaultPrevented, true, "no text selection starts");
  assert.equal(captured.has(1), true, "the handle captures the pointer");
  assert.equal(sidebar.hasAttribute("data-resizing"), true);
  fire(handle, "pointermove", { x: 440 });
  assert.equal(sidebar.style.getPropertyValue("--sidebar-width"), "320px");
  fire(handle, "pointermove", { x: 460 });
  assert.equal(sidebar.style.getPropertyValue("--sidebar-width"), "340px");
  assert.deepEqual(commits, [], "nothing is committed mid-drag");
  assert.equal(renders(), before, "no React render per move");
  fire(handle, "pointerup", { x: 460 });
  assert.deepEqual(commits, [340]);
  assert.equal(sidebar.hasAttribute("data-resizing"), false);
  assert.equal(captured.has(1), false);
});

test("the drag is clamped and divided by the interface scale", () => {
  document.documentElement.style.setProperty("--ui-scale", "1.25");
  const { handle, sidebar, commits } = mount(280);
  fire(handle, "pointerdown", { x: 400 });
  fire(handle, "pointermove", { x: 450 });
  assert.equal(sidebar.style.getPropertyValue("--sidebar-width"), "320px");
  fire(handle, "pointermove", { x: 5000 });
  assert.equal(sidebar.style.getPropertyValue("--sidebar-width"), `${SIDEBAR_MAX_WIDTH}px`);
  fire(handle, "pointerup", { x: 5000 });
  assert.deepEqual(commits, [SIDEBAR_MAX_WIDTH]);
});

test("a cancelled drag restores the committed width and commits nothing", () => {
  const { handle, sidebar, commits } = mount(280);
  fire(handle, "pointerdown", { x: 400 });
  fire(handle, "pointermove", { x: 480 });
  fire(handle, "pointercancel", { x: 480 });
  assert.deepEqual(commits, []);
  assert.equal(sidebar.style.getPropertyValue("--sidebar-width"), "280px");
  assert.equal(sidebar.hasAttribute("data-resizing"), false);
});

test("secondary buttons and non-primary pointers do not start a drag", () => {
  const { handle, sidebar, commits } = mount(280);
  fire(handle, "pointerdown", { x: 400, button: 2 });
  fire(handle, "pointermove", { x: 480 });
  fire(handle, "pointerdown", { x: 400, isPrimary: false, pointerType: "touch" });
  fire(handle, "pointermove", { x: 480, pointerType: "touch" });
  fire(handle, "pointerup", { x: 480 });
  assert.deepEqual(commits, []);
  assert.equal(sidebar.style.getPropertyValue("--sidebar-width"), "");
});

test("keyboard: arrows step, Home/End jump, Enter and double click reset", () => {
  const { handle, commits } = mount(300);
  const key = (name, shiftKey = false) => {
    const event = new window.KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true });
    act(() => { handle.dispatchEvent(event); });
    return event;
  };
  assert.equal(key("ArrowRight").defaultPrevented, true);
  key("ArrowLeft", true);
  key("Home");
  key("End");
  key("Enter");
  assert.deepEqual(commits, [312, 268, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_DEFAULT_WIDTH]);
  assert.equal(key("Tab").defaultPrevented, false, "unrelated keys keep their default");
  assert.equal(commits.length, 5);
  act(() => { handle.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true })); });
  assert.equal(commits.at(-1), SIDEBAR_DEFAULT_WIDTH);
});
