import "../tests/setup-dom.mjs";
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { cleanup, renderHook } from "@testing-library/react/pure.js";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { useMobileSidebarGestures, hasBlockingOverlay } = await jiti.import("./useMobileSidebarGestures.ts");

const DRAWER_WIDTH = 300;
let drawer;
let backdrop;
let leftStrip;
let rightStrip;
let rightPanel;
let calls;
let clock;

beforeEach(() => {
  clock = 1000;
  calls = { left: [], right: [], prepare: 0 };
  document.body.replaceChildren();
  drawer = document.createElement("nav");
  drawer.id = "workspace-sidebar";
  drawer.setAttribute("role", "dialog");
  drawer.getBoundingClientRect = () => ({ width: DRAWER_WIDTH, height: 800, x: 0, y: 0, top: 0, left: 0, right: DRAWER_WIDTH, bottom: 800 });
  backdrop = document.createElement("div");
  backdrop.setAttribute("data-drawer-backdrop", "left");
  leftStrip = document.createElement("div");
  leftStrip.setAttribute("data-drawer-edge", "left");
  rightStrip = document.createElement("div");
  rightStrip.setAttribute("data-drawer-edge", "right");
  rightPanel = document.createElement("aside");
  rightPanel.id = "workspace-file-panel";
  rightPanel.getBoundingClientRect = () => ({ width: 390, height: 800, x: 0, y: 0, top: 0, left: 0, right: 390, bottom: 800 });
  document.body.append(drawer, backdrop, leftStrip, rightStrip, rightPanel);
});
afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

function mount(props = {}) {
  const options = {
    enabled: true,
    leftOpen: false,
    rightOpen: false,
    onLeftOpenChange: (open) => calls.left.push(open),
    onRightOpenChange: (open) => calls.right.push(open),
    onRightPrepare: () => { calls.prepare += 1; },
    ...props,
  };
  // AppShell marks a closed drawer aria-hidden, which is how the hook tells it from a modal.
  if (options.leftOpen) drawer.removeAttribute("aria-hidden");
  else drawer.setAttribute("aria-hidden", "true");
  return renderHook((hookProps) => useMobileSidebarGestures(hookProps), { initialProps: options });
}

function pointer(type, target, x, y, { id = 1, pointerType = "touch", isPrimary = true } = {}) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    clientX: { value: x },
    clientY: { value: y },
    pointerId: { value: id },
    pointerType: { value: pointerType },
    isPrimary: { value: isPrimary },
    timeStamp: { value: clock },
  });
  target.dispatchEvent(event);
  return event;
}

/** Moves in equal steps; `stepMs` sets the speed (the release velocity comes from the timestamps). */
function drag(target, from, to, { y = 400, endY = y, steps = 10, stepMs = 16, release = true, ...rest } = {}) {
  pointer("pointerdown", target, from, y, rest);
  for (let step = 1; step <= steps; step++) {
    clock += stepMs;
    pointer("pointermove", target, from + ((to - from) * step) / steps, y + ((endY - y) * step) / steps, rest);
  }
  if (release) {
    clock += stepMs;
    pointer("pointerup", target, to, endY, rest);
  }
}
const nextFrame = () => new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
const progress = (element) => element.style.getPropertyValue("--drawer-progress");

test("a drag from the left edge strip tracks the finger, then opens the drawer on a long pull", async () => {
  mount();
  drag(leftStrip, 4, 200, { release: false });
  await nextFrame();
  assert.equal(drawer.hasAttribute("data-dragging"), true);
  assert.equal(backdrop.hasAttribute("data-dragging"), true);
  // 196 px of a 300 px drawer, minus the 8 px recognition slop is not subtracted: the whole travel counts.
  assert.ok(Math.abs(Number(progress(drawer)) - 196 / DRAWER_WIDTH) < 0.001, progress(drawer));
  assert.equal(progress(backdrop), progress(drawer));
  assert.deepEqual(calls.left, []);
  pointer("pointerup", leftStrip, 200, 400);
  assert.deepEqual(calls.left, [true]);
  assert.equal(drawer.hasAttribute("data-dragging"), false);
  assert.equal(progress(drawer), "1", "the released position is kept while the transition runs");
});

test("the inline progress is dropped once the settle animation has had time to finish", async () => {
  mount();
  drag(leftStrip, 4, 250);
  assert.equal(progress(drawer), "1");
  await new Promise((resolve) => setTimeout(resolve, 520));
  assert.equal(progress(drawer), "");
  assert.equal(progress(backdrop), "");
});

test("a short slow drag snaps back; a short fast flick still opens", () => {
  mount();
  drag(leftStrip, 4, 90, { stepMs: 80 });
  assert.deepEqual(calls.left, []);
  assert.equal(progress(drawer), "0");
  clock += 1000;
  drag(leftStrip, 4, 90, { stepMs: 8 });
  assert.deepEqual(calls.left, [true]);
});

test("vertical travel from the edge strip is a scroll: nothing opens and nothing is painted", async () => {
  mount();
  drag(leftStrip, 4, 30, { y: 300, endY: 520 });
  await nextFrame();
  assert.deepEqual(calls.left, []);
  assert.equal(drawer.hasAttribute("data-dragging"), false);
  assert.equal(progress(drawer), "");
});

test("a leftward drag on the drawer or its backdrop closes an open drawer", () => {
  mount({ leftOpen: true });
  drag(drawer, 280, 40, { stepMs: 40 });
  assert.deepEqual(calls.left, [false]);
  clock += 1000;
  drag(backdrop, 340, 100, { stepMs: 40 });
  assert.deepEqual(calls.left, [false, false]);
});

test("a small leftward push on an open drawer springs back", () => {
  mount({ leftOpen: true });
  drag(drawer, 250, 200, { stepMs: 80 });
  assert.deepEqual(calls.left, []);
  assert.equal(progress(drawer), "1");
});

test("pulling an open drawer back past fully open rubber-bands instead of following 1:1", async () => {
  mount({ leftOpen: true });
  pointer("pointerdown", drawer, 100, 400);
  clock += 16;
  pointer("pointermove", drawer, 70, 400);
  clock += 16;
  pointer("pointermove", drawer, 260, 400);
  await nextFrame();
  const value = Number(progress(drawer));
  assert.ok(value > 1 && value < 1 + 24 / DRAWER_WIDTH, `fraction ${value}`);
  clock += 16;
  pointer("pointerup", drawer, 260, 400);
  assert.deepEqual(calls.left, [], "it stays open");
});

test("the right edge strip opens the right panel and asks for it to be mounted", async () => {
  mount();
  drag(rightStrip, 386, 100, { release: false });
  await nextFrame();
  assert.equal(calls.prepare, 1);
  assert.ok(Math.abs(Number(progress(rightPanel)) - 286 / 390) < 0.001, progress(rightPanel));
  pointer("pointerup", rightStrip, 100, 400);
  assert.deepEqual(calls.right, [true]);
  assert.deepEqual(calls.left, []);
});

test("a rightward drag on the open file panel closes it", () => {
  mount({ rightOpen: true });
  drag(rightPanel, 30, 330, { stepMs: 30 });
  assert.deepEqual(calls.right, [false]);
});

test("form fields, text selection and other dialogs veto a drag", () => {
  mount({ leftOpen: true });
  const input = document.createElement("input");
  drawer.append(input);
  drag(input, 280, 40);
  assert.deepEqual(calls.left, [], "typing target");

  const paragraph = document.createElement("p");
  paragraph.textContent = "selected text";
  drawer.append(paragraph);
  const range = document.createRange();
  range.selectNodeContents(paragraph);
  window.getSelection().addRange(range);
  drag(drawer, 280, 40);
  assert.deepEqual(calls.left, [], "text selected");
  window.getSelection().removeAllRanges();

  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  document.body.append(menu);
  drag(drawer, 280, 40);
  assert.deepEqual(calls.left, [], "menu open");
  menu.style.display = "none";
  drag(drawer, 280, 40);
  assert.deepEqual(calls.left, [false], "hidden menu does not block");
});

test("a dialog blocks opening from the edge, but the drawer's own dialog role does not", () => {
  mount();
  const sheet = document.createElement("div");
  sheet.setAttribute("role", "dialog");
  document.body.append(sheet);
  drag(leftStrip, 4, 250);
  assert.deepEqual(calls.left, []);
  sheet.remove();
  assert.equal(hasBlockingOverlay("workspace-sidebar"), false, "the drawer itself is role=dialog");
  drag(leftStrip, 4, 250);
  assert.deepEqual(calls.left, [true]);
});

test("horizontally scrollable content inside the open panel keeps its own pan", () => {
  mount({ rightOpen: true });
  const scroller = document.createElement("div");
  scroller.style.overflowX = "auto";
  Object.defineProperties(scroller, { scrollWidth: { value: 900 }, clientWidth: { value: 300 } });
  rightPanel.append(scroller);
  drag(scroller, 30, 330);
  assert.deepEqual(calls.right, []);
});

test("mouse input and secondary touches are ignored", () => {
  mount();
  drag(leftStrip, 4, 250, { pointerType: "mouse" });
  drag(leftStrip, 4, 250, { isPrimary: false });
  assert.deepEqual(calls.left, []);
});

test("a tap on an edge strip is forwarded to the control underneath", () => {
  mount();
  const button = document.createElement("button");
  document.body.append(button);
  let clicks = 0;
  button.addEventListener("click", () => { clicks += 1; });
  document.elementFromPoint = () => button;
  drag(leftStrip, 6, 6, { steps: 1, stepMs: 40 });
  assert.equal(clicks, 1);
  assert.equal(document.activeElement, button);
  clicks = 0;
  drag(leftStrip, 6, 6, { steps: 1, stepMs: 900 });
  assert.equal(clicks, 0, "a long press is not a tap");
  delete document.elementFromPoint;
});

test("changing the callbacks or open state does not re-subscribe the window listeners", () => {
  const added = [];
  const removed = [];
  const addEventListener = window.addEventListener.bind(window);
  const removeEventListener = window.removeEventListener.bind(window);
  window.addEventListener = (type, ...rest) => { added.push(type); return addEventListener(type, ...rest); };
  window.removeEventListener = (type, ...rest) => { removed.push(type); return removeEventListener(type, ...rest); };
  try {
    const hook = mount();
    assert.deepEqual(added, ["pointerdown"]);
    hook.rerender({ enabled: true, leftOpen: true, rightOpen: false, onLeftOpenChange: () => {}, onRightOpenChange: () => {} });
    hook.rerender({ enabled: true, leftOpen: false, rightOpen: true, onLeftOpenChange: () => {}, onRightOpenChange: () => {} });
    assert.deepEqual(added, ["pointerdown"]);
    assert.deepEqual(removed, []);
    hook.unmount();
    assert.deepEqual(removed.filter((type) => type === "pointerdown"), ["pointerdown"]);
    assert.deepEqual(added, ["pointerdown"], "nothing new is attached while idle");
  } finally {
    window.addEventListener = addEventListener;
    window.removeEventListener = removeEventListener;
  }
});

test("the latest callbacks receive the result even if they changed during the drag", () => {
  const hook = mount();
  pointer("pointerdown", leftStrip, 4, 400);
  clock += 16;
  pointer("pointermove", leftStrip, 120, 400);
  const late = [];
  hook.rerender({ enabled: true, leftOpen: false, rightOpen: false, onLeftOpenChange: (open) => late.push(open), onRightOpenChange: () => {} });
  clock += 16;
  pointer("pointermove", leftStrip, 250, 400);
  pointer("pointerup", leftStrip, 250, 400);
  assert.deepEqual(late, [true]);
  assert.deepEqual(calls.left, []);
});

test("disabling the hook mid-drag removes the drag styling without changing state", async () => {
  const hook = mount();
  drag(leftStrip, 4, 200, { release: false });
  await nextFrame();
  assert.equal(drawer.hasAttribute("data-dragging"), true);
  hook.rerender({ enabled: false, leftOpen: false, rightOpen: false, onLeftOpenChange: (open) => calls.left.push(open), onRightOpenChange: () => {} });
  assert.equal(drawer.hasAttribute("data-dragging"), false);
  assert.equal(progress(drawer), "");
  pointer("pointerup", leftStrip, 200, 400);
  assert.deepEqual(calls.left, []);
});
